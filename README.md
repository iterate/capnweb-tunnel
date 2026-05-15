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
- [src/worker.ts](./src/worker.ts): example Worker using one tunnel.

## Worker Routes

```text
/*          -> default Durable Object tunnel
/__connect  -> Cap'n Web client connection
```

Cloudflare's deploy button clones and deploys this Worker for you. Cloudflare's
docs note that Deploy to Cloudflare buttons require a public GitHub/GitLab
repository.

For a simple deployment, put the Worker on one hostname:

```sh
npx wrangler deploy --route tunnels.example.com/*
```

Then connect the client to `https://tunnels.example.com`. This works with
Cloudflare Universal SSL because `tunnels.example.com` is a first-level
subdomain of `example.com`.

If you want nicer wildcard tunnel URLs like:

```text
https://my-test.tunnels.example.com
```

deploy with a wildcard Worker route:

```sh
npx wrangler deploy \
  --route tunnels.example.com/* \
  --route "*.tunnels.example.com/*"
```

You also need a proxied wildcard DNS record for `*.tunnels.example.com`, and
Cloudflare must have an edge certificate covering `*.tunnels.example.com`.
Universal SSL on a normal full-zone setup covers `example.com` and
`*.example.com`; it does not cover nested wildcards like
`*.tunnels.example.com`. Use Advanced Certificate Manager / Total TLS, or order
an advanced certificate for `*.tunnels.example.com`.

If you do not want Advanced Certificate Manager, use `https://tunnels.example.com`
instead of `https://name.tunnels.example.com`, or route directly from
`*.example.com/*` if you are happy to reserve the whole first-level wildcard for
tunnels.

Cloudflare docs:

- Universal SSL: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/
- Universal SSL limitations: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
- Worker routes: https://developers.cloudflare.com/workers/configuration/routing/routes/

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

## CLI

```sh
TUNNEL_SERVER_URL=https://example.workers.dev \
npm run cli -- 3000
```

## Test

```sh
npm install
npm run typecheck
TUNNEL_SERVER_URL=https://example.workers.dev npm test
```

`TUNNEL_SERVER_URL` defaults to the deployed prototype URL.
