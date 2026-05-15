import { newWorkersRpcResponse, RpcTarget } from "capnweb";

const CONNECT_PATH = "/__connect";

/** Drop into a Durable Object and call `server.fetch(request)`.
 * Cap'n Web: https://github.com/cloudflare/capnweb
 * Worker WebSockets: https://developers.cloudflare.com/workers/runtime-apis/websockets/ */
export class CapnwebTunnelServer {
  #client: any;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith(CONNECT_PATH)) return newWorkersRpcResponse(request, new ControlPlane(this));
    if (!this.#client) return new Response("No tunnel client connected\n", { status: 503 });
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return this.#websocket(request);
    return this.#client.fetch(request);
  }

  connect(client: any): string {
    this.#client?.[Symbol.dispose]();
    this.#client = client.dup();
    this.#client.onRpcBroken(() => (this.#client = undefined));
    return new Date().toISOString();
  }

  async #websocket(request: Request): Promise<Response> {
    const [browserSocket, workerSocket] = Object.values(new WebSocketPair());
    workerSocket.accept();
    const callbacks = (await this.#client.websocket(request, new BrowserSocket(workerSocket))).dup();
    workerSocket.addEventListener("message", (event) => callbacks.message(String(event.data)));
    workerSocket.addEventListener("close", (event) => {
      callbacks.close(event.code, event.reason);
      callbacks[Symbol.dispose]();
    });
    return new Response(null, { status: 101, webSocket: browserSocket });
  }
}

class ControlPlane extends RpcTarget {
  private server: CapnwebTunnelServer;
  constructor(server: CapnwebTunnelServer) { super(); this.server = server; }
  connect(client: any): string { return this.server.connect(client); }
}

class BrowserSocket extends RpcTarget {
  private socket: WebSocket;
  constructor(socket: WebSocket) { super(); this.socket = socket; }
  send(message: string): void { this.socket.send(message); }
  close(code?: number, reason?: string): void { this.socket.close(code, reason); }
}
