# capnweb-tunnel

Two-file Cap'n Web tunnel API:

- [src/server.ts](./src/server.ts): `CapnwebTunnelServer` for Cloudflare Workers
  and Durable Objects.
- [src/client.ts](./src/client.ts): `CapnwebTunnelClient` for Node.

The client connects to `/__capnweb_tunnels/[name]/__connect`, registers a local
`fetch(request: Request): Promise<Response> | Response`, and the server forwards
public requests to it.

## Durable Object Integration

```ts
import { CapnwebTunnelServer } from "./server";

export class MyDurableObject implements DurableObject {
  private readonly tunnel = new CapnwebTunnelServer();

  fetch(request: Request): Promise<Response> {
    return this.tunnel.fetch(request);
  }
}
```

If your DO already has routes, handle those first and delegate the egress path:

```ts
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/local") return new Response("handled locally");
  return this.tunnel.fetch(request);
}
```

## Node Client

```ts
import { CapnwebTunnelClient } from "./client";

const client = new CapnwebTunnelClient("https://example.workers.dev", {
  fetch: (request) => fetch(request),
});

await client.connect();
```

## Test

```sh
npm install
npm run typecheck
TUNNEL_SERVER_URL=https://cheap-tunnel.<account>.workers.dev \
TUNNEL_API_SECRET=optional-secret \
npm test
```

`TUNNEL_SERVER_URL` defaults to the deployed prototype URL.
If `TUNNEL_API_SECRET` is set on the Worker, clients and public requests must
send `Authorization: Bearer <secret>`.

## CLI

```sh
TUNNEL_SERVER_URL=https://cheap-tunnel.<account>.workers.dev/__capnweb_tunnels/my-tunnel \
TUNNEL_API_SECRET=optional-secret \
npm run cli -- 3000
```
