# Batch format `VZB1` (metrics)

One batch is one acknowledged unit of ingest for one tenant: the payload of
`Shard.append`. `edge` encodes it; shards never look inside; the engine decodes it for
flush and for tail reads. All integers little-endian.

```
offset  size  field
0       4     magic            ASCII "VZB1"
4       1     signal           1 = metrics
5       1     flags            0
6       2     reserved         0
8       4     n_rows    u32
12      4     n_series  u32
16      ...   series table     n_series entries, see below
...     pad   zero bytes to the next multiple of 8 (from the start of the batch)
...     4*n_rows   series_idx  u32[n_rows]   index into the series table
...     pad   zero bytes to the next multiple of 8
...     8*n_rows   ts          i64[n_rows]   Unix milliseconds
...     8*n_rows   value       f64[n_rows]   IEEE 754 bits, NaN payloads preserved
```

Series table entry:

```
series_id   i64
n_labels    u32
then n_labels times:  u16 name_len, name bytes (UTF-8), u16 value_len, value bytes (UTF-8)
```

Rules:

- Labels in an entry are sorted by name (byte order), names unique, and include `__name__`.
  Empty-valued labels are dropped before encoding.
- `series_id` is FNV-1a 64-bit (offset basis `0xcbf29ce484222325`, prime `0x100000001b3`)
  over the bytes `name 0x00 value 0x00` for each label in sorted order, reinterpreted as a
  signed 64-bit integer. Only `edge` computes it; everything downstream trusts it.
- Rows are in arrival order. A batch need not be sorted and may contain several samples
  for one series.
- A Prometheus staleness marker is the NaN with bits `0x7ff0000000000002`; it is stored as
  a normal value and interpreted by the engine.
- `n_rows` may be 0 only if `n_series` is 0; such batches are not sent.

The batch **fingerprint** passed to `Shard.append` is the lowercase hex SHA-256 of the
batch bytes.

The **routing key** for a row is the string `job=<job>\u0000instance=<instance>` built
from the series' `job` and `instance` labels (missing label = empty string). `edge` splits
one request into one batch per shard slot.
