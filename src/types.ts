import type { RpcTarget } from "capnweb";

/** Something that can handle a Fetch API request. */
export interface Fetcher {
  fetch(request: Request): Response | Promise<Response>;
}

/** Options for opening a local process to public Captun tunnel connection. */
export interface CreateCaptunTunnelOptions extends Fetcher {
  /** Exact WebSocket-capable connect URL, including the app's connect route. */
  url: string | URL;
  /** Headers sent on the WebSocket upgrade request, for auth or routing metadata. */
  headers?: HeadersInit;
}

/** Options for accepting a client WebSocket as a server-side tunnel. */
export interface AcceptCaptunTunnelOptions {
  /** Called when the underlying RPC connection breaks. */
  onDisconnect?: () => void;
}

/** Server-side handle for forwarding HTTP requests through an accepted tunnel. */
export interface CaptunServerTunnel extends Fetcher, Disposable {}

/** Client-side Cap'n Web main object exposed to the server after connecting.
 *
 * Cap'n Web passes `RpcTarget` instances by reference. The client gives this
 * object to `newWebSocketRpcSession()`, and the server receives a stub for it
 * when accepting the same WebSocket.
 *
 * Docs: https://github.com/cloudflare/capnweb#rpctarget */
export interface CaptunClientCapability extends RpcTarget, Fetcher {}

