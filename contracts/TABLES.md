# Metrics tables

Rules common to every table:

- Row groups hold at most 100,000 rows, in flush files and compaction output alike.
- `day` is always `YYYY-MM-DD`; timestamps outside years 1970 to 9999 never reach a table.
- **Canonical JSON** means: no whitespace; object keys in UTF-8 byte order (the batch's
  label order); strings escaped as in RFC 8785. (RFC 8785 itself orders keys by UTF-16
  code unit; viz does not.)
- A file's `index` (`FileEntry.index` in `ledger.ts`) is produced and read only by the
  engine (the publisher also reads `rg[].off`, `min_name`, `max_name` for Iceberg
  statistics); its format is `FileIndex` in `engine/storage`, summarised in "The index
  fragment" below.

Parquet, format v2 data pages, snappy for now (zstd once the WASM build is proven).
Every file holds exactly one tenant and one UTC day.

## `metric_samples`

| Column | Parquet type | Encoding | Notes |
|---|---|---|---|
| `metric_name` | BYTE_ARRAY (UTF8), required | dictionary | value of `__name__` |
| `series_id` | INT64, required | DELTA_BINARY_PACKED | from the batch |
| `ts` | INT64, required | DELTA_BINARY_PACKED | Unix milliseconds |
| `value` | DOUBLE, required | BYTE_STREAM_SPLIT | NaN payloads preserved |

- Sort order: `metric_name`, `series_id`, `ts`. Within one file `(series_id, ts)` is unique:
  when a flush sees duplicates, the row from the highest batch sequence wins.
- Row groups: at most 100,000 rows in flush files. Statistics on, per row group.
- Data pages: at most 20,000 rows (the `parquet` crate's default, stated 2026-11-19; every
  file written so far already has it). The offset index (page locations) is written; no
  column index. Readers must not require either: they let a reader skip pages it does not
  need without decompressing them, and nothing more.

## `metric_series`

One row per series present in the file's day.

| Column | Parquet type | Notes |
|---|---|---|
| `metric_name` | BYTE_ARRAY (UTF8), required | |
| `series_id` | INT64, required | |
| `labels` | BYTE_ARRAY (UTF8), required | canonical JSON object of all labels including `__name__`, keys sorted |
| `min_ts`, `max_ts` | INT64, required | first and last sample time for this series in this file |

- Sort order: `metric_name`, `series_id`. Encodings: dictionary for `metric_name`,
  DELTA_BINARY_PACKED for the integers, PLAIN for `labels`.
- A `metric_samples` file is only readable together with the `metric_series` file written
  in the same flush unit or compaction; the ledger always lists them together.
- (Promoted label columns come later; `labels` is the source of truth.)
- **"In the range" is decided per file** by readers that list series without reading
  samples (the label endpoints and the cardinality report): a series is in `[start, end]`
  if one of its rows has `[min_ts, max_ts]` overlapping it, or a tail row of it lies in it.
  A series with samples in one file on both sides of the window and none inside counts as
  in it, as Prometheus decides per block. (Stated 2026-11-19.)

## Object keys

```
{cell}/data/{table}/tenant={tenant}/day={YYYY-MM-DD}/L{level}-{shard}-{incarnation}-{seqLo}-{seqHi}-{hash8}.parquet
```

- `level` is 0 for flush files. `shard` is the shard name with `/` replaced by `_`.
- The span and log tables (`spans`, `trace_index`, `logs`; `contracts/TRACES.md`,
  `contracts/LOGS.md`) use the same keys, except that a `spans` key has one more level,
  `…/day={YYYY-MM-DD}/hour={HH}/L0-…` (`dataKeyPrefix` in `contracts/ledger.ts`).
- **Pool and shard names** (`POOL_NAME`, `SHARD_NAME` in `contracts/ledger.ts`) are segments
  of `[A-Za-z0-9-]` joined by `/`: a pool name at most 120 characters, a shard name
  (`{pool}/{slot}`) at most 128. They never contain `_`, so the replacement above is
  one-to-one: two streams of a tenant can never write keys with the same shard part, and a
  key's shard part names exactly one stream (the orphan sweep judges a flush file by it).
  A pool map naming another pool is refused where it is read (edge: 503); a shard object
  addressed by another name serves nothing; the ledger answers `invalid` to a unit of a
  stream named otherwise and refuses to register it. (Added 2026-11-19; every name in use
  already fits, so nothing written before changes.) The pool a pool map names (the base of
  the derived span and log pools) also never ends in `/traces` or `/logs`
  (`contracts/BATCH.md`, "Streams per signal"); edge refuses such a map in the same way.
