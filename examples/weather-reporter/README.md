# Weather Reporter

Tiny example app that uses Captun to mock outbound network egress in an e2e test.
The app fetches live weather from the free, no-key `wttr.in` API.

The same `WeatherReporter` app runs behind four server shapes:

- `worker.ts`: Cloudflare Worker plus a Durable Object, using `captun/server`.
- `bun.ts`: `Bun.serve`, using `captun/bun`.
- `deno.ts`: `Deno.serve`, using `captun/deno`.
- `node.ts`: Node `http` plus `ws`, using `captun/node`.

## Run Locally

From the repository root, install once:

```sh
pnpm install
```

Then run the example test from this directory:

```sh
pnpm test
```

The test starts a Miniflare Worker for the Cloudflare case, and starts Bun,
Deno, and Node servers in subprocesses for the runtime adapter cases.

To run one runtime directly from the repository root:

```sh
pnpm exec vitest run examples/weather-reporter/bun.e2e.test.ts
pnpm exec vitest run examples/weather-reporter/deno.e2e.test.ts
pnpm exec vitest run examples/weather-reporter/node.e2e.test.ts
```

The Cloudflare test starts a Miniflare Worker automatically when `WEATHER_REPORTER_URL` is not set.
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

The tests await `createCaptunTunnel()` at each server's `/__intercept-egress-traffic` route, mock the `wttr.in` response, then call `/weather?city=london` and `/weather?city=paris`.
