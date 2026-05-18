# Captun Benchmarks

These are pragmatic benchmark notes, not a formal benchmark suite. The goal is to keep the README readable while still showing what was measured and how to reproduce it.

The startup benchmark in [scripts/benchmark-startup.ts](../scripts/benchmark-startup.ts) measures from "start creating a tunnel" to the first successful public HTTP fetch through that tunnel:

```bash
CAPTUN_SERVER_URL=https://{name}.tunnels.example.com \
PROVIDERS=captun,ngrok,cloudflared \
COUNTS=1 \
OUT=docs/performance/captun-startup.json \
node scripts/benchmark-startup.ts
```

The stream benchmark in [scripts/benchmark-streams.ts](../scripts/benchmark-streams.ts) creates many named tunnels and fetches large responses through them:

```bash
CAPTUN_SERVER_URL=https://captun.example.workers.dev \
COUNTS=100 \
BYTES=2097152 \
OUT=docs/performance/captun-streams.json \
node scripts/benchmark-streams.ts
```

Recorded summary data lives in [docs/performance/captun-startup.json](./performance/captun-startup.json) and [docs/performance/captun-streams.json](./performance/captun-streams.json). Regenerate the SVG with:

```bash
node scripts/render-startup-chart.ts
```

## Results

Startup from London on May 18, 2026:

| Ad-hoc tunnel | First fetch |
| --- | ---: |
| Captun | 188ms |
| ngrok | 1.62s |
| cloudflared quick tunnel | 8.96s |

Captun concurrent startup:

| Simultaneous tunnels | Successful | p50 | p90 | p99 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 | 188ms | 188ms | 188ms |
| 10 | 10/10 | 172ms | 186ms | 189ms |
| 100 | 100/100 | 483ms | 518ms | 534ms |
| 500 | 500/500 | 1.87s | 1.93s | 1.97s |
| 1000 | 1000/1000 | 3.61s | 4.07s | 4.12s |

Large response throughput:

| Concurrent 2MiB streams | Shards | Successful | p50 | p90 | p99 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | 100/100 | 26.34s | 26.72s | 26.78s |
| 150 | 256, warmed | 150/150 | 9.76s | 13.17s | 18.05s |

The important conclusion is simple: a single Captun tunnel starts much faster than ad-hoc tunnel products in this benchmark shape, and sharding lets many large streams use more aggregate Durable Object throughput. The default remains one shard because it is simpler and usually faster for startup-heavy test traffic.
