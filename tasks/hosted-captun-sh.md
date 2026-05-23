---
status: initial-hosted-deployed
size: medium
---

# Hosted captun.sh

Status summary: Initial hosted deployment is live on `captun.sh`. The CLI, library, and browser landing-page demo can create hosted random tunnels; the main missing work is a proper free/paid control plane, deeper resource caps, and observability.

## Initial public-hosted slice

- [x] Default unconfigured CLI usage to the hosted server so `npx captun 3000` uses a random `https://<name>.captun.sh` URL. _`resolveTunnel` now falls back to `HOSTED_CAPTUN_SERVER_URL` when no config or `--server-url` is present._
- [x] Let library users call `createCaptunTunnel({ fetch })` without passing a deployed Worker URL. _`createCaptunTunnel` now derives a cryptographic random hosted URL and returns it on `tunnel.url`._
- [x] Add public-hosted e2e coverage for the library API and CLI router. _Added gated `CAPTUN_PUBLIC_E2E=1` tests in `test/public-hosted.test.ts`, plus local Miniflare coverage for the new server-url path._
- [x] Deploy the initial Worker route on `*.captun.sh/*`. _Deployed `captun-public` to Iterate prd with route `*.captun.sh/*`, `CUSTOM_HOSTNAME=captun.sh`, empty `CAPTUN_SECRET`, and wildcard DNS `*.captun.sh -> 100::` proxied._
- [x] Reserve product/control-plane subdomains on hosted `captun.sh`. _The Worker now blocks `app`, `login`, `dash`, `dashboard`, `captun`, `tunnel`, and `iterate` before Durable Object dispatch._
- [x] Serve a dead-simple landing page on `www.captun.sh`. _The hosted Worker returns a static HTML string with CLI and API examples._
- [x] Redirect the apex domain to `www.captun.sh`. _Added apex DNS `captun.sh -> 100::` proxied and redeployed with route `captun.sh/*`; the Worker returns a 308 preserving path and query._
- [x] Add an in-browser tunnel demo to `www.captun.sh`. _The landing page serves `/captun.browser.js`, lets the user edit a fetch function, creates a hosted tunnel, and loads it in an iframe._

## Safety and product follow-up

- [ ] Use cryptographic random names for free hosted tunnels and keep friendly/custom subdomains behind auth or a paid reservation model.
- [x] Add per-session tunnel ownership: first client claims a tunnel name, the same token can reconnect, and a different token gets `409` instead of evicting the active tunnel. _The stacked hosted-ownership-tokens PR stores anonymous active-owner tokens in `CaptunServerShard` and sends generated connect tokens from CLI/API/browser clients._
- [ ] Add Cloudflare Rate Limiting bindings for cheap edge throttles on connect attempts and forwarded requests.
- [ ] Add Durable Object backed global-ish limits for active tunnels, concurrent tunnels per IP/account, and suspicious reconnect churn.
- [ ] Add basic resource caps: max tunnel lifetime, idle timeout, in-flight request cap, request body size limit, and response streaming guardrails.
- [ ] Add observability for rejected connects, `429`s, high-volume tunnel names, high-volume IPs, and top error classes.
- [ ] Document an emergency shutdown path for disabling hosted `captun.sh` without affecting self-hosted deployments.

## Implementation Notes

- 2026-05-23: User explicitly accepted an initial unsafe/obscure-only deploy: no rate limiting and anyone can still evict anyone. Keep the above follow-ups visible before publicising the domain.
- 2026-05-23: Public e2e passed against the live service with `CAPTUN_PUBLIC_E2E=1 pnpm vitest run test/public-hosted.test.ts`.
- 2026-05-23: Reserved names and `www.captun.sh` verified against the live Worker. Apex redirect verified with `curl --resolve` against Cloudflare's authoritative A record while local resolver propagation was still uneven.
- 2026-05-23: Browser demo deployed and manually verified with Playwriter. Clicking "create tunnel" produced a random `captun.sh` URL, and `curl` to that URL returned the browser-defined response.
