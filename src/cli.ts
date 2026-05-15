import { CapnwebTunnelClient } from "./client";

const port = process.argv[2] ?? "3000";
const tunnel = process.env.TUNNEL_SERVER_URL ?? "http://localhost:8787/__capnweb_tunnels/default";
const origin = `http://localhost:${port}`;

const client = new CapnwebTunnelClient(tunnel, {
  headers: process.env.TUNNEL_API_SECRET
    ? { authorization: `Bearer ${process.env.TUNNEL_API_SECRET}` }
    : undefined,
  fetch: (request) => {
    const url = new URL(request.url);
    return fetch(new URL(url.pathname + url.search, origin), request);
  },
});

console.log(`tunneling ${tunnel} -> ${origin}`);
await client.connect();
await new Promise(() => {});
