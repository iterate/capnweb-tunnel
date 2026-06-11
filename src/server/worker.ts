import { DurableObject } from "cloudflare:workers";
import {
  acceptFetcherCapability,
  connectTokenFromRequest,
  decodeWebSocketFrames,
  encodeWebSocketFrame,
  GATEWAY_CONNECT_QUERY_PARAM,
  sendWebSocketMessage,
  TUNNEL_CONNECT_DIAGNOSTIC_HEADER,
  TUNNEL_NAME_QUERY_PARAM,
  webSocketFrameFromMessage,
  type FetcherStub,
} from "../index.js";
import {
  captunShardName,
  getTunnelNameFromUrl,
  getTunnelUrl,
  isValidTunnelName,
  TUNNEL_URL_HEADER,
} from "./tunnel-addressing.js";

export type CaptunEnv = {
  CaptunServerShard: DurableObjectNamespace<CaptunServerShard<CaptunEnv>>;
  CAPTUN_TOKEN?: string;
  CAPTUN_SECRET?: string;
  SHARD_COUNT?: string;
  CUSTOM_HOSTNAME?: string;
};

/** Set by the top-level Worker on the WebSocket-upgrade request so the DO knows the tunnel. */
const TUNNEL_NAME_HEADER = "x-captun-tunnel-name";
const CUSTOM_HOSTNAME_RESERVED_TUNNEL_NAMES = ["captun", "gateway"];

type WorkerWebSocket = WebSocket & {
  accept(): void;
};

type WorkerWebSocketPairConstructor = new () => {
  0: WorkerWebSocket;
  1: WorkerWebSocket;
};

type WebSocketResponseInit = ResponseInit & {
  webSocket: WebSocket;
};

type CaptunShardBindingEnv<Env extends { CAPTUN_TOKEN?: string }> = {
  CaptunServerShard: DurableObjectNamespace<CaptunServerShard<Env>>;
  SHARD_COUNT?: string;
};

type ActiveTunnel = {
  url: string;
  token?: string;
  fetcher: FetcherStub;
};

export type TunnelAdmission =
  | { ok: true; token: string | undefined }
  | { ok: false; response: Response };

export type TunnelAdmissionInput<Env> = {
  request: Request;
  env: Env;
  activeToken: string | undefined;
};

/**
 * A shard Durable Object owns many named tunnels.
 *
 * `SHARD_COUNT=1` keeps every tunnel in one warm object, which gives the
 * lowest connection latency. Raising `SHARD_COUNT` spreads tunnel names over
 * more objects, which adds cold starts when new shards wake up but gives better
 * aggregate throughput for lots of concurrent large responses.
 */
export class CaptunServerShard<
  Env extends { CAPTUN_TOKEN?: string } = CaptunEnv,
> extends DurableObject<Env> {
  private tunnels = new Map<string, ActiveTunnel>();

  protected decideTunnelAdmission(input: TunnelAdmissionInput<Env>): TunnelAdmission {
    const expected = input.env.CAPTUN_TOKEN;
    if (expected) {
      // Constant-time comparison to avoid leaking the gateway token via timing.
      const actual = new TextEncoder().encode(connectTokenFromRequest(input.request) || "");
      const want = new TextEncoder().encode(expected);
      if (!constantTimeEqual(actual, want)) {
        return { ok: false, response: new Response("Unauthorized\n", { status: 401 }) };
      }
    }

    return {
      ok: true,
      token: expected ? connectTokenFromRequest(input.request) || undefined : undefined,
    };
  }

  // The DO's `fetch` only handles the WebSocket upgrade. The upgrade hand-off
  // is special-cased by the Workers runtime around `stub.fetch(...)` — a 101
  // Response with an attached `webSocket` does NOT survive a DO RPC method
  // return (verified empirically: the client side errors with "WebSocket
  // connection failed"). So connect goes through fetch with the tunnel name
  // in a header; everything else uses the `forward` RPC below.
  async fetch(request: Request): Promise<Response> {
    const tunnelName = request.headers.get(TUNNEL_NAME_HEADER);
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    const tunnelUrl = request.headers.get(TUNNEL_URL_HEADER);
    if (!tunnelUrl) return new Response("Missing tunnel URL\n", { status: 404 });

    if (!isGatewayConnectRequest(request)) {
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade\n", { status: 400 });
      }
      return this.forward(tunnelName, request);
    }

    // Non-upgrade connect requests are diagnostic probes: run admission, skip the upgrade.
    if (request.headers.get("upgrade") !== "websocket") {
      return this.diagnoseConnect(tunnelName, request);
    }

    const activeTunnel = this.tunnels.get(tunnelName);
    const admission = await this.decideTunnelAdmission({
      request,
      env: this.env,
      activeToken: activeTunnel?.token,
    });
    if (!admission.ok) return admission.response;

    activeTunnel?.fetcher[Symbol.dispose]();
    const { response, fetcher } = acceptFetcherCapability({
      request,
      onDisconnect: () => {
        if (this.tunnels.get(tunnelName)?.fetcher === fetcher) this.tunnels.delete(tunnelName);
      },
    });
    const tunnel = { url: tunnelUrl, token: admission.token, fetcher };
    this.tunnels.set(tunnelName, tunnel);
    queueMicrotask(() => {
      void fetcher.ready({ url: tunnel.url, token: tunnel.token });
    });
    return response;
  }

  async diagnoseConnect(tunnelName: string, request: Request): Promise<Response> {
    const admission = await this.decideTunnelAdmission({
      request,
      env: this.env,
      activeToken: this.tunnels.get(tunnelName)?.token,
    });
    if (!admission.ok) return admission.response;
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }

  async forward(tunnelName: string, request: Request): Promise<Response> {
    const tunnel = this.tunnels.get(tunnelName)?.fetcher;
    if (!tunnel) return new Response("No tunnel client connected\n", { status: 503 });
    try {
      if (request.headers.get("upgrade") === "websocket") {
        return await forwardWebSocket(tunnel, request);
      }
      return await tunnel.fetch(request);
    } catch {
      return new Response("Tunnel fetch failed\n", { status: 502 });
    }
  }
}

