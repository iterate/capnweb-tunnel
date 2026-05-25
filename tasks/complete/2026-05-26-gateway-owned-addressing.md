---
status: complete
size: large
---

# Gateway-Owned Addressing Refactor

Status summary: Complete on #16. The API, Worker connect protocol, CLI/deploy config, hosted browser module, README, and tests now use gateway-owned addressing; #20 has been closed as superseded.

## Checklist

- [x] Replace public `url`/`serverUrl`/`secret` options with `gateway`/`token`. _`createCaptunTunnel`, the CLI router, config file, deploy wizard, benchmarks, and smoke scripts now take `gateway` and `token`; the hosted service remains the default gateway._
- [x] Replace `/__captun-connect` with Captun query parameters on the Gateway URL. _Clients now open the gateway URL with `captun-connect=1`, `captun-name`, and optional `captun-token`; the Worker no longer treats the old path as a connect route._
- [x] Make the Tunnel Gateway return `{ url, token }` through the internal Cap'n Web ready callback before `createCaptunTunnel` resolves. _`createCaptunTunnel` waits for `ready(...)`, and the Worker calls it after storing the active tunnel._
- [x] Rename low-level accept APIs to `acceptFetcherCapability` and `acceptFetcherCapabilityFromSocket`. _The public entrypoint and weather-reporter example now use Fetcher Capability/Fetcher Stub terminology._
- [x] Update the Cloudflare Tunnel Gateway to store active Tunnels backed by Fetcher Stubs. _`CaptunServerShard` stores `{ url, token, fetcher }` ActiveTunnel records and forwards through the Fetcher Stub._
- [x] Update CLI config, flags, deploy summary, and self-test to use `gateway` and `token`. _`--gateway`, `--token`, `CAPTUN_TOKEN`, deploy dry-runs, config writes, and post-deploy self-test all use the new names._
- [x] Update README, Hosted Site snippets, and tests to use the new shape. _README, `www.captun.sh` snippets, the browser helper, e2e tests, worker tests, public-hosted tests, and smoke docs now describe gateway-owned tunnel URLs._
- [x] Close or supersede PR #20 after #16 has the new shape. _Closed #20 with a note that hosted safety/rate-limit work should be rebuilt on top of #16's gateway/token/connect-query protocol._

## Implementation Notes

- 2026-05-26: Grill-with-docs resolved the language in `CONTEXT.md` and recorded ADR-0001 for gateway-owned addressing.
- 2026-05-26: Focused tests passed: `pnpm exec vitest run test/worker.test.ts test/e2e.test.ts examples/weather-reporter/e2e.test.ts`.
- 2026-05-26: Full local checks passed: `pnpm run check`, `pnpm test`, and `pnpm run build`.
- 2026-05-26: Pushed #16 and closed #20 as superseded.
