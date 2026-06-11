import { newWorkersWebSocketRpcResponse, RpcTarget } from "capnweb";

class DummyCapability extends RpcTarget {
  ping(value: string) {
    return `pong:${value}`;
  }
}

export default {
  fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/rpc") {
      return newWorkersWebSocketRpcResponse(request, new DummyCapability());
    }

    return new Response("Not found\n", { status: 404 });
  },
};
