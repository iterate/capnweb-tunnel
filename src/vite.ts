import type { AddressInfo } from "node:net";

import type { HttpServer, Logger, Plugin } from "vite";

import { createCaptunTunnel, type TunnelReady } from "./index.js";

/**
 * Options for the {@link captun} Vite plugin.
 *
 * The tunnel options (`gateway`, `name`, `token`) are passed through to
 * `createCaptunTunnel` verbatim — the plugin only supplies the `fetch`
 * implementation, which forwards public requests to the local Vite server.
 */
export type CaptunVitePluginOptions = {
  /**
   * Tunnel Gateway URL. Defaults to the hosted `https://captun.sh` service.
   * After `npx captun deploy`, pass your own gateway URL here (for example
   * from an environment variable: `gateway: process.env.CAPTUN_GATEWAY`).
   */
  gateway?: string | URL;
  /**
   * Tunnel Name — the public routing key in the tunnel URL. A random name is
   * generated when omitted.
   */
  name?: string;
  /**
   * Connect Token sent with the Gateway Connect Request: a Gateway Secret for
   * self-hosted deployments, or an Ownership Token to reclaim a named tunnel
   * on the hosted service. Random when omitted.
   */
  token?: string;
  /**
   * Whether to create a tunnel at all. Defaults to `true`. Lets the plugin
   * stay configured while only tunneling on demand:
   * `captun({ enabled: Boolean(process.env.TUNNEL) })`.
   */
  enabled?: boolean;
  /**
   * Called once the tunnel is connected, with the public `url` and the
   * reusable connect `token` when the gateway provides or accepts one.
   */
  onTunnel?: (tunnel: TunnelReady) => void;
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
 * request to the local server. Closing the server closes the tunnel.
 *
 * WebSockets are not forwarded, so Vite HMR only works on the local URL —
 * the tunnel is for plain HTTP: webhooks, previews, and e2e tests.
 */
export default function captun(options: CaptunVitePluginOptions = {}): Plugin {
  const { enabled = true, onTunnel, ...tunnelOptions } = options;

  const openTunnel = async (httpServer: HttpServer, logger: Logger, protocol: "http" | "https") => {
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Captun requires the Vite server to listen on a TCP port");
    }
    const tunnel = await createCaptunTunnel({
      ...tunnelOptions,
      fetch: forwardToLocalServer(localOrigin(protocol, address)),
    });
    if (!httpServer.listening) {
      // The server closed while the tunnel was connecting; "close" already
      // fired, so dispose here instead.
      tunnel[Symbol.dispose]();
      return;
    }
    httpServer.once("close", () => tunnel[Symbol.dispose]());
    logger.info(`  ➜  Captun:  ${tunnel.url}`);
    onTunnel?.({ url: tunnel.url, token: tunnel.token });
  };

  const tunnelWhenListening = (
    httpServer: HttpServer | null,
    logger: Logger,
    protocol: "http" | "https",
  ) => {
    if (!enabled || !httpServer) return;
    const open = () => {
      openTunnel(httpServer, logger, protocol).catch((error: unknown) => {
        logger.error(
          `  ➜  Captun tunnel failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
    if (httpServer.listening) open();
    else httpServer.once("listening", open);
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
  const host =
    address.address === "::" || address.address === "0.0.0.0"
      ? "localhost"
      : address.family === "IPv6"
        ? `[${address.address}]`
        : address.address;
  return `${protocol}://${host}:${address.port}`;
}

function forwardToLocalServer(origin: string) {
  return (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // Without this the local server may compress; Node's fetch would then
    // decompress the body but keep the content-encoding header, corrupting
    // the response on its way back through the tunnel.
    headers.delete("accept-encoding");
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
