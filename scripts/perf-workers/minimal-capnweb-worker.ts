import { DurableObject } from "cloudflare:workers";
import { newWorkersRpcResponse, RpcTarget } from "capnweb";

interface Env {
  TEST: DurableObjectNamespace<TestDurableObject>;
}

class Api extends RpcTarget {
  useFetcher() {}
}

export class TestDurableObject extends DurableObject<Env> {
  fetch(request: Request) {
    return newWorkersRpcResponse(request, new Api());
  }
}

export default {
  fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/edge") return new Response("ok\n");
    const name = url.pathname.split("/").filter(Boolean)[0] ?? "default";
    return env.TEST.get(env.TEST.idFromName(name)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
