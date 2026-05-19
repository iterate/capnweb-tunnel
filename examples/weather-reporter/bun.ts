import {
  createCaptunBunTunnelHandler,
  type CaptunBunServer,
  type CaptunBunWebSocketHandler,
  type CaptunServerTunnel,
} from "captun/bun";
import { WeatherReporter } from "./app.js";

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
const app = new WeatherReporter(egressFetch);
const captun = createCaptunBunTunnelHandler();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/weather") {
      return app.fetch(request);
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

    return app.fetch(request);
  },
  websocket: captun.websocket,
});

process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
