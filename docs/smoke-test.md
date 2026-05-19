# Captun smoke test

Step-by-step checks for `npx captun deploy` and `npx captun <port>`. Each step is a small script you can run alone, so nothing blocks waiting on tmux panes.

## Prerequisites

```bash
pnpm install
```

Optional for **remote** deploy/tunnel: `wrangler login` or `CLOUDFLARE_API_TOKEN`.

## Run one step

```bash
./scripts/smoke-test.sh list
./scripts/smoke-test.sh step-0-build
```

Logs and PIDs: `/tmp/captun-smoke/` (override with `CAPTUN_SMOKE_DIR`).

## Local path (no Cloudflare account needed)

| Step | Command | What it proves |
|------|---------|----------------|
| 0 | `./scripts/smoke-test.sh step-0-build` | CLI builds |
| 1 | `./scripts/smoke-test.sh step-1-deploy-dry-run-workers` | `captun deploy --dry-run` (workers.dev) |
| 2 | `./scripts/smoke-test.sh step-2-deploy-dry-run-wildcard` | `captun deploy --dry-run --route '*.tunnels.example.com/*'` |
| 3 | `./scripts/smoke-test.sh step-3-wrangler-dev` | Local Worker on `:8787` (background) |
| 4 | `./scripts/smoke-test.sh step-4-http-origin` | Local app on `:3456` (background) |
| 5 | `./scripts/smoke-test.sh step-5-tunnel-local` | `captun 3456` + `curl` through wrangler dev |
| stop | `./scripts/smoke-test.sh stop` | Kills background processes |

All local steps:

```bash
./scripts/smoke-test.sh
```

## Remote path (real deploy + tunnel)

### A. workers.dev deploy

```bash
pnpm run build
npx captun deploy
```

The CLI writes `serverUrl` and `secret` to `~/.config/captun/config.json` automatically.

Non-interactive:

```bash
npx captun deploy --secret "$(openssl rand -base64 32 | tr -d '\n=' | tr '/+' '_-')"
```

Requires `CLOUDFLARE_API_TOKEN` or prior `wrangler login`.

### B. Wildcard route deploy

```bash
npx captun deploy --route '*.tunnels.yourdomain.com/*' --zone yourdomain.com --secret "$SECRET"
```

Config `serverUrl` becomes `https://{name}.tunnels.yourdomain.com`.

### C. Tunnel port 3000

After deploy, config is enough:

```bash
python3 -m http.server 3000   # terminal 1
npx captun 3000 --name demo   # terminal 2 (reads ~/.config/captun/config.json)
curl -i "$(jq -r .serverUrl ~/.config/captun/config.json)demo/"
```

Or step **6** against an existing Worker:

```bash
export SMOKE_SERVER_URL='https://captun.<account>.workers.dev'
export CAPTUN_SECRET='<secret-if-set>'
./scripts/smoke-test.sh step-6-tunnel-remote
```

Wildcard:

```bash
export SMOKE_SERVER_URL='https://{name}.tunnels.templestein.com'
export CAPTUN_SECRET='...'
./scripts/smoke-test.sh step-6-tunnel-remote
curl -i "https://smoke-test.tunnels.templestein.com/"
```

## Why the old script felt stuck

- One script waited on **tmux pane** text; wrangler output often landed in a different window than `capture-pane` read.
- `deploy` had `.meta({ prompt: true })`, which **forced** prompts even when flags were passed.

Fixes in `src/bin.ts`:

- Deploy has no forced `prompt: true`.
- `deploy --dry-run` skips upload and config write.

## templestein.com (personal account)

```bash
pnpm run build

# Doppler: os / dev_jonas, personal account
doppler run -p os -c dev_jonas -- sh -c '
  export CLOUDFLARE_ACCOUNT_ID=05958bb7b57a2ac7eb5d3906fd3cf8bb
  npx captun deploy \
    --route "*.tunnels.templestein.com/*" \
    --zone templestein.com \
    --secret "$(openssl rand -base64 32 | tr -d "\n=" | tr "/+" "_-")"
'

# Terminal 1
python3 -m http.server 3000

# Terminal 2 (reads ~/.config/captun/config.json)
npx captun 3000 --name banana

# Verify
curl https://banana.tunnels.templestein.com/
```

**Proved 2026-05-18:** deploy to `*.tunnels.templestein.com/*`, tunnel `banana` → local `:3000`, `curl` returned `200` with body `<h1>banana tunnel works</h1>`. Secret stored in `~/.config/captun/config.json` and set as Worker `CAPTUN_SECRET`.

`--zone` is required when Wrangler cannot infer the zone from the route pattern alone.

## Recorded results (2026-05-18)

| Step | Result |
|------|--------|
| step-0 build | PASS |
| step-1 workers.dev dry-run | PASS (~1s) |
| step-2 wildcard dry-run | PASS (~1s) |
| step-3 wrangler dev | PASS (~10s) |
| step-4 http origin | PASS |
| step-5 local tunnel + curl | PASS (`curl http://127.0.0.1:8787/smoke-test/` → 200) |
| templestein deploy + banana tunnel | PASS |
