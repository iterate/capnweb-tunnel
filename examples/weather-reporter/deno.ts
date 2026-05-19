import { acceptCaptunDenoTunnel, type CaptunServerTunnel } from "captun/deno";
import { WeatherReporter } from "./app.js";

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

const app = new WeatherReporter();

const server = Deno.serve(
  { hostname: "127.0.0.1", port: Number(Deno.env.get("PORT")) },
  (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/__health__") return new Response("ok");

    if (url.pathname === "/__intercept-egress-traffic") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade\n", { status: 400 });
      }

      const { socket, response } = Deno.upgradeWebSocket(request);
      let acceptedTunnel: CaptunServerTunnel | undefined;
      socket.addEventListener("open", () => {
        const tunnel = acceptCaptunDenoTunnel(socket, {
          onDisconnect: () => {
            if (acceptedTunnel) app.clearEgressTunnel(acceptedTunnel);
          },
        });
        acceptedTunnel = tunnel;
        app.replaceEgressTunnel(tunnel);
      });
      return response;
    }

    return app.fetch(request);
  },
);

Deno.addSignalListener("SIGINT", () => {
  server.shutdown().finally(() => Deno.exit(0));
});
