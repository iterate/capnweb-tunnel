import { newWorkersWebSocketRpcResponse, RpcTarget } from "capnweb";

class DummyCapability extends RpcTarget {
  ping(value: string) {
    return `pong:${value}`;
  }
}

type WorkerWebSocketPairConstructor = new () => {
  0: WebSocket;
  1: WebSocket & { accept(): void };
};

export default {
  fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/rpc") {
      return newWorkersWebSocketRpcResponse(request, new DummyCapability());
    }
    if (url.pathname === "/ws") return webSocketEchoResponse(request);

    return new Response("Not found\n", { status: 404 });
  },
};

/** Echoes text as `echo:<text>`, binary untouched, and `close-with:<code> <reason>` as a close. */
function webSocketEchoResponse(request: Request) {
  const WorkerWebSocketPair = (
    globalThis as typeof globalThis & { WebSocketPair: WorkerWebSocketPairConstructor }
  ).WebSocketPair;
  const pair = new WorkerWebSocketPair();
  const socket = pair[1];
  socket.accept();
  socket.addEventListener("message", (event) => {
    void (async () => {
      if (typeof event.data !== "string") {
        // Binary may arrive as ArrayBuffer or Blob depending on the runtime.
        const blob = event.data as Blob;
        socket.send(typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : event.data);
        return;
      }
      if (event.data.startsWith("close-with:")) {
        const [code, ...reason] = event.data.slice("close-with:".length).split(" ");
        socket.close(Number(code), reason.join(" "));
        return;
      }
      socket.send(`echo:${event.data}`);
    })();
  });
  // Select the first offered subprotocol so tests can assert negotiation.
  const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: protocol ? { "sec-websocket-protocol": protocol } : undefined,
  } as ResponseInit & { webSocket: WebSocket });
}
