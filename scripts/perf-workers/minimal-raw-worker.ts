import { DurableObject } from "cloudflare:workers";

interface Env {
  TEST: DurableObjectNamespace<TestDurableObject>;
}

export class TestDurableObject extends DurableObject<Env> {
  fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[0].accept();
      pair[0].send("ready");
      return new Response(null, { status: 101, webSocket: pair[1] });
    }
    return new Response("ok\n");
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
