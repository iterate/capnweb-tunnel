import { DurableObject } from "cloudflare:workers";
import {
  acceptFetcherCapability,
  connectTokenFromRequest,
  GATEWAY_CONNECT_QUERY_PARAM,
  isWebSocketUpgradeRequest,
  pipeWebSocketToHandle,
  TUNNEL_CONNECT_DIAGNOSTIC_HEADER,
  TUNNEL_NAME_QUERY_PARAM,
  webSocketHandleFromSocket,
  type FetcherStub,
  type WebSocketConnectResult,
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
  /** Public WebSockets forwarded to this tunnel, closed when the tunnel client goes away. */
  sockets: Set<WebSocket>;
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
      if (!isWebSocketUpgradeRequest(request)) {
        return new Response("Expected WebSocket upgrade\n", { status: 400 });
      }
      return this.forward(tunnelName, request);
    }

    // Non-upgrade connect requests are diagnostic probes: run admission, skip the upgrade.
    if (!isWebSocketUpgradeRequest(request)) {
      return this.diagnoseConnect(tunnelName, request);
    }

    const activeTunnel = this.tunnels.get(tunnelName);
    const admission = await this.decideTunnelAdmission({
      request,
      env: this.env,
      activeToken: activeTunnel?.token,
    });
    if (!admission.ok) return admission.response;

    if (activeTunnel) {
      activeTunnel.fetcher[Symbol.dispose]();
      closeTunnelSockets(activeTunnel);
    }
    const { response, fetcher } = acceptFetcherCapability({
      request,
      onDisconnect: () => {
        const active = this.tunnels.get(tunnelName);
        if (active?.fetcher !== fetcher) return;
        this.tunnels.delete(tunnelName);
        closeTunnelSockets(active);
      },
    });
    const tunnel: ActiveTunnel = {
      url: tunnelUrl,
      token: admission.token,
      fetcher,
      sockets: new Set(),
    };
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
    const tunnel = this.tunnels.get(tunnelName);
    if (!tunnel) return new Response("No tunnel client connected\n", { status: 503 });
    try {
      if (isWebSocketUpgradeRequest(request)) {
        return await forwardWebSocket(tunnel, request);
      }
      return await tunnel.fetcher.fetch(request);
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

    if (isWebSocketUpgradeRequest(request)) return shard.fetch(tunnelRequest);
    return shard.forward(tunnelName, tunnelRequest);
  },
} satisfies ExportedHandler<CaptunEnv>;

function connectTunnel(request: Request, env: CaptunEnv) {
  const diagnostic = isConnectDiagnostic(request);
  if (!diagnostic && !isWebSocketUpgradeRequest(request)) {
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
  if (isWebSocketUpgradeRequest(request)) return false;
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
  input: { tunnelName: string; tunnelUrl: string },
): Request {
  const headers = new Headers(request.headers);
  headers.set(TUNNEL_NAME_HEADER, input.tunnelName);
  headers.set(TUNNEL_URL_HEADER, input.tunnelUrl);
  return new Request(request, { headers });
}

async function forwardWebSocket(tunnel: ActiveTunnel, request: Request) {
  const WorkerWebSocketPair = (
    globalThis as typeof globalThis & { WebSocketPair: WorkerWebSocketPairConstructor }
  ).WebSocketPair;
  const pair = new WorkerWebSocketPair();
  const serverSocket = pair[1];
  serverSocket.accept();

  let result: WebSocketConnectResult;
  try {
    result = await tunnel.fetcher.connectWebSocket(
      request,
      webSocketHandleFromSocket(serverSocket),
    );
  } catch (error) {
    serverSocket.close(1011, "WebSocket tunnel failed");
    throw error;
  }
  if (!result.accepted) {
    serverSocket.close(1000, "WebSocket not accepted");
    return result.response;
  }

  pipeWebSocketToHandle(serverSocket, result.socket);
  // The pipe dup()ed its own reference to the tunnel client's handle; release ours.
  (result.socket as Partial<Disposable>)[Symbol.dispose]?.();
  tunnel.sockets.add(serverSocket);
  serverSocket.addEventListener("close", () => tunnel.sockets.delete(serverSocket));
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: result.protocol ? { "sec-websocket-protocol": result.protocol } : undefined,
  } as WebSocketResponseInit);
}

function closeTunnelSockets(tunnel: ActiveTunnel) {
  for (const socket of tunnel.sockets) {
    try {
      // workerd allows close(1001) (going away) even though browser clients don't.
      socket.close(1001, "Tunnel client disconnected");
    } catch {
      // Already closed.
    }
  }
  tunnel.sockets.clear();
}

function constantTimeEqual(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index++) {
    diff |= actual[index]! ^ expected[index]!;
  }
  return diff === 0;
}
