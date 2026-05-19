import {
  createCaptunBunTunnelHandler,
  type CaptunBunServer,
  type CaptunBunWebSocketHandler,
  type CaptunServerTunnel,
} from "captun/bun";

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(
      request: Request,
      server: CaptunBunServer,
    ): Response | Promise<Response | undefined> | undefined;
    websocket: CaptunBunWebSocketHandler;
  }): { stop(force?: boolean): void };
};

let egressTunnel: CaptunServerTunnel | undefined;
const egressFetch: typeof fetch = async (input, init) => {
  if (egressTunnel) return egressTunnel.fetch(new Request(input, init));
  return fetch(input, init);
};
const captun = createCaptunBunTunnelHandler();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/weather") {
      const city = url.searchParams.get("city") || "";
      const response = await egressFetch(`https://wttr.in/${city}?format=j1`);
      const weather = (await response.json()) as {
        current_condition: [{ temp_C: string }];
      };
      return new Response(
        `The temperature in ${city} is ${weather.current_condition[0].temp_C} celsius`,
      );
    }

    if (url.pathname === "/__intercept-egress-traffic") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade\n", { status: 400 });
      }

      const tunnel = captun.accept(request, server, {
        onDisconnect: () => {
          if (egressTunnel === tunnel) egressTunnel = undefined;
        },
      });
      if (!tunnel) return new Response("WebSocket upgrade failed\n", { status: 500 });
      egressTunnel?.[Symbol.dispose]();
      egressTunnel = tunnel;
      return;
    }

    if (url.pathname === "/__health__") return new Response("ok");

    return new Response("Not found\n", { status: 404 });
  },
  websocket: captun.websocket,
});

process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
