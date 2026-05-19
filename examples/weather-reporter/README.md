# Weather Reporter

Tiny example app that uses Captun to mock outbound network egress in an e2e test.
The app fetches live weather from the free, no-key `wttr.in` API.
All requests proxy through one small Durable Object so the intercepted egress
tunnel is used from the same Worker request context.

## Run Locally

From the repository root, install once:

```sh
pnpm install
```

Then run the example test from this directory:

```sh
pnpm test
```

The test starts a Miniflare Worker automatically when `WEATHER_REPORTER_URL` is not set.
To point the same test at an already-running local Worker:

```sh
WEATHER_REPORTER_URL=http://127.0.0.1:8787 pnpm test
```

## Deploy And Test

```sh
pnpm exec wrangler deploy
WEATHER_REPORTER_URL=https://weather-reporter.<your-subdomain>.workers.dev pnpm test
```

For this workspace, deploy with Doppler-provided Cloudflare credentials:

```sh
doppler run -- pnpm exec wrangler deploy
WEATHER_REPORTER_URL=https://weather-reporter.garple-pretend-customer-should-be-iterate-dev-stg-will-chan.workers.dev pnpm test
```

The test awaits `createCaptunTunnel()` at the Worker's `/__intercept-egress-traffic` route, mocks the `wttr.in` response, then calls `/weather/london` and `/weather/new+york` on the Worker.
