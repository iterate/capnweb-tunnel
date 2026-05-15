import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import WebSocket from "ws";

export interface CapnwebTunnelSocket {
  send(message: string): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface CapnwebTunnelWebSocket {
  message(message: string): void | Promise<void>;
  close(code?: number, reason?: string): void | Promise<void>;
}

export interface CapnwebTunnelClientOptions {
  headers?: Record<string, string>;
  fetch: (request: Request) => Promise<Response> | Response;
  websocket?: (
    request: Request,
    socket: CapnwebTunnelSocket,
  ) => Promise<CapnwebTunnelWebSocket> | CapnwebTunnelWebSocket;
}

type RemoteSocket = {
  send(message: string): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
};

/** Point at a tunnel server and provide local request handling.
 * Cap'n Web: https://github.com/cloudflare/capnweb */
export class CapnwebTunnelClient {
  #url: URL; #options: CapnwebTunnelClientOptions; #server: any;

  constructor(serverUrl: string | URL, options: CapnwebTunnelClientOptions) {
    this.#url = new URL(serverUrl);
    this.#options = options;
  }

  async connect(): Promise<string> {
    const socket = new WebSocket(this.#rpcUrl(), { headers: this.#options.headers }) as unknown as globalThis.WebSocket;
    this.#server = newWebSocketRpcSession(socket);
    this.#server.onRpcBroken((error: unknown) => console.error("tunnel rpc broken", error));
    return this.#server.connect(new LocalTunnelClient(this.#options));
  }

  close(): void {
    this.#server?.[Symbol.dispose]();
  }

  #rpcUrl(): string {
    const url = new URL(this.#url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (!url.pathname.endsWith("/__connect")) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/__connect`;
    }
    return url.toString();
  }
}

class LocalTunnelClient extends RpcTarget {
  private options: CapnwebTunnelClientOptions;
  constructor(options: CapnwebTunnelClientOptions) { super(); this.options = options; }
  fetch(request: Request): Promise<Response> | Response { return this.options.fetch(request); }
  async websocket(request: Request, socket: RpcStub<RemoteSocket>): Promise<LocalWebSocketHandler> {
    if (!this.options.websocket) throw new Error("This tunnel client did not provide websocket()");
    const handler = await this.options.websocket(request, new CapnwebRemoteSocket(socket));
    return new LocalWebSocketHandler(handler);
  }
}

class LocalWebSocketHandler extends RpcTarget implements CapnwebTunnelWebSocket {
  private handler: CapnwebTunnelWebSocket;
  constructor(handler: CapnwebTunnelWebSocket) { super(); this.handler = handler; }
  message(message: string): void | Promise<void> { return this.handler.message(message); }
  close(code?: number, reason?: string): void | Promise<void> { return this.handler.close(code, reason); }
}

class CapnwebRemoteSocket implements CapnwebTunnelSocket {
  private socket: RpcStub<RemoteSocket>;
  constructor(socket: RpcStub<RemoteSocket>) { this.socket = socket.dup(); }
  send(message: string): Promise<void> { return this.socket.send(message); }
  close(code?: number, reason?: string): Promise<void> { return this.socket.close(code, reason); }
}
