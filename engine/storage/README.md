# viz-storage

The storage half of the viz engine as a Rust library: `VZB1` batches in, sorted Parquet
files out, reads that merge lake files with shard tails, and compaction merges.

No I/O, no async, no clock, no randomness. Every function is a pure function of the bytes
it is given, so it runs unchanged in WASM, natively and in a deterministic simulator.
Builds for the host and for `wasm32-unknown-unknown`.

```
CARGO_TARGET_DIR=$PWD/target cargo test -j 2 -- --test-threads 2           # 78 tests (19 in tests/otel.rs, 10 in tests/sigmerge.rs)
CARGO_TARGET_DIR=$PWD/target cargo build --release --target wasm32-unknown-unknown
node tools/hyparquet_check.mjs      # independent reader (after cargo test --test export)
cargo run --release --example independent -- DIR && python3 tools/independent_check.py DIR   # PyArrow and DuckDB
cargo run --release --example layout -- 10000 100000                       # the layout experiment (DECISIONS D41)
python3 tools/mutants.py [pruning]  # mutation check, on a scratch copy (never edits this tree)
```

## What is implemented

| API | What it does |
|---|---|
| `batch::decode`, `batch::encode`, `batch::series_id` | The `VZB1` format of `contracts/BATCH.md`. Decode borrows from the input, validates everything, and returns a precise `BatchError` (bad magic, truncated with the field name and sizes, series index out of range with the row, unsorted / duplicate labels, missing `__name__`, and more). It never panics. |
| `encode_segment(batches)` | Flush. Per UTC day present: one `metric_samples` file then one `metric_series` file, per `contracts/TABLES.md`. Sorted by `(metric_name, series_id, ts)`; later batch wins on duplicate `(series_id, ts)`; row groups of at most 100,000 rows; format-v2 pages, snappy, dictionary / DELTA_BINARY_PACKED / BYTE_STREAM_SPLIT, row-group statistics, declared sorting columns. Value bits are written untouched. |
| `EncodedFile` | `table`, `day`, `bytes`, `rows`, `min_ts`, `max_ts`, `index`. |
| `FileIndex` | The index fragment: `{"v":1,"rg":[{"rows","off","len","min_name","max_name","min_ts","max_ts"}]}`, one entry per row group. `FileIndex::from_json` parses it back. |
| `select(input, matchers, min_ts, max_ts)` | Resolves `=`, `!=`, `=~`, `!~` against series from the `metric_series` files and the tail batches' series tables, reads matching samples from the `metric_samples` files and the tail, and returns one time-ordered, de-duplicated stream per series, sorted by label set. Tail beats lake; later file / later batch beats earlier. Row groups are pruned by statistics. |
| `merge_files(table, inputs)` | Compaction of one tenant-day. Samples: streaming k-way merge (binary heap, one row group per input in memory). Series: union with `min_ts`/`max_ts` combined. Later inputs win. Rejects unsorted inputs and inputs spanning two days. |
| `merge_files_shared(table, &[Bytes], opts)` | The same merge over inputs the caller already holds as `Bytes`: no copy of the inputs, and the output buffer is pre-sized to the inputs' total so it does not double. Added for the WASM binding, where the copies were most of the memory (`engine/wasm/README.md`). |
| `*_with` variants | Same functions with `WriteOptions { max_row_group_rows, page_rows, column_index }` or `SelectOptions { prune_row_groups }`, used by tests and the layout experiment. The defaults are the contract's layout. |
| `RowGroupIndex::may_hold(name, sids)`, `::overlaps` | **Series-level pruning** (2026-11-19): whether a row group can hold a row of metric `name` with a `series_id` in `sids` (sorted inclusive intervals), exact for the sort order from the fragment's `sid` (first and last row's id) and name range; whether it overlaps a time range. |
| `FileIndex::byte_ranges(groups, gap)` | The byte ranges a reader fetches for those row groups: theirs and the footer region (`foot`), joined when less than `gap` apart; `None` for a fragment without `foot` (read the whole file). |
| `sparse::Source`, `sparse::encode`, `sparse::cut`, `sparse::reader` | **Reading part of a file**: a file held as the byte ranges a reader fetched, in a container (`VZS1`, `src/sparse.rs`) that every reader here accepts in place of a whole file. A row group whose `series_id` chunk is not held is skipped (the caller left it out); any other byte a read needs and does not have fails the read. Files open with their offset index, so a page a read does not need is passed over without being read. |

Design choices worth knowing:

