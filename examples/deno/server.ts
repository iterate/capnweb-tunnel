import { acceptCaptunDenoTunnel, type CaptunServerTunnel } from "captun/deno";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(
    options: { hostname: string; port: number },
    handler: (request: Request) => Response | Promise<Response>,
  ): { shutdown(): Promise<void> };
  upgradeWebSocket(request: Request): { socket: WebSocket; response: Response };
  addSignalListener(signal: "SIGINT", handler: () => void): void;
  exit(code?: number): never;
};

let egressTunnel: CaptunServerTunnel | undefined;
const egressFetch: typeof fetch = async (input, init) => {
  if (egressTunnel) return egressTunnel.fetch(new Request(input, init));
  return fetch(input, init);
};

const server = Deno.serve(
  { hostname: "127.0.0.1", port: Number(Deno.env.get("PORT")) },
  async (request) => {
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

      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.addEventListener("open", () => {
        const tunnel = acceptCaptunDenoTunnel(socket, {
          onDisconnect: () => {
            if (egressTunnel === tunnel) egressTunnel = undefined;
          },
        });
        egressTunnel?.[Symbol.dispose]();
        egressTunnel = tunnel;
      });
      return response;
    }

    if (url.pathname === "/__health__") return new Response("ok");

    return new Response("Not found\n", { status: 404 });
  },
);

Deno.addSignalListener("SIGINT", () => {
  server.shutdown().finally(() => Deno.exit(0));
});
