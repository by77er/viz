# High cardinality on the read path

What a metric with many series costs viz to store, count and query; where each limit bites;
what changed because of it; and what is left. Written 2026-11-19 from measurements on this
machine. Every number says what kind it is:

- **measured here, native**: `engine/query/examples/cardinality.rs`, the engine's own
  functions compiled for x86-64 (release), one thread. Not WASM, not Cloudflare.
- **measured here, local stack**: `query/test/cardinality.bench.ts`, the whole read path
  (edge, shards, ledger, flush, the query Worker, leaves) in workerd on this machine, R2 and
  Durable Objects simulated in one process. I/O is nearly free, so times say how much work
  is done, not how long it takes on Cloudflare.
- **modelled**: arithmetic from the counts above and figures measured on Cloudflare in the
  spikes, printed as ranges, each with the experiment that would settle it.

The machine is shared (4 cores, other engineers' builds): load average 4 to 7 during the
native runs (00:52 to 00:56 UTC) and 8 to 12 during the stack runs (00:59 to 01:13 UTC).
Read the times as rough; the counts, bytes and memory figures are exact for the workload.

## Conclusions

1. **Up to about 10,000 series per metric, nothing bites.** An hour of `sum by (job)` over
   10,000 series runs in one place: 650,000 samples, 31 MiB of WASM memory, 115 to 400 ms
   of engine time locally. The cardinality report, label values and single-series queries
   answer in 25 to 145 ms of engine time.
2. **At 100,000 series, four limits bite, three of them before the query is even looked at:**
   - **The unflushed tail.** Every query reads every shard's whole tail, and the tail
     counts against `maxFetchBytes` (16 MiB). Ten minutes of 100,000 series at 60 s is
     20.2 MB of tail, so **every query, label call and cardinality report of that tenant
     was refused** (422) until a flush, whatever its range or metric. In steady state the
     tail is about the tenant's shards times up to one 4 MiB seal each (modelled), so a
     tenant spread over more than four to eight shards is refused all the time.
   - **Single-series reads.** Files are pruned by metric name and time only. One series of
     a 100,000-series metric over an hour has a scan bound of 6.6 M samples (every row of
     the metric), above `maxScanSamples` (3 M): `rate(m{instance="x"}[5m])` is refused.
     Wrapped in `sum(…)` it splits and answers, by reading every file seven times to
     return 65 samples.
   - **Label values and series lookups** (Grafana's variables) go through the same scan
     bound and are refused at 100,000 series over an hour.
   - **Aggregations were refused by `max_series`** because leaves were counted by samples
     only. **Fixed here (D31):** leaves are now counted by series too, from the series
     files, before any fetch. `sum by (job)` over 100,000 series now answers on 7 leaves
     (76 MiB peak per leaf); the counterfactual on the same data is below.
3. **At 1,000,000 series an aggregation over the whole metric is refused by design**
   (`maxQuerySeries` 640,000; 67 leaves would be needed at 15,000 series each), and what it
   would cost is dominated by reading: each of 32 parts decodes every row of every file
   (37 s of reader CPU natively for ten minutes of data). **The cardinality report was not
   protected by its caps:** natively its merge reached 288 MiB before the pair cap refused
   it, past a 128 MB isolate. **Fixed here (D32):** the pair cap is now 400,000 (about
   52 MiB at the merge, measured in WASM) and the report is counted over leaves above
   50,000 series.
4. **Sketches**: the write path already uses them for admission (HyperLogLog and a Bloom
   filter, D21). The read path counts exactly, and that is the right default for a report
   people act on; the next step for wide windows is a streaming merge (exact, about 30 MiB
   instead of 280 MiB at a million unique values), and only after that HyperLogLog and
   heavy-hitter sketches, labelled approximate (D32).

## How viz handles cardinality, stage by stage

| Stage | What bounds cardinality | Kind |
|---|---|---|
| Ingest (edge) | at most 100,000 series and 500,000 samples per request | limit (edge) |
| Admission (shard) | the active-series limit: an even share per shard, exact up to 4,096 series per half-hour bucket, HyperLogLog (1.6 % standard error) and a Bloom filter above (D21) | sketch |
| Identity | `series_id` is a 64-bit hash of the labels; collisions are a probability (D19) | |
| Storage | `metric_series`: one row per series per file, 22 to 23 bytes a series (measured here, native); `metric_samples`: 3.7 to 3.8 bytes a sample; row groups of at most 100,000 rows sorted by (metric, `series_id`); index fragments with time and name ranges | measured here |
| Planning | files pruned by time and `__name__` only; `maxScanSamples` 3 M (one place), `maxQueryScanSamples` 100 M (split), from the ledger's row counts before any fetch; the series estimate from the series files (new) | limit |
| One place | `maxSeries` 20,000, `maxSamples` 2 M, `maxStepPoints` 1 M, `maxFetchBytes` 16 MiB (files and the whole tail) | limit |
| Split | leaves by samples and by series, at most 32; `maxQuerySeries` 640,000, `maxQuerySamples` 64 M | limit |
| Label endpoints | load samples (no series-only read yet): bounded like a query | limit |
| Cardinality report | exact, from series files and tail series tables; `maxCardinalitySeries` 1 M, `maxCardinalityPairs` 400,000 (was 2 M); over leaves above 50,000 series (new) | exact, capped |

## What it costs: 10,000, 100,000 and 1,000,000 series

Workload: `…_requests_total{job, instance}` (plus `code` natively), 20 jobs, one `instance`
per series, counters scraped every 60 s. Native: one ten-minute flush unit, series spread
over shards of 125,000. Local stack: 1 h 5 min through edge on 2 shards, flushed in
ten-minute units.

### Storage (measured here, native)

| | 10,000 | 100,000 | 1,000,000 |
|---|---:|---:|---:|
| sample files, one ten-minute unit | 0.36 MiB (3.82 B a sample) | 3.59 MiB (3.76 B) | 34.9 MiB (3.66 B) |
| series files, one unit | 0.21 MiB (22.1 B a series) | 2.19 MiB (23.0 B) | 22.0 MiB (23.0 B) |
| unflushed tail, ten minutes (local stack) | 1.92 MiB | 20.2 MB | about 200 MB (modelled: 20 B a sample) |

A series costs a `metric_series` row in **every** flush file it appears in: a day of
ten-minute units holds a 1,000,000-series metric's labels 144 times (3.2 GB a day before
compaction; modelled from the per-unit size).

### The cardinality report

| | 10,000 | 100,000 | 1,000,000 |
|---|---|---|---|
| native, one place, one unit | 14 ms, 3.6 MiB heap | 179 to 195 ms, 34.3 MiB | **refused** (`max_pairs`, 2 M then) after 3.1 s and 319 MiB; caps lifted 3.1 s, 369 MiB |
| native, merge at the coordinator | 8 parts: 15 ms, 2.7 MiB | 8 parts: 415 ms, 22.6 MiB; 32 parts: 780 ms, 21.7 MiB | 8 parts: 5.3 s, 288 MiB; 32 parts: 18.6 s, 280 MiB, then refused |
| native, per part (each reads every series file) | 8 parts: 3 ms | 8 parts: 49 ms; 32: 26 ms (680 ms all parts) | 8 parts: 553 ms, 58.5 MiB; 32: 319 ms, 40.9 MiB (7.5 s all parts) |
| local stack, an hour, one place | 66 to 144 ms engine, 6.8 to 8.6 MiB WASM | 658 ms engine, **51.9 MiB WASM** | not run (over the 1.5 GB a process may use here) |
| local stack, an hour, 8 leaves | coordinator 4.4 MiB | **coordinator 25.9 MiB** for about 200,000 pairs and triples | |
| modelled production, an hour | 0.1 to 0.4 s | 0.6 to 2.0 s | **refused** by `maxCardinalityPairs` (now 400,000) at the merge, after 20 leaves (50,000 series each) have read every series file of the hour: 2 to 16 s (about 2 s natively per part, x 1 to 8) |

What the table says: memory is set by distinct pairs and triples, not by samples; at the
coordinator about 130 bytes each in WASM (115 to 147 natively). The merge time grows with
the number of parts (it rebuilds its hash maps per part), which the streaming merge would
also fix. Over leaves the whole tail goes to every leaf (15.6 MiB of RPC for a 1.9 MiB tail
at 10,000 series over 8 leaves); cutting it by part as queries do is a small change, not made.

Modelled production: engine time x 2 (spike S2), plus a ledger read (2 x 10 to 70 ms plus
25 to 40 µs a file, S4), a tail read (10 to 70 ms) and, over leaves, one Durable Object call
(10 to 70 ms) and one round of file reads (55 to 203 ms, S1). **Experiment that settles it:**
the report over an hour of a 100,000-series tenant on Cloudflare, one place and over 8
leaves, cold and warm (`design/VERIFICATION.md` S1 extended with this Worker).

### `sum by (job)(rate(m[5m]))`

| | 10,000 | 100,000 | 1,000,000 |
|---|---|---|---|
| native, ten minutes, one place, default limits | 34 ms, 11.2 MiB | **refused** (`max_series`) after 319 ms and 86.8 MiB | refused after 6.4 s and 694 MiB |
| native, the same split | 2 parts: reader 26 ms, leaf 12 ms | 7 parts: readers 170 ms a call (1.07 s all), leaf 46 ms and 22.8 MiB, extracts 26 MiB; identical to one place | 32 parts: every leaf stopped at its series share (refused: `maxQuerySeries`); readers 701 ms a call, **37 s all**, extracts 262 MiB |
| the rule before (samples only) | one place | one place, refused | 7 leaves, refused |
| the rule now (samples and series) | one place | 7 leaves | 67 needed, capped at 32: refused |
| local stack, one hour, everything flushed | one place: 115 to 400 ms engine, 31 MiB | **7 leaves, 200**: 6.5 M samples, 80 files (29.9 MiB) read by every leaf's readers (98 calls), 179 MiB of extracts, 76 MiB peak per leaf | not run |
| local stack, one hour, ten minutes in the tails | one place, as above | **422 `max_fetch_bytes`**: the 20.2 MB tail | not run |
| modelled production, one hour | 0.3 to 1.0 s | 1 to 4.5 s (warm leaves) | refused in 0.1 to 0.3 s from the ledger and the leaves' first counts |

**The counterfactual** (local stack, 100,000 series, everything flushed): the same bench,
the same data generator, with `query/src` as at commit 09f601d (before this work) in a
scratch tree, run after the new code, both at a load average of 9 to 12.

| query | before (samples only) | now (samples and series) |
|---|---|---|
| `sum by (job)`, 1 h | 5 leaves; every leaf stopped at its share, run again, **refused** (`max_samples`: "one leaf's part holds more than one isolate may load … unevenly spread") after 24 to 26 s; 140 reader calls, 357 MiB of extracts | **7 leaves, 200**: 98 reader calls, 179 MiB of extracts, 76 MiB peak per leaf, 15 to 20 s locally with the leaves in series |
| `sum by (job)`, 10 min | 2 leaves, **refused** (`max_series`: at least 62,826 series loaded, the limit is 40,000) after 3.5 to 4.4 s | **7 leaves, 200**, 3.9 to 5.2 s locally |
| `sum(rate(m{instance="x"}[5m]))`, 1 h | 5 leaves, 70 reader calls | 7 leaves, **98 reader calls** (worse: the estimate counts the metric's series, not the matched one) |
| the other calls of the table | identical outcomes (the cardinality report took 852 ms one place, 52.0 MiB) | identical outcomes |

Where both answer (10,000 series, every query), the bodies are byte-identical. The new
rule is worse for selective aggregations over a high-cardinality metric: it splits them by
the metric's series although few match. Series-level pruning ("What is left", 2) removes
both costs.

Modelled production for 100,000 series: ledger 22 to 143 ms, tail 10 to 70 ms, one DO call
to each leaf, then each leaf's 14 reader calls at once: 1 to 4 rounds of 55 to 203 ms (1 if
calls to one object get their own six connections, 98 / 32 if they share; unmeasured), and
CPU on the critical path of 2 x (one leaf's own engine plus its longest reader call): 2 x
(0.3 to 1.0 s): a leaf's own evaluation about 0.3 s and its longest reader call about 0.1 s
natively for this hour, scaled to WASM by the local stack's ratio (0.6
to 2, see "Native and WASM"), so 1 to 4.5 s in all. **Experiment that settles it:** the same query on Cloudflare
with a 100,000-series tenant, warm and cold leaves, recording per-leaf CPU and whether one
object's reader calls queue behind six connections.

### One series of a high-cardinality metric, and the label endpoints

| | 10,000 | 100,000 | 1,000,000 |
|---|---|---|---|
| `rate(m{instance="x"}[5m])`, 1 h (local stack) | 200: 65 samples loaded, all 24 to 28 files (2.6 to 3.0 MiB) read, 24 to 72 ms engine | **422 `max_scan_samples`** (6.6 M > 3 M) | refused (modelled: 60 M) |
| `sum(rate(m{instance="x"}[5m]))`, 1 h | 200 in one place | 200 over 7 leaves: 80 files read 7 times (98 reader calls) for 65 samples | refused: scan bound 60 M is under `maxQueryScanSamples` but the series estimate asks for 67 leaves; 32 leaves would each decode every row |
| `/label/instance/values?match[]=m`, 1 h | 200: 107 to 113 ms engine, 20 to 22 MiB, 183 KB | **422 `max_scan_samples`** | refused |
| `/series?match[]=m{instance="x"}`, 1 h | 200 | **422 `max_scan_samples`** | refused |
| native, label values over one unit | 30 ms, 11 MiB | refused (`max_series`) after 301 ms and 87 MiB | refused after 5.1 s and 694 MiB |

Grafana's variable queries (`label_values(m, instance)`) therefore stop working somewhere
between 10,000 and 100,000 series per metric over an hour. The fix is a series-only read
(below), which costs what the cardinality report costs: about 0.66 s of engine time and
52 MiB for 100,000 series over an hour, locally.

### Native and WASM

The same 10,000-series, ten-minute aggregation took 31 to 34 ms natively and 49 to 135 ms
of engine time in the local stack (WASM in workerd, including the copy of the files into
linear memory); the hour took 115 to 400 ms against about 220 ms natively (the ten-minute
figure scaled by the samples loaded). So WASM in workerd ran at 0.6 to 4 times native here,
at load averages of 4 to 12: too noisy to be one number. The spikes measured engine CPU on
Cloudflare at about twice the local workerd time (S2), so modelled Cloudflare CPU is native
x 1 to 8. **Experiment that settles it:** `engine/query/examples/cardinality.rs`'s
calls through `engine/wasm-query` in a Worker on Cloudflare, one call per request.

## What changed in this work

- **Leaves counted by series as well as samples** (`splitAboveSeries` 15,000; `leafCount`,
  `seriesEstimate` in `src/coordinator.ts`; D31). The estimate is computed from the series
  files' row groups before anything is fetched and reported as `X-Viz-Series-Estimate`. It
  was 10,000 at 10,000 series and 100,002 at 100,000 (local stack).
- **`/api/v1/plan`**: what a query would read and how it would run, from one ledger read
  (the MCP server's `validate_query` asked for it).
- **The cardinality report** is counted over leaves above `cardinalitySplitAboveSeries`
  (50,000) and its pair cap is 400,000 (was 2,000,000) (D32).

## What is left, in order of what it unblocks

1. **The tail** (`shard/`): a filtered, paged `tailRead` (time range, metric names, series
   key range), so a query reads only the tail it needs and split leaves fetch their own key
   range. Until then a high-volume tenant is refused whenever its unflushed bytes pass
   16 MiB. Interim, in `query/`: a separate, higher tail cap for split queries and the
   report (the coordinator holds only the tail there); not done, because 20 MB is already
   most of what one RPC message may carry (32 MiB).
2. **Series-level pruning** (`engine/storage`, `compact/`): resolve matchers against
   `metric_series` first, then read only the sample row groups (or pages) whose
   `series_id` range holds a match. Row groups are already sorted by (metric, `series_id`);
   they need page indexes or smaller row groups per metric. This unblocks single-series
   reads and makes split parts read only their key range (the `L`-fold read above).
3. **A series-only read for the label endpoints** (`engine/query`: `catalog` already reads
   `metric_series` for the report): label names, values and series from series files and
   tail series tables, never samples. "In the range" would then be decided per file, as
   Prometheus decides it per block.
4. **A streaming merge for the cardinality report**: parts send pairs sorted by (label,
   value); the coordinator merges them in one pass. Then the pair cap can rise to millions.
5. **Sketches, labelled approximate**, only for windows beyond the caps.

## Reproduce

```
cd engine/query && CARGO_TARGET_DIR=$PWD/target cargo run --release --example cardinality -- 10000 100000 1000000
cd query && npm run measure -- test/cardinality.bench.ts
```

The native run peaks at about 1.0 GB of RSS (1,000,000 series; one place with the limits
lifted is skipped above 200,000 series to stay under 1.5 GB). The stack run peaks at about
1.1 GB of workerd RSS and takes about 3 minutes.
