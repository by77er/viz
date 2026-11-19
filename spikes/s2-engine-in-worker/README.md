# Spike S2: the engine in a real Worker

The engine-language decision (D5) rested on a sandbox benchmark (`bench/README.md`) with two
open questions: billed CPU on Cloudflare, and behaviour at the 128 MB limit.

## What is deployed

Worker `viz-spike-s2-engine` (workers.dev): the benchmark's Rust/WASM core (Arrow reader,
SIMD) and its JavaScript counterpart, each running the benchmark's two queries over a
Parquet file sent as the request body. Endpoints need the `x-key` header (a Worker secret).
**Deleted 2026-11-19 02:09 UTC** (Worker), with the commands below; the account's Workers and R2 buckets were listed afterwards and hold nothing of this spike. The results below stand.

Nothing runs on a timer. Remove with `npx wrangler delete --name viz-spike-s2-engine`.

`src/vizcore.wasm` (3.6 MB) is the exact binary that was measured, kept so a rerun measures
the same code: the benchmark core built in `bench/core` with
`RUSTFLAGS="-C target-feature=+simd128,+bulk-memory" cargo build --release --target
wasm32-unknown-unknown --features arrow` (`bench/README.md`, "Reproduce") and copied here
unchanged. Rebuilding gives an equivalent module; a byte-identical one needs the same Rust
toolchain.

## Result

Measured on Cloudflare on 2026-11-18. CPU time is the per-request figure from Cloudflare's
analytics API (median of 20–30 requests, each workload in its own two-minute window). Both
engines returned the same sums as in the sandbox.

| Workload | Billed CPU, median | Minus receiving the body | Sandbox (wall) |
|---|---|---|---|
| Receive the 10 MB body, do nothing | 10.8 ms | | |
| Rust, one metric (1 row group) | 19.5 ms | **8.7 ms** | 4.8 ms |
| Rust, all counters (full scan) | 80.7 ms | **70 ms** | 32 ms |
| JS, one metric | 168.9 ms | **158 ms** | 37 ms |
| JS, all counters | 708.6 ms | **698 ms** | 291 ms |
| Rust, full scan, PLAIN-encoded file (21 MB body) | 116.8 ms | about 95 ms | 45 ms |
| JS, full scan, PLAIN-encoded file (7 requests) | 670.8 ms | about 650 ms | 178 ms |

- Rust is about **18× cheaper on the selective query and 10× on the full scan** in billed
  CPU. In the sandbox the ratios were 7.7× and 9×.
- Production CPU is roughly 2× the sandbox's wall time for Rust and 2.4–4× for JS.
- 99th percentiles are 3–7× the median for both (132 ms and 297 ms for the two Rust
  queries); the first requests in each window include compilation.

### Memory

Requests that grow memory to N MiB and touch every page, one request each, tried twice:

| | 64–224 MiB | 240 MiB | 256 MiB |
|---|---|---|---|
| WASM linear memory | succeeded | failed once, succeeded once | failed |
| JS `Uint8Array`s | succeeded | succeeded | failed |

Analytics recorded three requests in that period as `exceededMemory`. So the 128 MB limit
is not enforced at the moment of allocation: a short-lived request can overshoot it by a
wide margin, and enforcement happens later or at a higher threshold. This is **not** a
budget to design to: the documented limit is 128 MB, an isolate serves many requests, and
exceeding it can end other requests in the same isolate.

## Conclusions

1. **D5 stands, with more margin than the sandbox suggested.** At $0.02 per million CPU-ms,
   a full scan of 1.92M samples costs about $1.40 per million queries in Rust and about
   $14 in JS.
2. **Use 2× as the sandbox-to-production CPU factor** for Rust when modelling cost.
3. **Design to 128 MB anyway**; treat overshoot as something that will not instantly fail
   but may.

## Not measured

A zstd build; the full engine (storage + PromQL) rather than the benchmark core; sustained
load, where one isolate holds memory across requests; colos other than the one that served
these requests.
