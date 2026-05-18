# capnweb-tunnel

`capnweb-tunnel` is a tiny reference implementation of a self-hosted ngrok or
Cloudflare Tunnel alternative. It runs the public server on Cloudflare Workers
and lets a local Node process provide the `fetch()` implementation that handles
incoming HTTP requests.

Deploy it:

```bash
npm install
npx wrangler deploy
```

Expose a local server through a folder tunnel:

```bash
python3 -m http.server 3000

TUNNEL_SERVER_URL=https://capnweb-tunnel.<your-account>.workers.dev \
npm run cli -- --name my-test 3000
```

Then call it from any HTTP client:

```bash
curl https://capnweb-tunnel.<your-account>.workers.dev/my-test/
```

Or use the client directly:

```ts
import { CapnwebTunnelClient } from "./src/client";

const client = new CapnwebTunnelClient("https://example.workers.dev/my-test", {
  fetch: (request) => fetch(request),
});

await client.connect();
```

The core client/server/types implementation is about 100 lines of code, built on
[Capnweb](https://github.com/cloudflare/capnweb). Ask your AI agent to copy it
into your project and adapt it.

We use it in end-to-end tests for deployed Cloudflare Workers: public internet
egress is sent back to the Vitest test runner, where responses are replayed from
a HAR archive. That lets us run real E2E tests against deployed Workers with a
fully mocked internet.

But you can use it for whatever you like. Use it instead of ngrok or Cloudflare
Tunnels when you want a small, fast tunnel that lives in your codebase.

## How Does It Work?

We just pass `fetch()` through `fetch()`. No, really.

With Capnweb, a client can make a WebSocket connection to a server and pass the
server a fetch function. The server can then forward requests to it. That is the
whole tunnel: the Worker receives normal HTTP requests, calls the client-provided
`fetch(request)`, and returns the resulting `Response`.

All you need is `fetch()`. Requests, responses, headers, bodies, streams, SSE,
and uploads are already web standards. This is the web-standards way this should
work.

```mermaid
sequenceDiagram
  participant HTTP as HTTP client
  participant Server as Cloudflare Worker / Durable Object
  participant Client as Node client

  Client->>Server: WebSocket RPC connect to /my-test/__connect
  Client->>Server: useFetcher(fetcher)
  Note over Client,Server: fetcher is a Capnweb RPC target with fetch(request)
  HTTP->>Server: GET /my-test/hello
  Server->>Client: fetch(request)
  Client-->>Server: Response
  Server-->>HTTP: Response
```

That is the key flow:

1. The client connects to the server.
2. The client runs in Node and the server runs in Cloudflare Workers.
3. The Capnweb session happens over WebSockets.
4. Once connected, the client can call RPC methods on the server.
5. The first call is `useFetcher(fetcher)`.
6. From then on, the server sends HTTP requests through `fetcher.fetch(request)`.

## Files

- [src/types.ts](./src/types.ts): the small shared Capnweb interface.
- [src/server.ts](./src/server.ts): `CapnwebTunnelServer` for Cloudflare Workers
  and Durable Objects.
- [src/client.ts](./src/client.ts): `CapnwebTunnelClient` for Node.
- [src/worker.ts](./src/worker.ts): example Worker routing named tunnels.

## Worker Routes

```text
/:name/*          -> HTTP requests for the named tunnel
/:name/__connect  -> Capnweb client connection for the named tunnel
```

The golden path is folder-based tunnels on the default Worker hostname:

```text
https://capnweb-tunnel.<your-account>.workers.dev/my-test
```

Deploy the Worker:

```bash
npm install
npx wrangler deploy
```

Run the client:

```bash
TUNNEL_SERVER_URL=https://capnweb-tunnel.<your-account>.workers.dev \
npm run cli -- --name my-test 3000
```

Then send HTTP traffic to:

```text
https://capnweb-tunnel.<your-account>.workers.dev/my-test/anything
```

The Worker strips `/my-test` before calling the client fetcher, so the local
server sees `/anything`.

## Custom Hostnames

Some proxy targets behave better with naked hostnames than with path prefixes.
In that case, use the hostname to pick the tunnel:

```text
https://my-test.tunnels.example.com
```

Deploy with a wildcard Worker route:

```bash
npx wrangler deploy \
  --route "*.tunnels.example.com/*"
```

Option 1: use a subdomain of your existing domain, like
`*.tunnels.example.com`. This needs a proxied wildcard DNS record and an edge
certificate for the nested wildcard, usually via Cloudflare Advanced Certificate
Manager / Total TLS.

Option 2: buy a dedicated domain like `my-tunnels.com` for around $10/year and
use `*.my-tunnels.com`. That wildcard is only one level deep, so it fits
Cloudflare's normal Universal SSL setup and avoids the advanced certificate
work.

See Cloudflare's docs on
[Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/),
[Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/),
and [Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
for the underlying platform rules.

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

const client = new CapnwebTunnelClient("https://example.workers.dev/my-test", {
  fetch: (request) => fetch(request),
});

await client.connect();
```

The shared interface is deliberately tiny:

```ts
import type { RpcTarget } from "capnweb";

export type Fetcher = (request: Request) => Response | Promise<Response>;

export interface CapnwebTunnelClientCapability extends RpcTarget {
  fetch: Fetcher;
}

export interface CapnwebTunnelServerCapability extends RpcTarget {
  useFetcher(fetcher: CapnwebTunnelClientCapability): void | Promise<void>;
}
```

## CLI

```bash
TUNNEL_SERVER_URL=https://example.workers.dev npm run cli -- --name my-test 3000
```

## Test

```bash
npm install
npm run typecheck
```

In one terminal:

```bash
npm run dev
```

In another terminal:

```bash
npm test
```

`TUNNEL_SERVER_URL` defaults to `http://localhost:8787`. Set it to a deployed
Worker URL to test against Cloudflare. For wildcard subdomains, use `{name}` as
a placeholder so each concurrent test gets its own hostname:

```bash
TUNNEL_SERVER_URL=https://{name}.tunnels.example.com npm test
```
