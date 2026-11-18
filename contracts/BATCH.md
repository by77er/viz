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

- **Size.** An encoded batch is at most 1 MiB (1,048,576 bytes), because a shard stores it
  as one value. `edge` splits a slot's rows into as many batches as that takes, in arrival
  order. `Shard.append` answers `too_large` for anything bigger. The number exists once in
  code, as `MAX_BATCH_BYTES` in `shard/src/shard.ts`; `edge` imports it.
- **Labels.** Names and values are valid UTF-8 with no NUL byte. Names are non-empty and at
  most 1,024 bytes; values at most 8,192 bytes; a series has at most 128 labels.
  Empty-valued labels are dropped before encoding. An entry's labels are sorted by name in
  **UTF-8 byte order** (not JavaScript's default string order), names unique, and include
  `__name__`.
- **`series_id`** is FNV-1a 64-bit (offset basis `0xcbf29ce484222325`, prime `0x100000001b3`)
  over the bytes `name 0x00 value 0x00` for each label in sorted order, reinterpreted as a
  signed 64-bit integer. Only `edge` computes it; everything downstream trusts it. Because
  `__name__` is one of the labels, a `series_id` has exactly one metric name.
- **Timestamps** are Unix milliseconds from 0 to 253,402,300,799,999 (years 1970 to 9999),
  so a UTC day is always `YYYY-MM-DD`. `edge` rejects anything else, and anything outside
  the accept window.
- **Rows** are in arrival order. A batch need not be sorted. If a batch holds two rows with
  the same `(series_id, ts)`, the **later row wins**, everywhere: flush, merge and read.
- **Staleness.** A Prometheus staleness marker is the NaN with bits `0x7ff0000000000002`. It
  is stored as a normal value and interpreted only inside the engine. Value bytes are
  copied, never passed through arithmetic: JavaScript engines may rewrite a NaN's payload.
- **Decoders are strict.** Reject a wrong magic or signal, non-zero flags, reserved or
  padding bytes, trailing bytes, an index out of range, unsorted or duplicate label names,
  a missing `__name__`, an empty label value and invalid UTF-8. A batch with
  `n_rows = n_series = 0` is valid and contributes nothing, but is not sent.

## Fingerprint and idempotency

The batch **fingerprint** passed to `Shard.append` is the lowercase hex SHA-256 of the
batch bytes.

Idempotency has two layers, and correctness rests on the second:

1. The fingerprint stops a shard storing an identical retried batch twice.
2. Every reader and writer de-duplicates on `(series_id, ts)`. A retry that is split
   differently (the pool map changed, or the accept window moved between attempts) has a
   different fingerprint and is stored again, and the duplicate rows are then invisible in
   every result and removed at flush and compaction.

So a sender may always retry a whole request. The fingerprint saves storage; it is not what
makes retries safe. (Signals without a natural row key, such as logs, will need their own
answer.)

## Routing

The **routing key** for a series is the string `job=<job>\u0000instance=<instance>` built
from its `job` and `instance` labels (missing label = empty string). For OTLP these two
labels come only from resource attributes (`service.namespace`/`service.name` and
`service.instance.id`); a data-point attribute named `job` or `instance` is renamed
`exported_job` or `exported_instance`, so it can never change where a sender's data goes.
`edge` splits one request into batches per shard slot.

## Responses when a request spans shards

A request succeeds only if every batch is appended. If any append is refused or fails, the
whole request gets a retryable status (429 with `Retry-After` for backpressure, 503
otherwise) and the sender retries all of it. `partial_success` is used only for rows
rejected by validation, which a retry would not fix.