- **Low-level Parquet reader, not Arrow.** `bench/README.md` found the Arrow reader faster
  because per-row metric-name strings dominated. `select` avoids that cost differently: it
  never decodes `metric_name` in sample files at all. Series are resolved to `series_id`
  first, and only `series_id`, then (if anything matches) `ts` and `value` are decoded.
  This keeps Arrow out of the binary (2.8 MB instead of the bench's 3.6 MB).
- **`regex`, not `regex-lite`.** Prometheus matchers are RE2 syntax, including Unicode
  classes, and are evaluated once per series, so on a high-cardinality tenant speed
  matters. Both crates are linear-time. Measured cost in the WASM probe: full `regex`
  2.78 MB (0.79 MB gzip); `regex` without `perf` 2.38 MB (0.67 MB); `regex` with neither
  Unicode nor `perf` 2.07 MB (0.58 MB). `regex-lite` was not measured; it should land
  slightly below the last figure. The 0.2 MB gzip was judged worth it; it is one line in `Cargo.toml` to change.
- **Regexes compile as `^(?s:...)$`**, which is what Prometheus does: fully anchored, and
  `.` matches newline.
- **Strict decoding (contracts v2).** Besides the checks below, `batch::decode` now also
  rejects a NUL byte in a label name or value, a name over 1,024 bytes, a value over 8,192
  bytes, more than 128 labels, and any row whose timestamp is outside
  0..253,402,300,799,999. These were not checked before; `BATCH.md` v2 states them as
  rules of the format, and because every entry point decodes through this function, no
  path can now produce a `day` that is not `YYYY-MM-DD`. The 1 MiB size cap is **not**
  checked here: it is a storage limit that `Shard.append` enforces, and tests and tools in
  this crate use larger batches.
- **Strict decoding.** Non-zero flags, reserved or padding bytes, trailing bytes, empty
  label names or values and invalid UTF-8 are errors. A consequence, tested: for every
  input that decodes, re-encoding gives the same bytes.
- **Sortedness of lake files is not trusted by `select`.** Samples are gathered per series
  in precedence order and stably sorted only if they are not already increasing.
  `merge_files` does rely on its inputs being sorted, so it checks and returns
  `Error::Unsorted`.
- **Series-level pruning (2026-11-19, `contracts/TABLES.md` "The index fragment",
  DECISIONS D41).** The layout is unchanged: the same batches give byte-identical Parquet
  (tested against files the 2026-11-18 writer wrote, `tests/golden/v1-2026-11-18`). The
  index fragment gains `"sid":[first,last]` per row group and `"foot":[offset,length]` per
  file. `select` decodes a row group's `series_id`, finds the runs of rows of the series it
  selected, and reads `ts` and `value` only for those runs (`pq::read_runs`): a page holding
  none of them is skipped by its offset-index location; with pruning off every row is read
  (the equivalence is tested). Measured layouts are in `examples/layout.rs` and D41.
- **Deterministic output.** Same input, same bytes, natively and in WASM (checked: the
  WASM build produced byte-for-byte the same total size, and a merge of several flushes
  is byte-identical to one flush of the same batches).

## Spans and logs (stage 1, 2026-11-19)

New modules; the metrics code and its outputs are untouched (the golden files of
`tests/golden/v1-2026-11-18` are still byte-identical). Contracts: `contracts/BATCH.md`
(signals 2 and 3), `contracts/TRACES.md`, `contracts/LOGS.md`; decisions D57, D58.

| API | What it does |
|---|---|
| `otel::decode_spans`, `otel::decode_logs`, `otel::encode_spans`, `otel::encode_logs`, `otel::stream_id` | `VZB1` signals 2 and 3 (`src/otel.rs`). Decode borrows, validates every rule of the contract (header, 8-byte alignment and zero padding, offsets, UTF-8, attribute lists sorted and unique with known types, ids, kinds, statuses, times, the label-name rule, every size limit) and never panics; for every input that decodes, encode gives the same bytes. `stream_id` is `batch::series_id`. |
| `encode_spans(batches)` | Flush of span batches (`src/spans.rs`): one `spans` file per hour of start time (`SignalFile.hour`), then one `trace_index` file per day of the fragments' first start. Later row wins on `(trace_id, span_id)`. Sorted by `service_name` (nulls first), `span_name`, `start`, `trace_id`, `span_id`; promoted columns and typed residual maps; events and links as lists of structs; bloom filter on `trace_id`; page index on the sorted and pruned columns; the index fragment of `TRACES.md`. |
| `encode_logs(batches)` | Flush of log batches (`src/logs.rs`): one `logs` file per day; sorted by `service_name`, `stream_id`, `ts`, `line`, `metadata`; rows equal on the row key are one (the later supplies the other columns); `line` pages at most 1 MiB; bloom filter on `trace_id`; the fragment of `LOGS.md` §5 with its bounded `streams` list. |
| `*_with(…, &SignalWriteOptions)` | Smaller row groups and pages for tests. Row groups are cut at 100,000 rows or 16 MiB as the contracts count bytes. |
| `read_spans`, `read_trace_index`, `read_logs`, `read_logs_row_groups` | Whole-file (or chosen row groups) readers through the `parquet` crate's record API (`src/otelread.rs`), rebuilding the logical view: promoted columns and residual maps merged into one sorted typed list. For tests and tools; not the query path. |
| `merge_fragments` | `trace_index` fragments of one trace merged as `TRACES.md` says. |

**What reads the files** (AGENTS.md, "Independent readers"):

- `readback/` (a separate crate, never shipped): `readback CORPUS OUT [units]` takes the
  corpus `edge/scripts/otel-corpus.mjs` writes (random requests encoded by protobufjs,
  decoded by edge's own decoders into batches, and the expected rows computed by the
  generator from its model), flushes the batches in 4 units, reads every file back, and
  requires: every span and log row equal to the expected one (duplicates across units
  resolved, the later unit winning); each unit's `trace_index` equal to what its spans say;
  every edge batch re-encoding to the same bytes; and **viz-traceql and viz-logql** giving
  byte-identical answers over the files and over their in-memory sources built from the
  expected rows: 24 TraceQL searches and 6 metrics queries through `SpanSource` (files, and
  files with the engine's pruning), 12 LogQL log queries and 6 metric queries through a
  `LogSource` over the files (`FileLogs`: reads the row groups the index fragment admits,
  pruning on and off).
- `tools/otel_independent_check.py`: **PyArrow 26.0.1 and DuckDB 2.0.0** read every file and
  every column; schema, row-group caps, sort order, partitions, promoted and residual
  columns, nulls, every fragment field against the file, every logical row against the
  expected one (doubles by their bits in PyArrow), each unit's `trace_index` recomputed from
  its spans, and DuckDB's value of every cell equal to PyArrow's.

### Bloom filters named in the fragment (D81, 2026-11-28)

`spans` row groups always carried a Parquet bloom filter on `trace_id` (1%, sized by
`max_row_group_rows` and folded by the `parquet` crate to the group's distinct ids); `trace_index`
row groups now carry one too. Both writers (`SpansFileWriter`, `IndexFileWriter`, used by flush and
by compaction alike) add `"bf":[offset,length]` to each row group's fragment entry: the column
chunk's `bloom_filter_offset`/`bloom_filter_length` from the footer the writer is building
(`otelpq::last_bloom`). The filter lies right after the group's column chunks, so `off`, `len` and
`foot` are unchanged. Additive within fragment version 1 (`contracts/TRACES.md`).
Verified: `tests/otel.rs` (every flush file, both tables: `bf` equals the footer's, the bytes parse
alone with `Sbbf::from_bytes`, every id of the group checks true) and `tests/sigmerge.rs` (the same
for every compaction output); all suites pass (`cargo test --release`: batch 11, contract_v2 6,
encode 11, export 1, merge 4, otel 19, pruning 8, select 8, sigmerge 10). Measured here: a flush
unit of 10,500 single-span traces has a 16,401-byte filter per table (16 KiB bitset and header).

## What is not implemented

- `queryRange`, `queryInstant`, `selectors` from `contracts/engine.ts` (PromQL): not this
  component.
- The WASM/JS binding lives in `engine/wasm` (a separate crate, with its own README).
  `wasm-probe/` here is only the earlier size probe and smoke test.
- zstd (the contract says snappy for now).
- Fetching pages. Pages a read does not need are skipped in memory (by the offset index),
  but a caller fetches whole row groups: a page fetch needs the footer first (a second round
  trip) and three ranges a row group, for bytes below 1 MB anyway (D41). No column index is
  written.
- A sort key that clusters a label (`namespace=…`) before `series_id`: a selection spread over
  the id space needs every row group (D19, D41).
- Promoted label columns, rollup tables, native histograms.
- Zero-copy file input: each Parquet file is copied once into a `bytes::Bytes` because
  the `parquet` reader needs an owned buffer.
- **Spans and logs, stage 2**: a query-path reader in this crate (one exists since 2026-11-19 in
  `engine/wasm-query/src/sigfiles.rs`: row groups chosen from the index fragments, decoded through
  the record API row group by row group, tail batches merged in; column readers with page index
  and bloom filters are not built), re-aggregating `trace_index` from de-duplicated spans
  (compaction merges fragments; D68), the nested-set columns, per-tenant promotion, a query that
  reads the token filter (the reader is here, `tokens::TokenFilter`; no query path calls it), and
  zstd. The readers here (`read_*`) use the record API and hold a whole file's rows.
- **Compaction merges are CPU-bound and row-at-a-time** (the record API, about 5 MB/s of spans and
  9 MB/s of logs natively): a column-at-a-time merge was not built.

## How it was verified

`cargo test`: **49 tests, all passing** (batch 11, contract_v2 6, encode 11, select 8,
merge 4, export 1, pruning 8), run on 2026-11-19 with `-j 2` and two test threads at a load
average of 7 to 13. Eight are property tests (proptest), 200 to 600 cases each.

- **Series-level pruning** (`tests/pruning.rs`, new):
  - `reading_part_of_a_file_changes_nothing` (property, 300 cases; I14 and I17): the lake of
    `select_is_location_invariant` (segments cut anywhere, row groups of 1 to 6 rows, **pages
    of 1 to 4 rows**, optional compaction, a tail that may overlap) read four ways, each equal
    to the reference: whole files with pruning on and off; sparse files holding only the
    footer and the row groups `may_hold` keeps for the selected series (gaps 0, 40 and 64 KiB),
    series files cut the same way; and sample files narrowed further to the pages of `ts` and
    `value` that hold a selected row (from the offset index), which `select` can only read if
    it never touches the others.
  - `the_parquet_bytes_are_those_the_previous_writer_wrote`: flush and merge outputs of the
    golden batches are byte-identical to the files the 2026-11-18 writer wrote
    (`tests/golden/v1-2026-11-18`, written by `examples/golden_v1.rs` in a copy of that tree),
    and their fragments equal the old ones once `sid` and `foot` are removed.
  - `files_and_fragments_of_the_previous_writer_read_as_before`: old fragments parse with no
    `sid` or `foot` (name range only; `byte_ranges` says "whole file"); old files read back to
    the reference through flush files and the merged pair; an old file and a new one merge into
    a file with the new fragment.
  - `the_fragment_carries_series_bounds_and_where_the_footer_is` (against the record API),
    `may_hold_follows_the_sort_order_exactly`, `byte_ranges_join_close_ranges_and_always_hold_the_footer`,
    `malformed_new_fields_make_the_fragment_unreadable`, `the_sparse_container_is_checked`
    (every malformation an error, every prefix no panic).

- **Contracts v2** (`tests/contract_v2.rs`), verifying what was reported as "already true"
  and what was added:
  - *Strict decoding*: NUL, the three label limits at and one past the boundary, U+FFFF
    before U+10000 accepted and the reverse rejected as unsorted, timestamps `0` and
    `253402300799999` accepted and `-1`, the next millisecond, `i64::MIN` and `i64::MAX`
    rejected, through `decode`, `encode_segment` and `select`. **New code** (see above).
  - *The empty batch* decodes, contributes nothing to a flush or a select. Already true.
  - *Later row wins inside one batch*: three rows for one `(series_id, ts)` in one batch;
    the last value is what flush writes, what a tail read returns, what lake + the same
    batch still in the tail returns (3 samples in total, not 6), and what a merge and a
    lake + later-tail read return. Already true; now tested on every path.
  - *Canonical JSON*: the `labels` cell is compared byte for byte for keys U+E000, U+FFFF
    and U+10000 (UTF-8 order, where RFC 8785's UTF-16 order would differ), the five short
    escapes, `\u0001`, `\u001f`, and DEL, U+0080, U+2028, U+2029, an emoji and `<>&`
    written raw; it parses back and survives merge and select. Already true.
  - *100,000-row cap everywhere*: 100,001 series × 2 samples flush to row groups of
    100,000 + 100,000 + 2 (samples) and 100,000 + 1 (series); merging gives
    100,000 + 100,000 + 50,002 and 100,000 + 2. Already true; the series-file and
    merge-output cases were untested before.

- **Batch.** Byte-exact layout against a hand-built buffer; FNV-1a checked against the
  published vector, a second naive implementation, and a value computed in Python;
  round-trip over random label sets, timestamps and value bits; one test per error
  variant; every proper prefix of a valid batch is `Truncated`; random bytes, random
  bodies behind a valid header (including huge row and series counts) and single-byte
  corruptions of valid batches never panic.
- **Flush.** Output is re-read through the `parquet` crate's record API (a different code
  path from the engine's column readers) and checked for schema, repetition, UTF8
  annotation, snappy, the encoding of every column, v2 data pages, contiguous column
  chunks, sort order, uniqueness of `(series_id, ts)`, the row-group cap (250,001 rows
  give 100,000 + 100,000 + 50,001), statistics that equal the true min and max of each
  row group, and the index fragment against the real footer (rows, offset, length, names,
  timestamps). A property test compares each day's file with a reference (replay into a
  map, last write wins) at row-group sizes 1 to 8. Day splitting is tested at
  `MID-1`/`MID`, at both ends of the contract range (`0`, `86399999` and
  `253402300799999`), and `day_string` on its own for dates outside four-digit years
  (which a batch can no longer carry).
  Duplicate precedence is tested across and within batches. Nine special bit patterns,
  including the staleness marker and a signalling NaN, come back bit-identical.
- **Select.** Matcher semantics on a fixture run three ways (all lake, all tail, both).
  The main property test (600 cases) generates up to 7 batches over a small pool of
  series and timestamps that straddle midnight, so duplicates are frequent; flushes a
  prefix to the lake cut into arbitrary segments with row groups of 1 to 6 rows,
  optionally compacts each day with `merge_files`; leaves a suffix in the tail that may
  overlap what was flushed; and requires the result to equal an in-memory reference
  exactly, with pruning on and off, plus the all-tail and all-lake extremes. The
  reference does not use a regex engine: each generated pattern is paired with a
  hand-written predicate for its anchored meaning.
- **Merge.** Property test: the merged file is exactly the reference de-duplicated union
  in order, idempotent, its index fragment agrees with its rows, and with default
  options it is byte-identical to a single flush of all the batches. Fixed tests cover
  precedence, `Unsorted`, `MixedDays`, `Empty`, wrong-table and corrupt inputs, using
  input files written directly with the `parquet` crate in a different encoding.

### Independent reader

`tests/export.rs` writes a flush pair (172,879 samples in 2 row groups from 320,000
arrivals with duplicates and NaNs; 40 series) and checksums computed from the test's own
input rows. `tools/hyparquet_check.mjs` reads the files with **hyparquet** (pure
JavaScript, no shared code) and compares. **Result: all 15 checks agree**: row counts,
footer row count, row-group count, wrapping sums of `series_id` and `ts`, XOR of non-NaN
value bits, NaN count, total name bytes, first row, sort order and uniqueness, and for
the series file the `series_id` sum, label bytes, and that `labels` parses as canonical
JSON agreeing with `metric_name`.

**Series-level pruning (2026-11-19): PyArrow 26.0.1 and DuckDB 2.0.0** (a scratch venv), via
`examples/independent.rs` (two overlapping flush files of 5 metrics x 2,000 series, three row
groups each, NaN payloads and staleness markers, and their merge, both tables) and
`tools/independent_check.py`: **194 of 194 checks pass**. Both read every file and return
exactly the expected rows computed from the input batches (PyArrow bit for bit, DuckDB as
numbers with NaN as NaN); every fragment agrees with the file (row groups, rows, offsets,
lengths, names, times, `sid` = the first and last row's `series_id`, `foot` = from the end of
the last row group to the end of the file) and every column chunk has an offset index; and for
25 series of each samples file, a buffer holding only the footer region and the row groups the
contract's rule (re-implemented in Python) keeps gives PyArrow exactly that series' rows, while
no row group left out holds one of them.

One finding from that run: of 3,431 staleness markers written, JavaScript saw only 1,401
bit-exact; the rest arrived as `0x7ff8000000000002`. The file is correct (the Rust reader
returns all of them bit-exact). The marker is a signalling NaN, and JavaScript engines
may quiet it when it passes through a number. See "Contract issues".

### WASM

`cargo build --release --target wasm32-unknown-unknown` succeeds: `libviz_storage.rlib`
is 2.52 MB. An rlib is not a deliverable, so `wasm-probe/` links every public entry
point into a cdylib: **2,775,281 bytes, 788,880 gzip** (fat LTO, `opt-level=3`, stripped,
no `wasm-opt`). `tools/wasm_smoke.mjs` runs it in Node on the export test's batches:
flush produces the same number of Parquet bytes as native, and flush + merge +
select(lake + tail, regex matcher) selects the same 69,127 samples the native test
counted. A `+simd128,+bulk-memory` build also compiles and passes (2.76 MB).

### Mutation checks

**Series-level pruning (2026-11-19).** `tools/mutants.py` now copies the crate to a scratch
directory and mutates only the copy (it edited the shared tree in place before; AGENTS.md). Run
with `pruning` (2026-11-19, 04:28 to 04:45 UTC, load average 8 to 9): **18 of 18 killed**, the
shared tree untouched. The 15 new ones, with the tests that caught them: `may_hold`'s lower
series bound off by one (`may_hold_follows_the_sort_order_exactly`,
`reading_part_of_a_file_changes_nothing`); its upper bound ignored, and statistics that
contradict the sort order trusted (`may_hold_follows…`); an interval ending exactly at the bound
missed, and the name range ignored (`may_hold_follows…`, `files_and_fragments_of_the_previous_writer_read_as_before`);
the index writer recording the first `series_id` as the last, the footer offset one byte late,
its length one byte short (`the_fragment_carries_series_bounds…`, `reading_part…`); byte ranges
leaving out the footer, or joining ranges one byte too far apart
(`byte_ranges_join_close_ranges_and_always_hold_the_footer`, `reading_part…`); `select` mapping
a later span's rows to the wrong place, reading a row group that was not fetched, skipping one
that was, and the run reader skipping one row too few (`reading_part…`); a sparse segment held
one byte longer than it is (`the_sparse_container_is_checked`). The three older pruning mutants
(ts, name and `series_id` statistics) are still killed, now also by `reading_part…`. Two of the
older mutants' patterns were updated for the new `select` code (the time filters on lake and
tail rows); the other older mutants were not re-run this time.

`tools/mutants.py` applies one source change at a time, runs the suite, and restores the
file. It first confirms the unmutated suite passes, and distinguishes a failing test from
a build error. **28 of 28 mutants are killed** by failing tests. In the
full re-run after the contracts v2 changes, 27 were killed and one that used to be
killed **survived**: mutant 4 below (day boundary truncating instead of flooring), because
batches can no longer carry the negative timestamp the old test relied on. A direct
assertion on `day_string(-1)` was added to `day_strings`, and the mutant is killed again. The seven added for
contracts v2 (decode accepts a NUL / 129 labels / an over-long value / a timestamp after
year 9999 / a negative timestamp; duplicates inside a batch kept by select; control
characters escaped in upper-case hex) are each killed by a test in `tests/contract_v2.rs`.
The original 21:

| # | Mutant | Killed by (examples) |
|---|---|---|
| 1 | Flush: earlier batch wins on duplicates | `later_batch_wins_on_duplicates`, `flush_matches_reference` |
| 2 | Flush: sort by `(series_id, metric_name)` | `flush_matches_reference`, `row_group_cap_and_file_properties_at_scale` |
| 3 | Flush: NaN payloads quieted | `nan_payload_bits_are_preserved` |
| 4 | Day boundary truncates instead of flooring | `splits_days_at_utc_midnight` |
| 5 | Row-group cap 100,001 | `row_group_cap_and_file_properties_at_scale` |
| 6 | Index fragment `min_ts` wrong | `flush_matches_reference` and 7 others |
| 7 | Index fragment offset off by one | `row_group_cap_and_file_properties_at_scale` and 4 others |
| 8 | Select: no ts filter on lake rows | `time_range_is_inclusive_and_filters_rows_and_series` |
| 9 | Select: no ts filter on tail rows | same, `select_is_location_invariant` |
| 10 | Regexes not anchored | `matcher_semantics`, `select_is_location_invariant` |
| 11 | Missing label is not the empty string | `matcher_semantics` |
| 12 | Select: lake beats tail / earlier beats later | `precedence_tail_over_lake_and_later_over_earlier` |
| 13 | ts pruning of sample row groups off by one | `many_row_groups_and_metrics_prune_consistently` |
| 14 | Name pruning of series row groups off by one | `select_is_location_invariant` |
| 15 | `series_id` pruning ignores the upper bound | `matcher_semantics` and 5 others |
| 16 | Merge: earlier input wins | `later_input_wins_and_output_is_sorted` |
| 17 | Merge: duplicates kept | `merge_is_the_deduplicated_union` |
| 18 | Series merge keeps the later `min_ts` | `series_merge_unions_ranges_and_takes_later_labels` |
| 19 | Decode accepts `series_idx == n_series` | `precise_errors` |
| 20 | Decode accepts unsorted labels | `precise_errors` |
| 21 | `series_id` without the `0x00` separators | `series_id_matches_known_fnv1a_vectors` |

Mutants 13 to 15 also show that pruning really happens in the tests: breaking it changes
answers.

## Performance notes

Rough, from `tools/wasm_smoke.mjs` in Node on a shared 4-vCPU sandbox while other builds
were running; single machine, median of 5, not a benchmark:

- `encode_segment` of 320,000 arriving rows (6.4 MB of batches, 172,879 rows after
  de-duplication, 1.18 MB of Parquet): 64 to 116 ms across runs.
- Flush + merge of both files + select over lake and tail with a regex matcher: 157 to
  246 ms across runs. WASM memory peaked at 31 MB. Instantiate 13 to 18 ms.
- The SIMD build was not measurably different in this noisy setting.

No native benchmark was run and nothing here was compared with `bench/`.

## The `series_id` locality experiment

`examples/locality.rs` (run: `CARGO_TARGET_DIR=$PWD/target cargo run --release --example
locality -- 200000 120`) encodes one generated dataset twice, with the plain id of
`contracts/BATCH.md` and with an id whose top 24 bits are hashes of `namespace` and `job`,
checks that `select` returns identical results for six queries on both, and prints row
groups, pages and bytes each query would read, and select time. Re-run 2026-11-18 at 30,
60 and 120 samples per series (about 25, 40 and 65 s each, release build): for
`{namespace="x"}` the locality id reads 1.3×, 1.6× and 2.6× fewer row-group bytes (5.8×,
10.7×, 16.5× by pages, which the engine cannot prune by), `{job="y"}` 1.3–2.7×, and a
full-metric scan touches the same row groups. The table and the decision (the contract is
unchanged: below the 3× bar as the engine reads, and 40 remaining bits collide) are in
`design/DECISIONS.md` D19. Nothing in the crate uses it.

## Spans and logs: verification and measurements

**Mutants (2026-11-19)**, `python3 tools/mutants.py otel` on a scratch copy (the shared tree
untouched, the copy deleted), each against `tests/otel.rs`: **16 of 17 killed** on the first
run. The survivor, "span flags written even when zero", lived because the generator almost
never produced flags 0; the generator now does half the time, and the mutant is killed
(`spans_flush_and_read_back`). The PyArrow check would also have caught it ("flags null when
zero").

| Mutant | Killed by |
|---|---|
| spans sorted by `span_name` before `service_name` (a sort key out of order) | `spans_flush_and_read_back` |
| logs sorted by `stream_id` before `service_name` | `logs_flush_and_read_back` |
| a residual bool attribute dropped | `spans_flush_and_read_back` |
| a non-string `service.name` dropped instead of kept residual | `promoted_columns_hold_exactly_their_keys`, `spans_flush_and_read_back` |
| the earlier of duplicate spans wins | `spans_flush_and_read_back` |
| duplicate log rows kept | `logs_flush_and_read_back` |
| spans partitioned by two-hour windows | `partitions_split_at_hour_and_day_boundaries`, `spans_flush_and_read_back` |
| `trace_index` takes the latest root | `fragments_merge_as_the_contract_says`, `spans_flush_and_read_back` |
| `trace_index` error count counts every non-unset span | `spans_flush_and_read_back` |
| span flags written even when zero | `spans_flush_and_read_back` (after the generator fix) |
| span fragment `min_dur` over starts | `spans_flush_and_read_back` |
| log fragment `sid` last = first | `logs_flush_and_read_back` |
| log fragment stream's last row group not advanced | `logs_flush_and_read_back` |
| `line` written in 1 MiB pieces (pages over 1 MiB) | `line_pages_are_at_most_one_mib` |
| `stream_id` hashed differently from `series_id` (labels reversed) | `stream_id_is_series_id` |
| decode accepts an all-zero `trace_id` | `span_decoder_refuses_each_rule` |
| decode accepts unsorted attributes | `span_decoder_refuses_each_rule` |

The mutants of `edge` (tenant from the body, partial success miscounted, `stream_id` rules, a
dropped attribute, and 15 more) are in `edge/README.md`: 19 of 19 killed.


```
CARGO_PROFILE_DEV_DEBUG=0 cargo test -j 2 --test otel -- --test-threads 2           # 19 tests
node ../../edge/scripts/otel-corpus.mjs CORPUS SEED 2                               # edge decodes protobufjs-encoded requests
(cd readback && cargo run --release -- CORPUS OUT 4)                                # Rust read-back and the two engines
python3 -I tools/otel_independent_check.py OUT                                      # PyArrow and DuckDB (a venv with both)
cargo run --release --example otel_bench -- 1 20000 3                               # encode throughput and size
python3 tools/mutants.py otel                                                       # on a scratch copy
```

**Tests** (`tests/otel.rs`, 19, all passing on 2026-11-19; with them the whole suite is 68
of 68 and the WASM build succeeds). Properties (proptest, generators in `tests/otelgen`:
every attribute type, keys and values with Unicode (astral, U+E000, U+FFFF), control
characters, empty strings, NaN payloads, ±Inf, −0, the promoted keys with right and wrong
types, ids from small pools so duplicates and many-span traces are common, starts across an
hour and a day boundary): batches round-trip and re-encode to the same bytes (200 cases
each); damaged batches never panic; **decode → flush → read back equals the input** for spans
(150 cases, row groups of 1 to 5 rows, pages of 3) and logs (150), in the contract's order and
partitions, the later duplicate winning, every fragment field equal to the file's metadata;
the same rows split differently give the same bytes; per-batch `trace_index` fragments merge
into the fragment of the whole. Fixed tests: each decoder rule refused with its message, every
proper prefix refused, maximal values accepted and read back (8,192-byte names, a 1,024-byte
key with a 65,536-byte value, 128 events and links, a 256 KiB line, 128 metadata entries of 64
KiB, 32 labels with an 8,192-byte value), promotion exactly as `TRACES.md` says, the file layout
(compression, offset index, page index, bloom filters, dictionaries, statistics, sorting
columns), `line` pages at most 1 MiB with lines up to 256 KiB, both row-group caps, hour and day
boundaries (including 1970-01-01 and 2262-04-11), the bounded `streams` list, and `stream_id`
against values computed in Python.

**Cross-language read-back** (2026-11-19, seeds 1 to 5, scale 2: 9,420 spans in 300 traces a
seed and 28,414 log rows, from 86 OTLP traces requests and 515 OTLP logs and Loki push
requests, protobuf and JSON, including retries, clamped ends, orphan spans, a 65,536-byte
attribute, an 8,192-byte span name, a 256 KiB line): `readback` **0 failures** in 37,677 to
41,327 checks a seed (every edge batch also re-encodes to the same bytes); TraceQL **60 of 60** answers identical a seed (30 queries, all
non-empty; files, and files with pruning); LogQL **36 of 36** identical a seed (18 queries, 17
or 18 non-empty; files with fragment pruning off and on). PyArrow and DuckDB **0 failures** in
253,606 to 274,915 checks a seed. One finding, written into `contracts/TRACES.md`: merged
`trace_index` fragments over-count 43 to 52 of 300 traces a seed, exactly those with a span
retried into another unit. The run also found a bug in `edge` (a double inside an array or
key-value list read from the wrong bytes when the body was a Node `Buffer`), fixed there.

**Measured here** (`examples/otel_bench.rs`, release build, Linux x86-64, 4 shared cores at
load average 8 to 9, one thread, not WASM, not Cloudflare). The generator is described in the
example's header: 20 services × 5 instances, 200 span names, ~12 spans a trace, 6 to 8
attributes a span (a high-cardinality user id, 30% with a 40–200-byte SQL statement), 10% with
an event, 2% with a link; log lines of 80–260 bytes of logfmt with a random request id, 50
streams, 2–4 metadata entries, 30% with trace ids. Flushes of 20,000 rows, batches of at most 1
MiB; only `encode_spans` / `encode_logs` timed.

| Per million | Input batches | Parquet out | Encode time (min of 3; all three) |
|---|---|---|---|
| spans (with their `trace_index`) | 352.3 MB | 95.5 MB | 4.85 s (4.85, 4.96, 6.89) |
| log lines | 311.7 MB | 58.6 MB | 1.86 s (1.86, 2.02, 2.47) |

So about 5 µs a span and 2 µs a log line natively, and Parquet at 27% (spans) and 19% (logs)
of the batch bytes. The WASM speed of these encoders was not measured (no binding exports
them yet). A single cold 20,000-span segment took 10.9 s per million spans; the table is the
steady state over 50 segments.

## Compaction of spans and logs (2026-11-19)

Contracts: `contracts/TRACES.md` and `LOGS.md`, "Compaction", and LOGS.md §6 (the token filter,
whose place inside the file was settled first, D65); design/DECISIONS.md D68. Metric code and
output are untouched: the golden files of `tests/golden/v1-2026-11-18` are still byte-identical,
and flush's span and log output is unchanged (its writers were split into row-group-at-a-time
writers that flush and compaction share; every existing test, the byte-for-byte determinism
property included, passes as before).

| API | What it does |
|---|---|
| `merge_signal_files(table, inputs)`, `merge_signal_files_shared(table, &[Bytes], &SignalMergeOptions)` | Compaction of one table and partition (`src/sigmerge.rs`), inputs lowest precedence first. `spans`: files of ONE hour; a first pass over the two id columns finds, per `(trace_id, span_id)`, the last occurrence (later input, then later row), then a k-way merge in the contract's order keeps only those. `trace_index`: files of ONE day; the rows of one trace become one (`merge_fragments`, the later input's root on a tie, at most 64 services by most spans then name, `services_truncated`). `logs`: files of ONE day; a row is dropped when the next row in the merged order (ties: the later input after) has the same row key, as flush does. Refuses (`SignalError::Merge`) no inputs, no rows, an unsorted input, rows of two partitions (checked on every row read, winners or not), and a file of another table. |
| `merge_signal_files_chunked` | The same, the output left in the 1 MiB chunks it was written in (the WASM binding copies them out one by one). |
| `SignalMergeOptions` | `write` (default: flush's, row groups cut at `MERGE_ROW_GROUP_BYTES` = 2 MiB instead of 16), `token_filter` (default on; off gives exactly the bytes a flush of the same rows would), `token_filter_max_tokens` (default `MAX_FILTER_TOKENS`, 2^19). |
| `tokens::{for_each_token, tokens, literal_tokens}` | The token rule of LOGS.md §6 (runs of ASCII letters and digits and non-ASCII characters, at least 4 bytes, ASCII-lowercased, cut to 64 bytes at a character boundary), and the tokens strictly inside a literal. |
| `tokens::TokenFilterBuilder` | Builds a file's `VZT1` filter while its row groups are written: tokens in 1 MiB arena chunks, an open-addressing table at most 3/4 full, one bitset byte per 8 row groups (about 12 bytes a token besides its bytes); past the bound it frees everything and the file gets no filter. `write` streams the filter in 64 KiB pieces. |
| `tokens::TokenFilter` | Reads a filter: `parse` checks the header and sizes, `lookup`/`has` binary-search the blocks' first tokens and scan one block (checking prefix lengths, bounds and order), `may_match(rg, required)` is false only when some clause has no literal whose implied tokens are all in the row group; any doubt answers true. `entries` decodes all. `token_filter_location` reads `viz.token_filter` from a file's footer. |

How a merged `logs` file carries its filter: the `LogsFileWriter` writes it through
`SerializedFileWriter::write_all` after the last row group (and its bloom filter), records
`viz.token_filter` = `"{off},{len}"` in the footer's key-value metadata and `"tok":[off,len]` in
the fragment, whose `foot` then starts where the filter ends.

### How it was verified

```
CARGO_TARGET_DIR=$PWD/target cargo test -j 2 -- --test-threads 2      # 78 tests, 10 in tests/sigmerge.rs
cargo run --release --example merge_independent -- DIR 40 && python3 -I tools/merge_independent_check.py DIR
cargo run --release --example otel_bench -- merge 8 25000 3 [DIR]      # throughput, size, peak heap
python3 tools/mutants.py sigmerge tokens otel                           # on a scratch copy
```

**`tests/sigmerge.rs`** (10 tests, all passing with the rest of the suite, **78 of 78**, on
2026-11-19 at load average 11 to 15; properties 120 cases each, on the span and log generators of
`tests/otelgen`, which produce duplicates within and across batches, every attribute type, NaN,
Unicode, and starts across an hour and a day): units of 1 to 2 batches, 1 to 4 units, each flushed
as flush does, then every partition merged in unit order with row groups of 1 to 5 rows and pages
of 3:

- `spans_merge_per_hour_into_the_deduplicated_union`: the merged rows, read back, are the
  reference computed from the batches alone (within a unit the later row, across units the later
  unit), and the merged bytes, fragment and bounds are exactly those of ONE flush of a batch
  holding just those rows; merging in two steps (the first inputs, then that output with the
  rest) gives the same bytes; the fragment agrees with the footer.
- `trace_index_merges_fragments_per_day`: the merged rows equal the fragments recomputed here
  from each unit's spans and merged by an implementation of the contract's rule written in the
  test; `min_tid`/`max_tid` per row group; two-step merges equal.
- `logs_merge_per_day_into_the_deduplicated_union_with_its_token_filter`: without the filter the
  bytes and fragment equal one flush of the reference rows (rows are also re-sent by another
  unit with their other columns changed, so which input wins shows); with it, the same rows and row
  groups, `tok` after the last row group, `foot` starting where it ends, the footer's
  `viz.token_filter` equal to `tok`; the filter lists exactly the tokens of each row group's
  lines and metadata values, computed by a tokenizer written over characters in the test; for
  literals cut from the lines and some fixed ones, `may_match` never rules out a row group that
  holds a line containing the literal, and rules one out exactly when an implied token is missing.
- `default_layout_merges_are_one_flush`: with the merge's default options, merged bytes equal a
  flush of the same rows with the same options (spans and logs).
- Fixed: refusals (two days, two hours, another table, no input, an unsorted file written by hand
  with the `parquet` crate); 64 services kept by the rule (80 spans, 70 services); a root span
  stored by two units takes the later unit's fragment, in either order; the token rule (case,
  3-byte runs, `_` splits, non-ASCII, a cut at 64 bytes inside a two-byte character) and implied
  tokens; the filter's exact bytes for a small case, lookups before, between and after blocks,
  damaged filters refused and a refused filter never pruning, 40 tokens over 70 row groups, the
  bound; a merge past the bound writes no filter and is then byte-identical to one without.

**Independent readers** (`examples/merge_independent.rs`, `tools/merge_independent_check.py`):
40 random cases of 2 to 5 units of span and log batches (random attributes of every type with
NaN, -0 and infinities, Unicode, ids from small pools so duplicates are common, starts across an
hour and a day, row groups of 1 to 12 rows or the default), every partition merged. PyArrow
26.0.1 and DuckDB 2.0.0 read every input and output whole; the check computes what each output
must hold from the INPUTS' rows itself (the last input's row per key, a trace's rows merged with
the later input's root on a tie, at most 64 services), compares every column exactly (doubles by
their bits), checks one partition per file, row-group caps, every fragment field against the
footer, and for `logs` parses the `VZT1` filter from the bytes at `viz.token_filter` and requires
exactly the tokens of each row group (its own tokenizer). Run 2026-11-19 on the final code:
**0 failures** in 245,592 checks (40 cases, seed 20261119: 120 spans, 67 trace_index and 89 logs
outputs, every logs output with its filter) and 345,571 checks (60 cases, seed 7: 180, 88, 143).

