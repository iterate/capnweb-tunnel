import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import {
  getTunnelUrlFromServerUrl,
  HOSTED_CAPTUN_SERVER_URL,
  TUNNEL_OWNER_TOKEN_HEADER,
  TUNNEL_OWNER_TOKEN_QUERY_PARAM,
} from "./routing.js";

/** Fetch is all you need!
 *
 * Cap'n Web let us pass this fetcher from the
 * tunnel client to the server via fetch (via websockets)
 * Then the server can just fetch into the client like normal.
 * This is all possible because Cap'n Web can pass Request and Response object
 * across the websocket RPC boundary transparently
 **/
export interface Fetcher {
  fetch(request: Request): Response | Promise<Response>;
}

// ---------------------------------------------------------------------------
// Tunnel client (formerly src/client.ts)
// ---------------------------------------------------------------------------

/** Creates a tunnel from a public Worker URL to a local fetch implementation.
 *
 * Captun gives us one WebSocket RPC session. The client exposes its fetcher as
 * the session's main object, and the server calls that object through a remote
 * stub when forwarding HTTP requests.
 *
 * Cap'n Web WebSocket sessions:
 * https://github.com/cloudflare/capnweb#websocket-client
 */
export type CaptunTunnel = Disposable & {
  url: string;
  ownerToken: string;
};

export async function createCaptunTunnel(
  options: Fetcher & {
    url?: string | URL;
    serverUrl?: string;
    name?: string;
    headers?: Record<string, string>;
    ownerToken?: string;
  },
): Promise<CaptunTunnel> {
  const endpoint = resolveTunnelEndpoint(options);
  const ownership = withAnonymousOwnershipToken({
    connectUrl: endpoint.connectUrl,
    headers: options.headers,
    ownerToken: options.ownerToken,
  });
  const socket = createWebSocket({ url: ownership.connectUrl, headers: options.headers });
  // tunnelTargetFetcher is the "main object" that comes out on the other side in acceptCaptunTunnel
  // as a capnweb rpc stub that the server can just call fetch on
  const tunnelTargetFetcher = new TunnelTargetFetcher({ fetch: options.fetch });
  const session = newWebSocketRpcSession(socket, tunnelTargetFetcher);
  await waitUntilOpen(socket);

  return {
    url: endpoint.publicUrl,
    ownerToken: ownership.ownerToken,
    [Symbol.dispose]: () => session[Symbol.dispose](),
  };
}

function resolveTunnelEndpoint(options: {
  url?: string | URL;
  serverUrl?: string;
  name?: string;
}): { publicUrl: string; connectUrl: string } {
  if (options.url) {
    const publicUrl = publicUrlFromConnectUrl(new URL(options.url));
    return { publicUrl, connectUrl: String(options.url) };
  }

  const tunnelName = options.name || randomTunnelName();
  const serverUrl = options.serverUrl || HOSTED_CAPTUN_SERVER_URL;
  const publicUrl = getTunnelUrlFromServerUrl(serverUrl, tunnelName);
  return { publicUrl, connectUrl: `${publicUrl}/__captun-connect` };
}

function publicUrlFromConnectUrl(connectUrl: URL) {
  const publicUrl = new URL(connectUrl);
  publicUrl.pathname = publicUrl.pathname.replace(/\/__captun-connect\/?$/, "") || "/";
  publicUrl.search = "";
  publicUrl.hash = "";
  return publicUrl.toString().replace(/\/$/, "");
}

function withAnonymousOwnershipToken(options: {
  connectUrl: string;
  headers: Record<string, string> | undefined;
  ownerToken: string | undefined;
}) {
  const headerToken = getHeader(options.headers, TUNNEL_OWNER_TOKEN_HEADER);
  if (headerToken) return { connectUrl: options.connectUrl, ownerToken: headerToken };

  const connectUrl = new URL(options.connectUrl);
  const ownerToken =
    options.ownerToken ||
    connectUrl.searchParams.get(TUNNEL_OWNER_TOKEN_QUERY_PARAM) ||
    randomOwnershipToken();
  connectUrl.searchParams.set(TUNNEL_OWNER_TOKEN_QUERY_PARAM, ownerToken);
  return { connectUrl: connectUrl.toString(), ownerToken };
}

function getHeader(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lowerName);
  return key ? headers[key] : undefined;
}

function randomTunnelName() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomOwnershipToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class TunnelTargetFetcher extends RpcTarget implements Fetcher {
  private fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  fetch(request: Request) {
    return this.fetcher.fetch(request);
  }
}

function createWebSocket(options: { url: string | URL; headers?: Record<string, string> }) {
  const connectUrl = new URL(options.url);
  connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
  // TypeScript sees the standard DOM/Workers constructor here, where the second
  // argument is only WebSocket protocols. Node's CLI WebSocket runtime also
  // accepts a headers init object, which we need for tunnel auth.
  const WebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    init?: string | string[] | { headers: Record<string, string> },
  ) => WebSocket;
  return new WebSocketWithHeaders(
    connectUrl.href,
    options.headers ? { headers: options.headers } : undefined,
  );
}

async function waitUntilOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) {
    throw new Error("WebSocket closed before opening");
  }

  const listeners = new AbortController();
  await new Promise<void>((resolve, reject) => {
    const settle = (callback: () => void) => {
      listeners.abort();
      callback();
    };
    socket.addEventListener("open", () => settle(resolve), { signal: listeners.signal });
    socket.addEventListener(
      "error",
      () => settle(() => reject(new Error("WebSocket connection failed"))),
      { signal: listeners.signal },
    );
    socket.addEventListener(
      "close",
      (event) => {
        listeners.abort();
        reject(new Error(`WebSocket closed before opening: ${event.code} ${event.reason}`));
      },
      { signal: listeners.signal },
    );
  });
}

// ---------------------------------------------------------------------------
// Tunnel server (formerly src/server.ts)
// ---------------------------------------------------------------------------

/** Creates a Worker WebSocket upgrade response and matching tunnel handle. */
export function acceptCaptunTunnel(options: { onDisconnect?: () => void } = {}) {
  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];

  serverSocket.accept();
  const tunnel = acceptCaptunTunnelFromSocket(serverSocket, options);

  return {
    tunnel,
    response: new Response(null, { status: 101, webSocket: clientSocket }),
  };
}

export function acceptCaptunTunnelFromSocket(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
): Fetcher & Disposable {
  // The generic describes the peer's main object; Cap'n Web still returns a
  // stub with lifecycle methods like onRpcBroken() and Symbol.dispose.
  const tunnelTargetFetcher = newWebSocketRpcSession<Fetcher>(socket);
  tunnelTargetFetcher.onRpcBroken(() => options.onDisconnect?.());

  return {
    fetch: (request) => tunnelTargetFetcher.fetch(request),
    [Symbol.dispose]: () => tunnelTargetFetcher[Symbol.dispose](),
  };
}