export default {
  fetch(request: Request, env: CaptunEnv): Response | Promise<Response> {
    if ("CAPTUN_SECRET" in env) throw new Error("CAPTUN_SECRET has been renamed to CAPTUN_TOKEN");

    if (isGatewayConnectRequest(request)) {
      return connectTunnel(request, env);
    }

    const tunnelName = getTunnelNameFromUrl({
      customHostname: env.CUSTOM_HOSTNAME,
      url: request.url,
    });
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    // In folder mode the first path segment IS the tunnel name; strip it so the
    // tunnel client sees the real forwarded path. In subdomain mode the path
    // is already the forwarded path.
    const url = new URL(request.url);
    const forwardedPath = env.CUSTOM_HOSTNAME
      ? url.pathname
      : url.pathname.match(/^\/[^/]+(\/.*)?$/)?.[1] || "/";
    url.pathname = forwardedPath;

    if (isCustomHostnameReservedTunnelName(tunnelName, env)) {
      return new Response("Reserved Captun tunnel name\n", { status: 404 });
    }

    const shard = captunServerShard(env, tunnelName);
    const forwarded = new Request(url, request);

    // Keep the canonical tunnel URL attached while crossing into the DO.
    const tunnelUrl = getTunnelUrl({
      reqUrl: request.url,
      customHostname: env.CUSTOM_HOSTNAME,
      tunnelName,
    });
    const tunnelRequest = createTunnelForwardRequest(forwarded, {
      tunnelName,
      tunnelUrl,
    });

    if (request.headers.get("upgrade") === "websocket") return shard.fetch(tunnelRequest);
    return shard.forward(tunnelName, tunnelRequest);
  },
} satisfies ExportedHandler<CaptunEnv>;

function connectTunnel(request: Request, env: CaptunEnv) {
  const diagnostic = isConnectDiagnostic(request);
  if (!diagnostic && request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade\n", { status: 400 });
  }

  const url = new URL(request.url);
  const tunnelName = url.searchParams.get(TUNNEL_NAME_QUERY_PARAM) || "";
  if (!isValidTunnelName(tunnelName) || isCustomHostnameReservedTunnelName(tunnelName, env)) {
    return new Response("Missing tunnel name\n", { status: 404 });
  }

  const tunnelUrl = getTunnelUrl({
    reqUrl: request.url,
    customHostname: env.CUSTOM_HOSTNAME,
    tunnelName,
  });
  const shard = captunServerShard(env, tunnelName);
  // Diagnostic probes (no upgrade header) take the same path; the shard's
  // fetch runs admission without upgrading.
  return shard.fetch(createTunnelConnectRequest({ request, tunnelName, tunnelUrl }));
}

function isGatewayConnectRequest(request: Request) {
  return new URL(request.url).searchParams.get(GATEWAY_CONNECT_QUERY_PARAM) === "1";
}

function isConnectDiagnostic(request: Request) {
  if (request.headers.get("upgrade") === "websocket") return false;
  return request.headers.get(TUNNEL_CONNECT_DIAGNOSTIC_HEADER) === "1";
}