### Mutants (`python3 tools/mutants.py sigmerge tokens otel`, on a scratch copy)

Run 2026-11-19 (the copy deleted after, the shared tree untouched): **30 of 30 killed** in the
end, the 17 `otel` mutants of the flush encoders included (one pattern updated: the logs writer's
stream tuple moved a field). One survived the first run, "the earlier input wins a duplicate log
row": the log generator gives each batch its own random streams, so two units almost never held
one row key. The logs property now re-sends rows of one unit in another with their other columns
changed; the mutant is killed by it.

| Mutant | Killed by |
|---|---|
| a span merged across hours (the merge accepts two hours' rows) | `merges_refuse_what_they_cannot_merge`, `spans_merge_per_hour_…`, `default_layout_…` |
| a lost row in a logs merge: rows differing only in metadata taken for one | `logs_merge_per_day_…`, `default_layout_…` |
| a lost row in a logs merge: the last row never written | `logs_merge_per_day_…`, `default_layout_…`, `a_merge_past_the_token_bound_…` |
| the earlier input wins a duplicate span | `spans_merge_per_hour_…`, `default_layout_…` |
| the earlier input wins a duplicate log row | `logs_merge_per_day_…` (after the generator fix above) |
| trace_index fragments of one trace not merged (the last kept) | `trace_index_merges_fragments_per_day`, `trace_index_keeps_64_services_by_the_rule`, `a_root_span_stored_by_two_units_…` |
| trace_index keeps more than 64 services | `trace_index_keeps_64_services_by_the_rule` |
| a token filter that misses 4-byte tokens | `tokens_follow_the_rule`, `the_filter_bytes_are_the_contract_s`, `logs_merge_per_day_…`, `a_merge_past_the_token_bound_…` |
| a token filter that misses the metadata values' tokens | `logs_merge_per_day_…` |
| a token filter that misses a row group's last row | `logs_merge_per_day_…`, `a_merge_past_the_token_bound_…` |
| a literal implying its edge runs (prunes a group holding a longer run) | `tokens_follow_the_rule`, `the_filter_bytes_are_the_contract_s`, `logs_merge_per_day_…` |
| the filter's bitsets one row group off | `the_filter_bytes_are_the_contract_s`, `logs_merge_per_day_…` |
| `foot` starting at the last row group although a filter follows it | `logs_merge_per_day_…` |

"An output deleted by its own step" is a mutant of compact/ (compact/README.md): killed there.

### Memory and speed (measured here, not on Cloudflare)

Native, release build, Linux x86-64, one thread, 4 shared cores at load average 4 to 5
(`otel_bench merge 8 25000 3`, peak heap counted by a global allocator; the generator is the
one described in the example's header: 20 services, 200 span names, a high-cardinality user id,
log lines of logfmt with a unique 16-hex-digit request id):

| Table | Inputs | Input MB (rows) | Output MB (row groups) | Merge (min of 3) | Throughput | Peak heap with the inputs |
|---|---|---|---|---|---|---|
| spans (one hour) | 8 | 16.13 (177,860) | 16.57 (49) | 3.06 s | 5.3 MB/s, 58 k rows/s | 60 MB |
| trace_index (one day) | 8 | 0.91 (16,672) | 0.88 (2) | 0.15 s | 6.1 MB/s | 21 MB |
| logs (one day) | 8 | 11.69 (200,000) | 15.90 (34), of which the token filter 4.01 (25%) | 1.24 s | 9.4 MB/s, 161 k rows/s | 50 MB |

Output size: spans files grow 3% (more, smaller row groups than the inputs' single groups:
49 instead of 7 at 16 MiB groups, dictionaries repeated); logs grow by their filter: 206,905
distinct tokens, most of them request ids, about 19 bytes each. What the filter buys on that
file: a search for one request id (`|= "request_id=… "`) keeps on average **1.00 of 34** row
groups (50 ids). In WASM (`engine/wasm/tools/measure_signal_merge.mjs`, engine/wasm/README.md)
the same merges peak at 62 MB (spans), 62 MB (logs, 11 MB in) and 81 MB (logs, 16 MB in) and
take 4.0, 1.8 and 2.4 s.

How the memory came down (spans, the 8 inputs above): 199 MB of heap with 16 MiB output row
groups decoded whole and a contiguous output (6 times a group's counted size: owned strings, a
resource entry and its split per row, the views and the leaves); readers decoding 64 values at a
time per column instead of 1024 (the record reader's default held 2.3 MB per open spans file);
the winners of pass 1 in one sorted vector instead of a hash map; resource entries interned;
the output written in chunks (a growing `Vec` doubled past the inputs' size); 2 MiB row groups.
Smaller groups than 2 MiB were not measured below; 4 MiB left spans at 75 MB in WASM.

## Known risks

- **Compaction memory is near an isolate's at the step budget** for logs whose lines carry unique
  ids (81 MB of WASM memory at 16 MB in, 22 MB out with the filter; with the JS side about
  119 MB, modelled). The bound on distinct tokens (2^19) caps the builder at about 15 MB; a file
  over it simply has no filter.
- **The token filter grows a logs file by up to a quarter** when lines carry unique ids (25%
  measured on the benchmark's lines), for a filter no query reads yet.
- **A merged spans file can order a re-sent span differently** when the span id was re-sent with
  a start in another hour (contracts/TRACES.md, "Compaction").
- **Merged row groups are small** (2 MiB of data, about 2 to 4k spans or 6k log rows): more
  fragment bytes in the ledger per file, finer pruning.

- **Partial reads trust the planner.** A row group whose `series_id` chunk is not in a sparse
  file is skipped as "left out on purpose": if a caller left out one that holds a selected
  row, the answer would miss it without an error. The rule (`may_hold`) is tested exactly and
  through every read path (I14 property tests here and in `engine/query`, PyArrow above, the
  mutants below); every other missing byte fails the read.
- **Fragments are larger** by about 50 bytes a row group and 20 a file (the ledger's state is
  capped at 16 MiB).

- **Memory in flush.** `encode_segment` holds all decoded rows (20 bytes each) plus the
  output. Fine for the few-MB segments the design specifies; not for arbitrary input.
- **Whole-file copies in `select` and `merge_files`** (see "not implemented").
- **`series_id` is trusted.** Hash maps keyed by it use a cheap unseeded hash. A tenant
  that crafts label sets with colliding ids can slow its own flush and queries, and if
  two label sets share an id their samples are merged under one of them (the later
  labels in flush; the first seen in select).
- **Parquet inputs are assumed to be files this crate wrote.** Corrupt or wrong-schema
  files return errors in the cases tested, but the `parquet` crate was not fuzzed here.
- **Timings are not from Cloudflare** and the 128 MB isolate limit was not exercised.
- **Statistics for `value`** exclude NaNs (the `parquet` crate's behaviour); nothing in
  this crate prunes on `value`.
- **Spans and logs flush holds a whole segment** decoded (borrowed rows plus per-row
  attribute splits) and the output. A 20,000-span segment is about 7 MB of batches; memory in
  WASM was not measured.
- **The WASM rlib grew** from 2.52 MB to 5.65 MB with the span and log code; a module linking
  `encode_spans` and `encode_logs` was not built or measured.
- **`resource_fp` and `stream_id` are trusted**, as `series_id` is: a forged batch could group
  rows under a wrong resource or stream. Only `edge` writes batches.
- **The record-API readers** hold every row of a file as `parquet::record::Row`s; fine for
  tests and tools, not for the query path.

## Contract issues

Contracts v2 settles the list below: 1 to 3 (`engine.ts` number rules and `select`'s empty
series), 4 and 5 (`BATCH.md`: later row wins; strict decoders), 6 to 8 (`TABLES.md`:
canonical JSON, encodings, the cap for every file), 10 (timestamps bounded to years 1970
to 9999, now enforced by `decode` as well as by `edge`), 11 and 12. Item 9 stands.
The original list, for the record:

None required deviating from a contract; these are gaps where a choice was made.

1. **`engine.ts`: `ts`, `minTs`, `maxTs` are JS numbers / `Float64Array`.** This crate
   uses `i64`. Exact up to 2^53 ms; the binding must convert.
2. **`engine.ts`: staleness markers cannot safely cross into JS as numbers.** The marker
   `0x7ff0000000000002` is a signalling NaN and hyparquet/V8 quieted more than half of
   them (above). `SeriesData.values` as a `Float64Array` is fine only if the binding
   copies bytes and nothing on the JS side reads elements and writes them back.
   Staleness should be interpreted inside the engine.
3. **`engine.ts` `select`**: silent on series that match but have no sample in range.
   They are not returned.
4. **`BATCH.md`**: silent on which row wins for a duplicate `(series_id, ts)` inside one
   batch. The later row wins, consistently in flush, select and merge.
5. **`BATCH.md`**: silent on whether a decoder rejects non-zero flags, reserved or
   padding bytes, trailing bytes, empty label values (which "are dropped before
   encoding") or invalid UTF-8. All are rejected. A batch with `n_rows = n_series = 0`
   ("not sent") decodes and contributes nothing.
6. **`TABLES.md`: "canonical JSON" is not defined.** Used: no whitespace, keys in UTF-8
   byte order (the batch's label order), string escaping as in RFC 8785. RFC 8785 itself
   orders keys by UTF-16 code unit, which differs for names mixing astral characters
   with U+E000 to U+FFFF.
7. **`TABLES.md`: encodings for `metric_series` are not specified.** Used: dictionary for
   `metric_name`, DELTA_BINARY_PACKED for the three integers, PLAIN for `labels`.
8. **`TABLES.md`: the 100,000-row cap is stated for flush files only.** Applied to
   `metric_series` files and to `merge_files` output too; `WriteOptions` changes it.
9. **`TABLES.md`: `(series_id, ts)` unique while sorting by `metric_name` first** assumes
   one metric name per `series_id`. Flush enforces it by using the latest labels for an
   id; `merge_files` de-duplicates on `(metric_name, series_id, ts)` and would keep both
   rows if two inputs disagreed about an id's name.
10. **Day strings outside years 0000 to 9999** are not addressed. They are written with
    a sign and extra digits (`+10000-01-01`) so flush cannot be made to fail by one bad
    timestamp, but they do not sort as strings, which `ledger.expire` relies on. `edge`
    should reject such timestamps.
11. **`ledger.ts` `FileEntry.index` is "opaque"**; its format is defined here
    (`FileIndex`). For `metric_series` files, `min_ts`/`max_ts` (file and fragment) are
    taken over the `min_ts` and `max_ts` columns.
12. **`select` needs the `metric_series` file that goes with each `metric_samples`
    file.** A series present only in a sample file is not returned. The contract's
    `ScanInput` implies this but does not say it.
