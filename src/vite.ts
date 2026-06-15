import type { AddressInfo } from "node:net";

import type { HttpServer, Logger, Plugin } from "vite";

import {
  type CaptunTunnel,
  createCaptunTunnel,
  type CreateCaptunTunnelOptions,
  type WebSocketConnectResult,
  type WebSocketHandle,
  webSocketHandleFromSocket,
  isWebSocketUpgradeRequest,
  pipeWebSocketToHandle,
  type TunnelReady,
} from "./index.js";
import { captunHealthResponse, isCaptunHealthRequest } from "./tunnel-health.js";

/**
 * Options for the {@link captun} Vite plugin.
 *
 * Every `createCaptunTunnel` option except `fetch` and `connectWebSocket`
 * (which the plugin wires to the Vite server) is passed through verbatim — see
 * {@link CreateCaptunTunnelOptions} for `gateway`, `name`, and `token`.
 */
export type CaptunVitePluginOptions = Omit<
  CreateCaptunTunnelOptions,
  "fetch" | "connectWebSocket"
> & {
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
 * HTTP and WebSockets are both forwarded, so Vite HMR can connect through the
 * tunnel URL.
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
        connectWebSocket: connectLocalWebSocket(localOrigin(protocol, address)),
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
  return (request: Request): Response | Promise<Response> => {
    if (isWebSocketUpgradeRequest(request)) {
      return new Response("Use connectWebSocket for WebSocket tunnel requests\n", {
        status: 400,
      });
    }

    // The reserved health path is answered by every Tunnel Client itself.
    if (isCaptunHealthRequest(request)) return captunHealthResponse();
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

function connectLocalWebSocket(origin: string) {
  return async (request: Request, remote: WebSocketHandle): Promise<WebSocketConnectResult> => {
    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search, origin);
    targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
    const targetSocket = new WebSocket(targetUrl, {
      protocols: request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((protocol) => protocol.trim())
        .filter(Boolean),
      headers: forwardedHandshakeHeaders(request.headers),
      // Node's WebSocket (undici) accepts { protocols, headers }; the DOM type doesn't.
    } as unknown as string[]);

    try {
      await waitForWebSocketOpen(targetSocket);
      if (targetSocket.readyState !== WebSocket.OPEN)
        throw new Error("WebSocket closed after open");
    } catch {
      targetSocket.close();
      return {
        accepted: false,
        response: new Response(
          `Request reached the captun Vite plugin, but ${targetUrl.origin} did not accept the WebSocket\n`,
          { status: 502 },
        ),
      };
    }

    pipeWebSocketToHandle(targetSocket, remote);
    return {
      accepted: true,
      protocol: targetSocket.protocol || undefined,
      socket: webSocketHandleFromSocket(targetSocket),
    };
  };
}

function forwardedHandshakeHeaders(headers: Headers) {
  const skip = new Set(["connection", "host", "keep-alive", "te", "trailer", "upgrade"]);
  const forwarded: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (skip.has(name) || name.startsWith("sec-websocket-") || name.startsWith("proxy-")) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

async function waitForWebSocketOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) throw new Error("WebSocket closed before open");

  const listeners = new AbortController();
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const settle = (callback: () => void) => {
      listeners.abort();
      callback();
    };
    socket.addEventListener("open", () => settle(resolveOpen), { signal: listeners.signal });
    socket.addEventListener("error", () => settle(() => rejectOpen(new Error("WebSocket error"))), {
      signal: listeners.signal,
    });
    socket.addEventListener(
      "close",
      () => settle(() => rejectOpen(new Error("WebSocket closed before open"))),
      { signal: listeners.signal },
    );
  });
}
