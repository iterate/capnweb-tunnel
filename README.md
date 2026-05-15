# capnweb-tunnel

`capnweb-tunnel` is a tiny reverse tunnel built on
[Cap'n Web](https://github.com/cloudflare/capnweb). It gives you a much faster
but slightly less durable alternative to Cloudflare Tunnels.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iterate/capnweb-tunnel)

We use it in end-to-end tests for deployed Cloudflare Workers: public internet
egress is sent back to the Vitest test runner, where responses are replayed from
a HAR archive. That lets us run real E2E tests against deployed Workers with a
fully mocked internet.

But you can use it for whatever you like. Use it instead of ngrok or Cloudflare
Tunnels when you want a small, fast tunnel that lives in your codebase.

It is about 100 lines of code. Ask your AI agent to copy it into your project
and adapt it.

## Files

- [src/server.ts](./src/server.ts): `CapnwebTunnelServer` for Cloudflare Workers
  and Durable Objects.
- [src/client.ts](./src/client.ts): `CapnwebTunnelClient` for Node.
- [src/worker.ts](./src/worker.ts): example Worker routing named tunnels.

## Worker Routes

```text
/[name]            -> named Durable Object tunnel
/[name]/__connect  -> Cap'n Web client connection
https://[name].tunnels.example.com/* -> named Durable Object tunnel
```

For the nicest URLs, deploy the Worker and add a wildcard route like:

```text
*.tunnels.example.com/*
```

Then `my-test.tunnels.example.com` uses the `my-test` Durable Object tunnel.
Without a wildcard route, use `/my-test` on the Worker URL instead.

Cloudflare's deploy button clones and deploys this Worker for you. After
deploying, add the wildcard route above in your Worker routes/custom domains.
Cloudflare's docs note that Deploy to Cloudflare buttons require a public
GitHub/GitLab repository.

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

const client = new CapnwebTunnelClient("https://example.workers.dev/test", {
  fetch: (request) => fetch(request),
});

await client.connect();
```

## Authentication

Authentication is optional. If `TUNNEL_USERNAME` and `TUNNEL_PASSWORD` are set
on the Worker, every tunnel request must include HTTP Basic auth:

```text
Authorization: Basic base64(username:password)
```

The client and CLI send this automatically when the same env vars are set.

## CLI

```sh
TUNNEL_SERVER_URL=https://example.workers.dev \
npm run cli -- 3000 --name my-tunnel
```

If `--name` is omitted, the CLI picks a random name like `apple-fast-tree`.

## Test

```sh
npm install
npm run typecheck
TUNNEL_SERVER_URL=https://example.workers.dev npm test
```

`TUNNEL_SERVER_URL` defaults to the deployed prototype URL. Set
`TUNNEL_USERNAME` and `TUNNEL_PASSWORD` when testing an authenticated Worker.
