import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import {
  acceptCaptunNodeTunnel,
  type CaptunNodeWebSocket,
  type CaptunServerTunnel,
} from "captun/node";
import { WebSocketServer } from "ws";

let egressTunnel: CaptunServerTunnel | undefined;
const egressFetch: typeof fetch = async (input, init) => {
  if (egressTunnel) return egressTunnel.fetch(new Request(input, init));
  return fetch(input, init);
};
const webSockets = new WebSocketServer({ noServer: true });

const server = http.createServer(async (request, response) => {
  if (request.headers.upgrade?.toLowerCase() === "websocket") return;

  try {
    const fetchRequest = nodeRequestToFetchRequest(request);
    const url = new URL(fetchRequest.url);

    if (url.pathname === "/weather") {
      const city = url.searchParams.get("city") || "";
      const weatherResponse = await egressFetch(`https://wttr.in/${city}?format=j1`);
      const weather = (await weatherResponse.json()) as {
        current_condition: [{ temp_C: string }];
      };
      await writeFetchResponse(
        response,
        new Response(
          `The temperature in ${city} is ${weather.current_condition[0].temp_C} celsius`,
        ),
      );
      return;
    }

    if (url.pathname === "/__intercept-egress-traffic") {
      await writeFetchResponse(response, new Response("Expected WebSocket upgrade\n", { status: 400 }));
      return;
    }

    if (url.pathname === "/__health__") {
      await writeFetchResponse(response, new Response("ok"));
      return;
    }

    await writeFetchResponse(response, new Response("Not found\n", { status: 404 }));
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(String(error instanceof Error ? error.stack || error.message : error));
  }
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/__intercept-egress-traffic") {
    socket.destroy();
    return;
  }

  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    const tunnel = acceptCaptunNodeTunnel(webSocket as unknown as CaptunNodeWebSocket, {
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

function nodeRequestToFetchRequest(request: IncomingMessage) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value) {
      headers.set(name, value);
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request) as unknown as ReadableStream;
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function writeFetchResponse(response: ServerResponse, fetchResponse: Response) {
  response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers.entries()));
  if (fetchResponse.body) {
    for await (const chunk of fetchResponse.body) response.write(chunk);
  }
  response.end();
}
