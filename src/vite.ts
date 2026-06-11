import type { AddressInfo } from "node:net";

import type { HttpServer, Logger, Plugin } from "vite";

import {
  type CaptunTunnel,
  createCaptunTunnel,
  type CreateCaptunTunnelOptions,
  type TunnelReady,
} from "./index.js";

/**
 * Options for the {@link captun} Vite plugin.
 *
 * Every `createCaptunTunnel` option except `fetch` (which the plugin wires to
 * the Vite server) is passed through verbatim — see
 * {@link CreateCaptunTunnelOptions} for `gateway`, `name`, and `token`.
 */
export type CaptunVitePluginOptions = Omit<CreateCaptunTunnelOptions, "fetch"> & {
  /**
   * Called once the tunnel is connected, with the public `url` and the
   * reusable connect `token` when the gateway provides or accepts one.
   * Defaults to printing the public URL with Vite's logger.
   */
  onTunnel?: (tunnel: TunnelReady) => void;
  /**
   * Called when creating the tunnel fails. Defaults to logging the error with
   * Vite's logger and leaving the server running; rethrow from here to make
   * the failure fatal instead.
   */
  onError?: (error: unknown) => void;
};

/**
 * Serve a Vite dev or preview server through a public Captun tunnel URL.
 *
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import captun from "captun/vite";
 *
 * export default defineConfig({
 *   plugins: [captun()],
 * });
 * ```
 *
 * Once the server is listening, the plugin opens a tunnel with
 * `createCaptunTunnel`, prints the public URL, and forwards every public
 * request to the local server. Closing the server closes the tunnel. To only
 * tunnel on demand, make the plugin conditional in your Vite config:
 * `plugins: [process.env.TUNNEL ? captun() : undefined]`.
 *
 * WebSockets are not forwarded, so Vite HMR only works on the local URL —
 * the tunnel is for plain HTTP: webhooks, previews, and e2e tests.
 */
export default function captun(options: CaptunVitePluginOptions = {}): Plugin {
  const { onTunnel, onError, ...tunnelOptions } = options;

  const openTunnel = async (httpServer: HttpServer, logger: Logger, protocol: "http" | "https") => {
    // The catch only covers creating the tunnel — an error thrown by the
    // user's own onTunnel callback should not be reported as a tunnel failure.
    let tunnel: CaptunTunnel;
    try {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Captun requires the Vite server to listen on a TCP port");
      }
      tunnel = await createCaptunTunnel({
        ...tunnelOptions,
        fetch: forwardToLocalServer(localOrigin(protocol, address)),
      });
    } catch (error) {
      if (onError) onError(error);
      else {
        logger.error(
          `Captun tunnel failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (!httpServer.listening) {
      // The server closed while the tunnel was connecting; "close" already
      // fired, so dispose here instead.
      tunnel[Symbol.dispose]();
      return;
    }
    httpServer.once("close", () => tunnel[Symbol.dispose]());
    if (onTunnel) onTunnel({ url: tunnel.url, token: tunnel.token });
    else logger.info(`  ➜  Captun:  ${tunnel.url}`);
  };

  const tunnelWhenListening = (
    httpServer: HttpServer | null,
    logger: Logger,
    protocol: "http" | "https",
  ) => {
    if (!httpServer) return;
    if (httpServer.listening) void openTunnel(httpServer, logger, protocol);
    else httpServer.once("listening", () => void openTunnel(httpServer, logger, protocol));
  };

  return {
    name: "captun",
    apply: "serve",
    configureServer(server) {
      tunnelWhenListening(
        server.httpServer,
        server.config.logger,
        server.config.server.https ? "https" : "http",
      );
    },
    configurePreviewServer(server) {
      tunnelWhenListening(
        server.httpServer,
        server.config.logger,
        server.config.preview.https ? "https" : "http",
      );
    },
  };
}

function localOrigin(protocol: "http" | "https", address: AddressInfo) {
  // Wildcard listeners need a loopback address of the same family.
  if (address.address === "::") return `${protocol}://[::1]:${address.port}`;
  if (address.address === "0.0.0.0") return `${protocol}://127.0.0.1:${address.port}`;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `${protocol}://${host}:${address.port}`;
}

function forwardToLocalServer(origin: string) {
  return (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // Node's fetch already refuses to forward the public host (a forbidden
    // header), but make it explicit: the local hop must use its own Host so
    // Vite's allowed-hosts check doesn't reject tunnel traffic.
    headers.delete("host");
    // Without this the local server may compress; Node's fetch would then
    // decompress the body but keep the content-encoding header, corrupting
    // the response on its way back through the tunnel.
    headers.delete("accept-encoding");
    // Node's fetch enforces a forwarded content-length against the body it
    // actually streams; let it derive the framing from the body instead.
    headers.delete("content-length");
    headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
    headers.set("x-forwarded-host", url.host);
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      // Redirects belong to the public client, not the local hop.
      redirect: "manual",
    };
    if (request.body) {
      init.body = request.body;
      // Node's fetch requires this for streaming request bodies.
      init.duplex = "half";
    }
    return fetch(new URL(url.pathname + url.search, origin), init);
  };
}
