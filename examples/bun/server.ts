import { createCaptunBunTunnelHandler } from "captun/bun";

const captun = createCaptunBunTunnelHandler();

let egressTunnel: ReturnType<typeof captun.accept>;
const egressFetch = async (input: string | URL | Request, init?: RequestInit) => {
  if (egressTunnel) {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return egressTunnel.fetch(request);
  }
  return fetch(input, init);
};

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

    return new Response("Not found\n", { status: 404 });
  },
  websocket: captun.websocket,
});

process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
