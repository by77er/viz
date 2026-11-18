# viz-storage

The storage half of the viz engine as a Rust library: `VZB1` batches in, sorted Parquet
files out, reads that merge lake files with shard tails, and compaction merges.

No I/O, no async, no clock, no randomness. Every function is a pure function of the bytes
it is given, so it runs unchanged in WASM, natively and in a deterministic simulator.
Builds for the host and for `wasm32-unknown-unknown`.

```
CARGO_TARGET_DIR=$PWD/target cargo test                                    # 41 tests
CARGO_TARGET_DIR=$PWD/target cargo build --release --target wasm32-unknown-unknown
node tools/hyparquet_check.mjs      # independent reader (after cargo test --test export)
python3 tools/mutants.py            # mutation check
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
| `*_with` variants | Same functions with `WriteOptions { max_row_group_rows }` or `SelectOptions { prune_row_groups }`, used by tests and available to callers. |

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
- **Deterministic output.** Same input, same bytes, natively and in WASM (checked: the
  WASM build produced byte-for-byte the same total size, and a merge of several flushes
  is byte-identical to one flush of the same batches).

## What is not implemented

- `queryRange`, `queryInstant`, `selectors` from `contracts/engine.ts` (PromQL): not this
  component.
- The WASM/JS binding lives in `engine/wasm` (a separate crate, with its own README).
  `wasm-probe/` here is only the earlier size probe and smoke test.
- zstd (the contract says snappy for now).
- Page-level pruning. Statistics are per row group; no column index is written and the
  index fragment has no page locations (DESIGN §5.2 mentions them).
- Reading by byte range from the index fragment. `select` takes whole files and prunes
  with the footer statistics; the fragment is for the planner.
- Promoted label columns, rollup tables, native histograms.
- Zero-copy file input: each Parquet file is copied once into a `bytes::Bytes` because
  the `parquet` reader needs an owned buffer.

## How it was verified

`cargo test`: **41 tests, all passing** (batch 11, contract_v2 6, encode 11, select 8,
merge 4, export 1). Seven are property tests (proptest), 200 to 600 cases each.

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

`tools/mutants.py` applies one source change at a time, runs the suite, and restores the
file. It first confirms the unmutated suite passes, and distinguishes a failing test from
a build error. **MUTANT_TOTALS** by failing tests. The seven added for
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

## Known risks

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
