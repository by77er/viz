# Metrics tables

Rules common to every table:

- Row groups hold at most 100,000 rows, in flush files and compaction output alike.
- `day` is always `YYYY-MM-DD`; timestamps outside years 1970 to 9999 never reach a table.
- **Canonical JSON** means: no whitespace; object keys in UTF-8 byte order (the batch's
  label order); strings escaped as in RFC 8785. (RFC 8785 itself orders keys by UTF-16
  code unit; viz does not.)
- A file's `index` (`FileEntry.index` in `ledger.ts`) is produced and read only by the
  engine; its format is `FileIndex` in `engine/storage`.

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

## Object keys

```
{cell}/data/{table}/tenant={tenant}/day={YYYY-MM-DD}/L{level}-{shard}-{incarnation}-{seqLo}-{seqHi}-{hash8}.parquet
```

- `level` is 0 for flush files. `shard` is the shard name with `/` replaced by `_`.
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
- When files disagree about a `(series_id, ts)`, the one later in key order wins, in a
  read and in a merge alike. Flush keys do not sort by sequence, and a merge changes key
  order, so which value survives a disagreement between FILES is not defined across a
  compaction. Within one stream's segment the latest row wins as stated above; senders
  that never send two values for one `(series, ts)` are unaffected.

## Per-file statistics reported to the ledger

See `FileEntry` in `ledger.ts`.
