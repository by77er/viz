# Spike S8, second half: commits to Cloudflare's managed Iceberg catalog from a Worker

Decides whether managed-catalog publication ships or viz stays R2-native
(`design/VERIFICATION.md` §4, S8; `design/DECISIONS.md` D2, D4). The first half (R2-native
metadata read back by DuckDB and PyIceberg) is in `publisher/README.md`.

Status: in progress (2026-11-19). Results are filled in below as they are measured.

## Worst-case cost (stated before anything was deployed)

Everything is named `viz-spike-s8-*`. Nothing runs on a timer: every operation is started by
a request from the driver on this machine, and every endpoint bounds its own work (at most
16 committers, 20 commits each, 50 commits per latency batch, 40 unknown-outcome trials per
call).

| Item | Planned | Worst case allowed by the code and the plan | Price | Worst-case cost |
|---|---|---|---|---|
| Catalog operations (every Iceberg REST request is billed) | about 5,000 | 30,000 | 1M/month included, then $9.00/M | $0.27 if the allowance were already used, else $0 |
| R2 Class A (put, list) | about 3,000 | 20,000 | $4.50/M | $0.09 |
| R2 Class B (get, head) | about 5,000 | 30,000 | $0.36/M | $0.01 |
| R2 storage | under 5 MB for under a day | 50 MB for a month | $0.015/GB-month | under $0.01 |
| Workers and Durable Object requests and duration | about 2,000 requests, under 1,000 GB-s | 20,000 requests, 10,000 GB-s | Workers Paid allowances; $0.30/M requests, $12.50/M GB-s | $0.13 |
| Compaction, snapshot expiration | off (D3a) | off | $0.005/GB, $2/M objects | $0 |

**Worst case: under $1**, and $0 beyond the plan's included allowances if they are not
already used up. Prices from developers.cloudflare.com/basin-catalog/platform/pricing/ and
developers.cloudflare.com/r2/pricing/ as read on 2026-11-19.
