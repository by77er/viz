# Engine benchmark: Rust compiled to WASM vs JavaScript

Question (design decision D5): should the engine core be Rust compiled to WASM, or
JavaScript/TypeScript on the pure-JS Parquet libraries? Both sides implement the same two
workloads, read each other's files, and must return the same answer.

Run on 2026-11-18 in a 4-vCPU Linux sandbox with Node 22.23 and local `workerd` (wrangler
4.164). This is not Cloudflare production hardware and nothing here measures billed CPU.

## Setup

- **Data:** 1,920,000 synthetic samples (20 metrics × 100 series × 960 points at 15 s), sorted
  by metric, series, time. 53.8 MB as raw columns. Half the metrics are counters with resets.
- **File:** four columns (`metric_name`, `series_id`, `ts`, `value`), 240,000-row row groups,
  256 KB pages, snappy; dictionary for names, delta encoding for the two int64 columns,
  byte-stream-split for values. Same settings on both sides.
- **Workloads**
  - `encode`: columns in memory → Parquet bytes.
  - `q1`: `sum(rate(one_metric[5m]))` at 60 s steps (96,000 of 1.92M rows match; row groups
    pruned by statistics, so one 240,000-row group is decoded).
  - `q2`: the same over every counter metric (960,000 rows match; all eight groups decoded).
- **Rust:** `parquet` crate 60.1, built for `wasm32-unknown-unknown`, release, fat LTO.
- **JS:** `hyparquet` 1.33 and `hyparquet-writer` 0.18.
- **Check:** every run prints the sum of the result vector. All variants, on all files, agree
  to 12 significant digits (`14796.1513880` for q1, `148812.341090` for q2).

## Result

Median of warm iterations, Node, each side on the file it wrote.

| Workload | JS, tuned | Rust/WASM, tuned | Ratio |
|---|---|---|---|
| encode 1.92M rows | 1,030 ms | 240 ms | 4.3× |
| q1 (one metric) | 37 ms | 4.8 ms | 7.7× |
| q2 (all counters) | 291 ms | 32 ms | 9.0× |

Inside local `workerd`, compute time measured in the Worker: q1 7 ms vs 28 ms; q2 about 50 ms
vs about 210 ms (single samples, noisier; same direction, about 4×).

| | JS | Rust/WASM |
|---|---|---|
| Code size, raw / gzip | 241 KB / 113 KB | 3.6 MB / 0.80 MB (Arrow reader); 1.2 MB / 0.35 MB (low-level reader) |
| Instantiate or import | 27–45 ms (module import, Node) | 3–9 ms (WASM instantiate, Node) |
| Memory during a query | process peak RSS 110–130 MB above an idle baseline | 18–20 MB of WASM linear memory, including the 10 MB file copy |

## Hill-climb log

Each row changes one thing. Times are warm medians in Node.

| Step | q1 | q2 | Notes |
|---|---|---|---|
| **JS** naive: BigInt arithmetic as the library returns it | 61 ms | 549 ms | |
| JS tuned: view int64 columns as 32-bit words, no BigInt on the hot path | 38 ms | 322 ms | 1.7× |
| JS + WASM snappy codec | 35 ms | 290 ms | within noise; decompression is not the bottleneck |
| JS on a file with PLAIN encodings (counterfactual: cheapest for JS to decode) | 25 ms | 178 ms | file doubles to 20.4 MB |
| **Rust** low-level column readers | 9.4 ms | 73 ms | 1.2 MB WASM |
| Rust Arrow reader, metric name kept dictionary-encoded | 7.1 ms | 51 ms | 3.7 MB WASM; profiling showed 70% of time was building one string per row |
| Rust + WASM SIMD | 4.8 ms | 32 ms | |
| Rust + `wasm-opt -O3` | 7.9 ms | 35 ms | 14% smaller, not faster; not adopted |
| Rust (SIMD build) on the PLAIN-encoded file | 10 ms | 45 ms | still 4× ahead of JS on JS's best-case file |

Per-column decode of all 1.92M rows, which explains the gap:

| Column | JS | Rust (native build) |
|---|---|---|
| `metric_name` (dictionary) | 19 ms | 51 ms as per-row strings; avoided entirely by the dictionary path |
| `series_id` (delta int64) | 33 ms | 1.7 ms |
| `ts` (delta int64) | 67 ms | 3.9 ms |
| `value` (byte-stream-split double) | 62 ms | 14.6 ms |

JavaScript has no fast 64-bit integer, so delta decoding of int64 columns runs through BigInt.
That is a property of the language, not of how the library was called.

## What this does and does not show

Shows:
- On these workloads the Rust core is 4–9× faster and uses far less memory per query, and
  the advantage survives giving JS its most favourable file encoding.
- The WASM module instantiates in single-digit milliseconds and is well inside the Worker
  size limit, so the size and startup worry in the design did not materialise at this scope.
- The two implementations read each other's files and agree, so the comparison is on equal
  data.

Does not show:
- **Billed CPU on Cloudflare.** Sandbox wall time only.
- **Behaviour under the real 128 MB isolate limit.** Local `workerd` does not enforce it. The
  JS memory figure is process RSS, which overstates live heap; a constrained isolate would
  collect more aggressively. It is a warning sign for 240,000-row groups in JS, not a proof.
- **zstd.** Both sides used snappy because the Rust zstd bindings need a C toolchain for
  WASM. The design specifies zstd; that build is untested.
- **The size of a full engine.** This core has one hard-coded query. A PromQL parser,
  planner and function library will add to the 3.6 MB.
- **A hand-written JS decoder.** The JS side used the libraries as published. A custom
  decoder that avoids BigInt could narrow the int64 gap; I did not write one.
- **Whole-segment encode in an isolate.** Encoding all 1.92M rows at once took 94 MB of WASM
  memory. Segments must be far smaller than this, as the design already requires.

## Reproduce

```
npm install
rustup target add wasm32-unknown-unknown
node gen.mjs
(cd core && RUSTFLAGS="-C target-feature=+simd128,+bulk-memory" \
   cargo build --release --target wasm32-unknown-unknown --features arrow)
W=core/target/wasm32-unknown-unknown/release/vizcore.wasm
node run.mjs rust encode 5 $W && node run.mjs js encode 5
for q in q1 q2; do node run.mjs rust $q 11 $W; node run.mjs js $q 11; done
```

`run.mjs <rust|js|js-naive|js-wasm-codec|noop> <encode|q1|q2> [iters] [wasm] [parquet]`
prints cold, median and minimum times, peak RSS, WASM memory and the result checksum.
`worker/` holds the `workerd` harness; `prof.mjs` and `core/src/bin/prof.rs` give the
per-column timings; `plainfile.mjs` writes the PLAIN-encoded counterfactual file.