function isCustomHostnameReservedTunnelName(tunnelName: string, env: { CUSTOM_HOSTNAME?: string }) {
  if (!env.CUSTOM_HOSTNAME) return false;
  return CUSTOM_HOSTNAME_RESERVED_TUNNEL_NAMES.includes(tunnelName);
}

export function captunServerShard<Env extends { CAPTUN_TOKEN?: string }>(
  env: CaptunShardBindingEnv<Env>,
  tunnelName: string,
): DurableObjectStub<CaptunServerShard<Env>> {
  return env.CaptunServerShard.getByName(captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)));
}

export function createTunnelConnectRequest(input: {
  request: Request;
  tunnelName: string;
  tunnelUrl: string;
}): Request {
  const headers = new Headers(input.request.headers);
  headers.set(TUNNEL_NAME_HEADER, input.tunnelName);
  headers.set(TUNNEL_URL_HEADER, input.tunnelUrl);
  return new Request(input.request, { headers });
}

export function createTunnelForwardRequest(
  request: Request,
  input: { tunnelName?: string; tunnelUrl: string } | string,
): Request {
  const headers = new Headers(request.headers);
  if (typeof input === "string") {
    headers.set(TUNNEL_URL_HEADER, input);
  } else {
    if (input.tunnelName) headers.set(TUNNEL_NAME_HEADER, input.tunnelName);
    headers.set(TUNNEL_URL_HEADER, input.tunnelUrl);
  }
  return new Request(request, { headers });
}

async function forwardWebSocket(tunnel: FetcherStub, request: Request) {
  if (!tunnel.connectWebSocket) {
    return new Response("Tunnel client cannot forward WebSockets\n", { status: 501 });
  }

  const WorkerWebSocketPair = (
    globalThis as typeof globalThis & { WebSocketPair: WorkerWebSocketPairConstructor }
  ).WebSocketPair;
  const pair = new WorkerWebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];
  serverSocket.accept();
  const incoming = new TransformStream<Uint8Array>();
  const writer = incoming.writable.getWriter();

  try {
    const result = await tunnel.connectWebSocket(
      createWebSocketConnectRequest(request, incoming.readable),
    );
    if (!result.accepted) {
      serverSocket.close(1000, "WebSocket not accepted");
      return result.response;
    }

    pipeWebSocketToRequestBody(serverSocket, writer);
    pipeResponseBodyToWebSocket(result.response, serverSocket);
    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
      headers: result.headers,
    } as WebSocketResponseInit);
  } catch (error) {
    writer.releaseLock();
    serverSocket.close(1011, "WebSocket tunnel failed");
    throw error;
  }
}

function createWebSocketConnectRequest(request: Request, body: ReadableStream<Uint8Array>) {
  const headers = new Headers(request.headers);
  headers.delete("upgrade");
  headers.delete("connection");
  return new Request(request.url, {
    method: "POST",
    headers,
    body,
    // Required by Node-compatible Request implementations; harmless in Workers.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function pipeWebSocketToRequestBody(
  socket: WebSocket,
  writer: WritableStreamDefaultWriter<Uint8Array>,
) {
  socket.addEventListener("message", (event) => {
    void webSocketFrameFromMessage(event.data).then((frame) =>
      writer.write(encodeWebSocketFrame(frame)),
    );
  });
  socket.addEventListener("close", (event) => {
    void writer
      .write(encodeWebSocketFrame({ type: "close", code: event.code, reason: event.reason }))
      .finally(() => {
        writer.close();
        writer.releaseLock();
      });
  });
  socket.addEventListener("error", () => {
    void writer.abort(new Error("WebSocket error"));
  });
}

function pipeResponseBodyToWebSocket(response: Response, socket: WebSocket) {
  void (async () => {
    if (!response.body) return;
    try {
      for await (const frame of decodeWebSocketFrames(response.body)) {
        if (frame.type === "close") {
          closeWebSocket(socket, frame.code, frame.reason);
          return;
        }
        sendWebSocketMessage(socket, frame.data);
      }
    } catch {
      socket.close(1011, "WebSocket tunnel failed");
    }
  })();
}

function closeWebSocket(socket: WebSocket, code?: number, reason?: string) {
  if (code === undefined || code === 1000 || (code >= 3000 && code <= 4999)) {
    socket.close(code, reason);
    return;
  }
  socket.close();
}

function constantTimeEqual(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index++) {
    diff |= actual[index]! ^ expected[index]!;
  }
  return diff === 0;
}
