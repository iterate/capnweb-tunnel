import http from "node:http";

import { createServerAdapter } from "@whatwg-node/server";
import type { CaptunServerTunnel } from "captun";
import { acceptCaptunNodeTunnel } from "captun/node";
import { WebSocketServer } from "ws";

let egressTunnel: CaptunServerTunnel | undefined;
const egressFetch: typeof fetch = async (input, init) => {
  if (egressTunnel) return egressTunnel.fetch(new Request(input, init));
  return fetch(input, init);
};
const webSockets = new WebSocketServer({ noServer: true });

const server = http.createServer(createServerAdapter(serverFetch));

async function serverFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/weather") {
    const city = url.searchParams.get("city") || "";
    const weatherResponse = await egressFetch(`https://wttr.in/${city}?format=j1`);
    const weather = (await weatherResponse.json()) as {
      current_condition: [{ temp_C: string }];
    };
    return new Response(
      `The temperature in ${city} is ${weather.current_condition[0].temp_C} celsius`,
    );
  }

  return new Response("Not found\n", { status: 404 });
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/__intercept-egress-traffic") {
    socket.destroy();
    return;
  }

  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    const tunnel = acceptCaptunNodeTunnel(webSocket, {
      onDisconnect: () => {
        if (egressTunnel === tunnel) egressTunnel = undefined;
      },
    });
    egressTunnel?.[Symbol.dispose]();
    egressTunnel = tunnel;
  });
});

server.listen(Number(process.env.PORT), "127.0.0.1");

process.on("SIGINT", () => {
  webSockets.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
});
