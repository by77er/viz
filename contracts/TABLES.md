# Metrics tables

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

- Sort order: `metric_name`, `series_id`.
- (Promoted label columns come later; `labels` is the source of truth.)

## Object keys

```
{cell}/data/{table}/tenant={tenant}/day={YYYY-MM-DD}/L{level}-{shard}-{incarnation}-{seqLo}-{seqHi}-{hash8}.parquet
```

- `level` is 0 for flush files. `shard` is the shard name with `/` replaced by `_`.
- `hash8` is the first 8 hex characters of the SHA-256 of the file bytes.
- Files are written with `If-None-Match: *`.

## Per-file statistics reported to the ledger

See `FileEntry` in `ledger.ts`.