- `hash8` is the first 8 hex characters of the SHA-256 of the file bytes.
- Files are written with `If-None-Match: *`.

Compaction outputs have no stream, so their names carry what they were made from instead:

```
{cell}/data/{table}/tenant={tenant}/day={YYYY-MM-DD}/L{level}-{span}-{inputs16}-{hash8}.parquet
```

- `level` is 1 for a file merged from one UTC hour's flush files, 2 for a file of a closed
  day. `span` is `h{HH}` (the hour, 00–23) at level 1 and `d` at level 2. A level-1 file is
  clustered by hour, not hour-pure: its hour is that of its newest row.
- `inputs16` is the first 16 hex characters of the SHA-256 of the keys of ALL inputs of the
  merge, both tables, samples keys first, each list sorted, joined by newlines. The samples
  output and the series output of one merge share it.
- **Pairing.** A samples file and the series file it must be read with have the same key
  once the table name and `hash8` are removed. This holds for flush files (same segment)
  and compaction outputs (same `inputs16`), and a pair enters and leaves the ledger in one
  change.
- **Precedence.** When files of one table and day hold the same `(series_id, ts)`, the
  file with the higher **precedence** wins, in a read and in a merge alike; within one
  file the latest row already won. Precedence is assigned by the ledger
  (`contracts/ledger.ts`, `LiveFile`): a flush file ranks by the version of the `add_unit`
  that admitted it, a compaction output covers the range of its inputs, and the ledger
  admits an output only if it jumps over no live file that overlaps it in time. Readers
  pass files to the engine in `Plan.files` order (ascending precedence) and compaction
  passes its inputs in ascending precedence, so a sample rewritten by a later write has
  the later value whether it is in the tail, in flush files or in compaction outputs.
  Key order means nothing here: keys sort as text (`…-10-12-…` before `…-2-9-…`). (This
  replaces an earlier rule, "the one later in key order wins", which let an older write
  win from a stream's tenth sequence number on and was not defined across a compaction.)

## The index fragment

`FileEntry.index`, compact JSON, one entry per row group in file order:

```
{"v":1,"rg":[{"rows":N,"off":N,"len":N,"min_name":S,"max_name":S,"min_ts":N,"max_ts":N,"sid":[N,N]},…],"foot":[N,N]}
```

- `off`, `len`: byte offset of the row group's first page and the length of its column
  chunks, which are contiguous. `min_name`, `max_name`: exact, byte order. `min_ts`,
  `max_ts`: exact (`metric_series`: over the `min_ts` and `max_ts` columns).
- `sid`: the `series_id` of the row group's **first and last row**. With the sort order, a
  row group holds only keys `(metric_name, series_id)` between `(min_name, sid[0])` and
  `(max_name, sid[1])`: a series of name `n` can be in it only if `min_name ≤ n ≤ max_name`,
  and `series_id ≥ sid[0]` when `n = min_name`, `series_id ≤ sid[1]` when `n = max_name`.
- `foot`: offset and length of everything after the last row group (offset index, footer
  metadata, the closing length and magic), so a reader can range-read the footer and the
  row groups it needs at once, without first reading the end of the file.
- **Versioning.** `sid` and `foot` were added on 2026-11-19, additively within version 1
  (COMPATIBILITY.md §3.1, §4): a reader that does not know them ignores them (the engine's
  reader before this change, and the publisher, do); a reader that knows them treats their
  absence as "unknown" (prune by name and time only, read the whole file); a fragment in
  which either is malformed does not parse, and its file is read whole, never skipped.
  Files written before 2026-11-19 keep fragments without them until compaction rewrites
  them. The integers are 64-bit: a JavaScript reader must not read `sid` as a number.
- Cost: about 50 bytes a row group and 20 a file of ledger state (`LEDGER-LOG.md`, the
  16 MiB state cap).

### Reading part of a file

A reader that knows which series it needs (it has resolved its matchers against the
`metric_series` files, or it owns a range of `series_id`s) may fetch, of a
`metric_samples` file, only `foot` and the row groups whose key range can hold one of
those series and whose `[min_ts, max_ts]` overlaps its time range. It must fall back to the
whole file when the fragment has no `foot`. The same holds for `metric_series` files by
name. Nothing about the files changes for a reader that reads them whole.

## Per-file statistics reported to the ledger

See `FileEntry` in `ledger.ts`.
