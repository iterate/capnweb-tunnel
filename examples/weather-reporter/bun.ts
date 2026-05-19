import {
  createCaptunBunWebSocketHandler,
  type CaptunBunWebSocketHandler,
} from "captun/bun";
import { WeatherReporter } from "./app.js";

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(
      request: Request,
      server: { upgrade(request: Request): boolean },
    ): Response | Promise<Response | undefined> | undefined;
    websocket: CaptunBunWebSocketHandler;
  }): { stop(force?: boolean): void };
};

const app = new WeatherReporter();
const websocket = createCaptunBunWebSocketHandler({
  onTunnel(tunnel) {
    app.replaceEgressTunnel(tunnel);
  },
  onDisconnect(tunnel) {
    app.clearEgressTunnel(tunnel);
  },
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/__health__") return new Response("ok");

    if (url.pathname === "/__intercept-egress-traffic") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade\n", { status: 400 });
      }
      if (server.upgrade(request)) return;
      return new Response("WebSocket upgrade failed\n", { status: 500 });
    }

    return app.fetch(request);
  },
  websocket,
});

process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
