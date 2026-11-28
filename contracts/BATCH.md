# Batch format `VZB1`

One batch is one acknowledged unit of ingest for one tenant: the payload of
`Shard.append`. `edge` encodes it; the engine decodes it for flush and for tail reads. A
shard stores it as sent and reads inside it for three things only: the header (the signal
byte and `n_series`), the metric rows a filtered tail read keeps (D48), and, at append, the
time column of a span or log batch ("Tail reads of spans and log records by time", D72).
All integers little-endian.

| `signal` | Rows | Status |
|---|---|---|
| 1 | metric samples (this section and the next five) | built |
| 2 | spans ("Spans, signal 2" below) | built (2026-11-19): `edge` encodes it behind `INGEST_SIGNALS`; the shards of `{pool}/traces` store it; flush encodes it (`engine/wasm` ABI 3) into `spans` and `trace_index` files the ledger lists (stage 2) |
| 3 | log records ("Log records, signal 3" below) | built as signal 2, into `logs` files, from the shards of `{pool}/logs` |

Every signal has the same 16-byte header (magic, signal, flags, reserved, `n_rows`, and at
offset 12 the size of the batch's entry table) and the same strictness: a decoder rejects
anything an encoder following this file would not produce. Signals 2 and 3 are never mixed
with signal 1 in one shard stream ("Streams per signal" below).

## Metrics, signal 1

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
  `__name__` is one of the labels, a `series_id` has exactly one metric name. It is a
  function of the label set alone, and uses all 64 bits to tell series apart (no bits are
  spent on locality; `design/DECISIONS.md` D19).
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

## Active series

`Shard.append` takes, next to the batch, `seriesIds`: the `series_id` of every entry of
the batch's series table, in table order, as a `BigInt64Array`. `edge` already has them.
For this the shard reads only the header: it checks that the array's length equals the
header's `n_series` (answering `invalid` if not) and uses the ids to count the stream's
**active series**: distinct ids seen in a sliding window of one hour, kept as two
half-hour buckets (so a series stays active for 30 to 60 minutes after its last sample).

With `seriesLimit` (this shard's share of the tenant's limit, from KV `limits:<tenant>` =
`{ "active_series": N }`, default 1,000,000, divided evenly over the tenant's slots and
rounded up), a batch whose new series would take the stream past the limit is refused:

```
{ status: 'series_limit', limit, current, refused: BigInt64Array }
```

Nothing of the batch is stored. `refused` holds the ids that are new to the window and do
not fit; ids already active are never in it. `edge` rebuilds its batches without those
series and appends again, so samples of existing series are accepted at the limit. The
sender is told: Remote Write gets 429 naming the limit and how many samples were written;
OTLP gets `partial_success` with the refused points counted and the same message.

The count is exact up to 4,096 ids per bucket and an estimate above (HyperLogLog, standard
error 1.6%); membership above that threshold is a Bloom filter, so about 1% of new series
can pass as existing while a stream is at its limit. A batch sent without `seriesIds` is
not metered. `Shard.seriesCount(tenant)` reports the current count.

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

**What a refusal stored** (added 2026-11-28, D77). A **429 stores nothing** of the request:
no batch of it was newly appended to any shard (a batch some earlier request had already
stored may be there, under its fingerprint). A **503** may have stored part of it; the
sender's full retry stores each batch once (fingerprints) and readers de-duplicate the rest
(above), so a sender that retries loses nothing and duplicates nothing it can see. A sender
that gives up after a 503 may leave part of its request stored; after a 429 it leaves none.

How `edge` keeps that promise: a request of more than one batch first asks every shard it
routes to for room (`Shard.reserve`, one call per shard, all at once) and appends only once
every shard has granted it. A grant holds the batches' bytes against the tenant's and the
shard's room (its cap, the shard's budget and fair share) until it is used, released or
expires (`reservationTtlMs`, 5 s from its last use: each append under it extends it); against
the in-flight limits (D37) it counts as **one append of its largest batch**, since its batches
are appended one at a time (changed 2026-11-28 by the review of D77, M-1: it had counted every
batch and their sum, which refused a request of more than `maxInFlight` batches or
`maxPendingBytes` bytes to one shard for ever). An append that carries its token
(`AppendRequest.reservation`) is not refused for room or for load. A refusal at `reserve`
(backpressure, overload, `registering`, `stale_epoch`, `too_large`) appends nothing, and the
other grants are released. **No grant outlives its request** (review M-2): an append under a
grant that is refused (anything but `ok`, a duplicate being an `ok`) or fails drops what is
left of the grant at the shard, and `edge` releases the grant of every slot that stopped before
its last batch. Anything refused after an append of the request stored a batch is answered 503,
never 429. A request of one batch is appended directly: one append is all or nothing. The grant
is memory only: a shard that restarts between the two calls forgets it, and the append is then
admitted as one without a token (and, if refused there, answered 503).

`Shard.reserve` with `hold: false` answers the same question without holding anything (a
probe): `edge` uses it before decoding a body it has seen refused (D77). A probe of a tenant
the shard has no stream for creates none and starts no registration (review n-1).

## Decode limits (every signal; added 2026-11-19, review M-3)

What `edge` builds while it decodes a request is bounded whatever the body's shape: a protobuf
key-value entry or array element can be two bytes on the wire and fifty in memory, and a
resource is copied into every series or entry it has. These limits are counted while the body
is read, before anything is built, so an item is refused at the limit instead of after it has
been built. They are `edge`'s; nothing downstream checks them.

- **Values per item.** At most **65,536 key-value entries and array elements**, at any depth,
  counted as received, in each of: a span with its events and links; a resource with one of
  its scopes (spans); a log resource; a log scope; a log record (its body and attributes) or a
  Loki entry (its structured metadata); a Loki stream's label set; a metric resource; a metric
  data point. Every entry counts, including a repeated key (which OTLP forbids: "keys MUST be
  unique"), an entry with an empty value and an empty key-value list, which the mappings
  then drop. An item over the limit is refused on its own, and the rest of the request is
  decoded as before; a resource or scope over it refuses every span, record or point under
  it. A data point (or every point of a resource) over it is refused as `label set too large
  to fit one batch`: no series can hold that many labels.
- **Events and links** past the 128th of a span are read but not built; the span is refused
  for its events or links, as before.
- **Which reason.** An item over the values limit is refused for it after the checks that need
  only its scalar fields (ids, kind, status, timestamps, event and link counts), which keep
  their reasons. The checks that need its attributes are not made, so an item that also breaks
  one of those is named for the values limit. An item under the limit is checked exactly as
  before. Likewise a span whose attribute list passes 256 KiB while it is encoded is refused
  as over 256 KiB without the keys after that point being checked.
- **Decoded size per request.** At most `maxDecodedBytes` (16 MiB unless the deployment sets
  less or more) of decoded data: the series table for metrics, the entries (or streams) and
  rows for spans and logs. Over it the request is refused whole: 413, nothing appended. This
  bounds the copies a resource makes: one resource's labels in every series of it, one
  resource's attributes in every (resource, scope) entry.
- **JSON bodies.** At most `maxJsonTokens` (1,048,576 by default) structural characters
  (`{`, `[`, `,` and `:` outside strings), counted before the body is parsed, because parsing
  builds every value at once. Over it: 413.
- **Body size.** `maxDecompressedBytes` is 8 MiB by default (`design/DECISIONS.md` D71).

## Rules common to signals 2 and 3

Settled 2026-11-19 with the first encoder (`edge/src/spans.ts`, `edge/src/logs.ts`) and
decoder (`engine/storage/src/otel.rs`).

**Layout.** The 16-byte header as for metrics: magic `VZB1`, `signal`, `flags` 0,
`reserved` 0, `n_rows` u32, and `n_entries` u32 at offset 12 (resources for spans, streams
for logs). Then the entry table, then the columns in the order listed for the signal.
**Every column starts at a multiple of 8** from the start of the batch (zero padding before
it), and the batch ends at the end of its last column padded with zeros to a multiple of 8.
A fixed-width column is `n_rows` values back to back. A **variable-length column** is
`off u32[n_rows + 1]` (`off[0] = 0`, never decreasing), then, starting at the next multiple
of 8, `off[n_rows]` data bytes; row `i`'s value is `data[off[i]..off[i+1]]`.

**Strings** are valid UTF-8. `edge` replaces invalid sequences in OTLP strings with U+FFFD, as
the OTLP specification recommends ("UTF-8 String Handling"), rather than refusing the item.

**Typed attribute list** (`attrs`), used for resource and span attributes:

```
n        u16                   at most 128
n times: key_len u16, key      UTF-8, 1 to 1,024 bytes
         type u8, then         1 string: len u32, UTF-8, at most 65,536 bytes
                               2 int:    i64
                               3 double: u64, the IEEE 754 bits as received
                               4 bool:   u8, 0 or 1
                               5 other:  len u32, canonical OTLP JSON of the AnyValue, at most 65,536 bytes
```

Entries are sorted by key in UTF-8 byte order and keys are unique: when OTLP sends a key
twice in one list, the **last** value is kept. "Other" is an array, a key-value list, bytes,
or an AnyValue with no value set (`{}`).

**Canonical OTLP JSON** is the OTLP/JSON encoding (OTLP specification, "JSON Protobuf
Encoding") written one way only, so that equal values have equal bytes:

- an AnyValue is exactly one of `{"stringValue":S}`, `{"boolValue":true|false}`,
  `{"intValue":"<decimal>"}`, `{"doubleValue":N}`, `{"arrayValue":{"values":[…]}}`,
  `{"kvlistValue":{"values":[…]}}`, `{"bytesValue":"<base64>"}`, or `{}`; an empty array
  or list is `{"arrayValue":{}}` / `{"kvlistValue":{}}`;
- a key-value list is `[{"key":K,"value":V},…]`, at every depth sorted by key in UTF-8 byte
  order with the last of duplicate keys kept; arrays keep their order;
- `<decimal>` has no sign for zero or positives, no leading zeros; base64 is RFC 4648 with
  padding; `N` is ECMAScript `Number.prototype.toString` of the double, except that NaN and
  ±Infinity are the strings `"NaN"`, `"Infinity"`, `"-Infinity"` (proto3 JSON);
- strings are escaped as `JSON.stringify` (RFC 8785) escapes them; no whitespace anywhere.

**Plain JSON text** of an AnyValue (for log lines and label values made from OTLP values):
a string is itself (unquoted, at the top level only); otherwise the JSON value: booleans,
integers as decimal digits (exact), doubles as above (NaN and ±Infinity as quoted strings),
bytes as a base64 string, arrays in order, key-value lists as objects with keys sorted by
UTF-8 bytes (last duplicate kept), an empty AnyValue as `null`.

**Timestamps** are Unix nanoseconds as i64, from 0 to 2^63−1 (1970-01-01 to
2262-04-11T23:47:16.854775807Z): what an INT64 nanosecond column can hold. `edge` rejects
anything else, and anything outside the signal's accept window.

**Decoders are strict**, as for metrics: wrong magic or signal, non-zero flags, reserved or
padding bytes, trailing bytes, an entry index out of range, offsets that decrease or point
past the data, a string that is not UTF-8, attribute lists unsorted or with duplicate or
empty keys or unknown types, a value outside the ranges stated here: all are errors.
`n_rows = 0` with `n_entries = 0` is valid and contributes nothing, but is not sent.

## Spans, signal 2

**Entry table: one entry per (resource, instrumentation scope) pair.**

```
resource_fp   i64        FNV-1a 64 (as series_id) over the canonical OTLP JSON of the full
                         resource attribute list, as a signed integer
resource      attrs      the full resource attribute list, typed
scope_name    u16 len, UTF-8, at most 8,192 bytes
scope_version u16 len, UTF-8, at most 8,192 bytes
scope_attrs   u32 len, canonical OTLP JSON key-value list of the scope's attributes;
                         length 0 when the scope has none
```

An entry is at most 256 KiB. `resource_fp` is computed only by `edge`; downstream trusts it
(decoders do not recompute it, as for `series_id`).

**Columns** (`n = n_rows`):

| # | Column | Type | Meaning |
|---|---|---|---|
| 1 | `entry` | u32[n] | index into the entry table |
| 2 | `trace_id` | 16 bytes × n | never all zero |
| 3 | `span_id` | 8 bytes × n | never all zero |
| 4 | `parent_span_id` | 8 bytes × n | all zero: no parent (OTLP's empty or all-zero parent) |
| 5 | `start` | i64[n] | `start_time_unix_nano` |
| 6 | `end` | i64[n] | `end_time_unix_nano`, never before `start` |
| 7 | `flags` | u32[n] | OTLP span flags, 0 when not sent |
| 8 | `dropped` | u32[3n] | per row: dropped attributes, events, links counts as received |
| 9 | `kind` | u8[n] | 0 to 5 (OTLP `SpanKind`) |
| 10 | `status` | u8[n] | 0 to 2 (OTLP `StatusCode`) |
| 11 | `name` | variable | UTF-8, at most 8,192 bytes; may be empty |
| 12 | `trace_state` | variable | UTF-8, at most 8,192 bytes |
| 13 | `status_message` | variable | UTF-8, at most 8,192 bytes |
| 14 | `attrs` | variable | a typed attribute list (span attributes) |
| 15 | `events` | variable | `n_events u16` (at most 128), then per event: `time i64`, `name_len u16`, name, `attrs_len u32`, canonical OTLP JSON key-value list (`[]` when none), in OTLP order |
| 16 | `links` | variable | `n_links u16` (at most 128), then per link: `trace_id` 16 bytes, `span_id` 8 bytes, `trace_state_len u16`, trace state, `attrs_len u32`, canonical OTLP JSON key-value list, in OTLP order |

A row is at most 256 KiB, counting 94 bytes (its fixed columns, 70 bytes, and its six
offsets) plus its variable-length bytes, so a row and its entry always fit one batch.

What `edge` does before encoding (each refusal is per span, counted in `partial_success`):
a `trace_id` that is not 16 bytes or is all zero, a `span_id` that is not 8 bytes or is all
zero, a `parent_span_id` of another length than 0 or 8, a kind or status code outside the
enums, a start or end outside the timestamp range or a start outside the accept window, an
attribute with an empty key, more than 128 attributes in a list, a key over 1,024 bytes, a
value over 65,536 bytes, more than 128 events or links, a link whose ids have the wrong
length, a field over its limit and a row over 256 KiB are refused; every span of a resource
whose entry would be over 256 KiB is refused; so is a span, and every span of a resource and
scope, over the decode limits ("Decode limits"). A span whose end is before its start is
stored with `end = start` and the span attribute `viz.clamped_end = true` (bool).

Not carried (not in `contracts/TRACES.md`'s tables): `schema_url`, the span's
`type` (OTLP 1.12, development), event and link `dropped_attributes_count`, link `flags`,
`entity_refs`, the resource's `dropped_attributes_count`.

**Row key and duplicates.** A span is identified by `(trace_id, span_id)`. If one tenant's
data holds two rows with the same key, the **later row wins**, everywhere: within a batch the
later row, across batches the later batch, across files the file of higher precedence
(`contracts/TABLES.md`), as `(series_id, ts)` does for metrics. A retried request is stored
again only if it was split differently, and is invisible after de-duplication.

## Log records, signal 3

**Entry table: one entry per stream**, exactly a metrics series entry without the
`__name__` rule:

```
stream_id   i64          FNV-1a 64 over `name 0x00 value 0x00` per label, as series_id
n_labels    u32          at most 32 (contracts/LOGS.md)
n_labels times: u16 name_len, name, u16 value_len, value
```

Labels are sorted by name in UTF-8 byte order, names unique, values non-empty; names match
`[A-Za-z_][A-Za-z0-9_]*` and are at most 1,024 bytes; values at most 8,192 bytes, no NUL.
`stream_id` is computed only by `edge` and is exactly `series_id`'s function of the labels.

**Columns** (`n = n_rows`):

| # | Column | Type | Meaning |
|---|---|---|---|
| 1 | `entry` | u32[n] | index into the stream table |
| 2 | `ts` | i64[n] | Unix ns |
| 3 | `observed_ts` | i64[n] | OTLP `observed_time_unix_nano`; 0 when absent |
| 4 | `trace_id` | 16 bytes × n | all zero when absent |
| 5 | `span_id` | 8 bytes × n | all zero when absent |
| 6 | `flags` | u32[n] | OTLP log record flags; 0 when absent |
| 7 | `severity_number` | u8[n] | 1 to 24; 0 when absent |
| 8 | `line` | variable | UTF-8, at most 262,144 bytes (256 KiB); may be empty |
| 9 | `severity_text` | variable | UTF-8, at most 1,024 bytes; empty when absent |
| 10 | `metadata` | variable | per row: `n u16` (at most 128), then `name_len u16, name, value_len u16, value` per entry, sorted by name in UTF-8 byte order, names unique and following the label-name rule, values non-empty, at most 8,192 bytes and without NUL, names and values together at most 65,536 bytes |

With these limits a row and its stream entry always fit one batch.

**Row key and duplicates** (`contracts/LOGS.md` §4): `(stream_id, ts, line, metadata)`.
Rows equal on all four are one row; the later row wins for the other columns.

## Streams per signal (built, stage 2)

Spans and log records are appended to shards of their own, so that a shard stream (and so a
sealed segment, a flush and a tail read) holds one signal only: for a tenant whose pool map
is `{pool, slots, spread, epoch}`, spans go to the pool `{pool}/traces` and log records to
`{pool}/logs`, with the same `slots`, `spread` and `epoch`. Shard names stay
`{pool}/{slot}` (so `shared/c1/traces/3`), and keys, streams, watermarks and units need no new
field. The base pool name must therefore be at most 113 characters; `edge` refuses a tenant
whose derived pool name breaks `POOL_NAME` (503). **A base pool name never ends in `/traces`
or `/logs`** (added 2026-11-19, stage 3): otherwise the metric shard `{base}/{slot}` of a pool
`p/traces` would be the very object, and carry the very name, of the span shard
`p/traces/{slot}` of a pool `p`, and readers that tell a shard's signal by its name (`query/`,
D62) would take metric shards for span or log shards. With the rule, a shard named
`…/traces/{slot}` or `…/logs/{slot}` is always a span or log shard and the three signals' shard
names never meet. `edge` refuses a pool map (`pool:<tenant>` or `DEFAULT_POOL`) whose pool
breaks it, for every signal, metrics included (503, as for a name outside `POOL_NAME`);
`POOL_NAME` itself cannot say it, since the derived pools end so. `design/DECISIONS.md` D57
gives the alternatives. `control`, which writes `pool:<tenant>`, refuses to assign such a pool
(`PUT /settings/pool`: 422 `invalid`, field `pool`), so it never publishes a map `edge` would
refuse for this reason. Tenant ids are not restricted for it (`TENANT_ID` is unchanged): a
tenant whose id is `traces` or `logs` can be created and uses the shared pool, but cannot have
the dedicated pool `tenant/<id>` (D66). As built, `edge` appends there only when `INGEST_SIGNALS` enables the signal.
The derivation is one function, `signalPool` in `shard/src/pool.ts`, used by `edge`, flush's
sweep and the stack's tests. Flush reads a segment's signal byte and refuses a segment whose
batches are not all of one signal it flushes (`unreadable_segment`). A filtered tail read
chooses batches by this byte (`TailFilter.signals`, `shard/src/tail.ts`): a metrics read passes
`signals: [1]`, a span or log read `[2]` or `[3]`, and gets those batches whole; with a time
range, only those whose time bounds overlap it (next section).

## Tail reads of spans and log records by time (added 2026-11-19, D72; revised after its review)

A shard records, once, when it appends a span or log batch, the batch's **time bounds**: the
floor, in Unix milliseconds, of its smallest and largest span `start` (signal 2) or log `ts`
(signal 3), the same floor the ledger takes of a file's nanosecond bounds (D63). It finds that
one column by walking the entry table's length fields, without decoding the batch, and keeps the
bounds with the batch. The batch format does not change: nothing here is in the bytes `edge`
sends, and the bounds are the shard's own, never sent to a reader.

**The one layout a shard reads, and how a later one must say so.** This walk is the only place a
shard reads the layout of signals 2 and 3. It accepts exactly the layout this file defines up to
that column: magic `VZB1`, signal 2 or 3, **`flags` 0 and `reserved` 0** (offsets 5 to 7), at
least one entry, and zero padding before and after the `entry` column. A batch with anything
else there gets **no bounds**, and every time range keeps it; it is still stored and
acknowledged (an append is never refused for its bounds). So a revision of signal 2 or 3 that
changes the entry table (to carry, say, `schema_url` or the resource's
`dropped_attributes_count`) or the columns before `start` or `ts` **must signal itself in the
header**: a new magic, a new signal number, or a non-zero `flags` or `reserved` byte. Signalled
so, it needs no shard release first: a shard of this release keeps such batches by every range.
Unsignalled, a shard would record bounds from the wrong bytes and skip batches holding rows in
range; such a change must update the shard first, as every other reader of the layout
(COMPATIBILITY §3.3).

A filtered tail read (`TailReadOptions` `v` 1, `shard/src/tail.ts`) with a time range
`[minTs, maxTs]` (inclusive milliseconds) returns a span or log batch it admits **whole**, as
before, when the batch's bounds overlap the range (`max ≥ minTs` and `min ≤ maxTs`), and skips it
when they do not. **Deciding reads the bounds, not the batch**: a skipped batch's payload is not
read from storage. A batch **without bounds** is kept by every time range: one stored before
this, one appended by a shard of the release before (which ignores the bounds), and one the walk
does not accept (above). Metric rows are filtered by time as before, one by one.

**Pages** (D48, with one addition). One call examines at most `TAIL_SCAN_MAX_BYTES` (32 MiB) of
stored batches, as before, and now also considers at most `TAIL_SCAN_MAX_BATCHES` (32,768)
batches, skipped ones included; the rest is the next page's, through `page.next`, which may name
a batch the read then skips. A page can therefore hold no batch and still continue the read (as
under D48 when a filter kept nothing). A skipped batch is not examined: it counts in neither
`scannedBatches` nor `scannedBytes`. `through`, cursors, the discard fence and every refusal are
as before; the time range is part of the filter a cursor is bound to. A `page_limit` names only
a batch the read keeps, and carries **`last`** (added with this revision): `true` when no batch
after it, up to `through`, can hold a row the read keeps by its time bounds, so that its `bytes`
plus what the read holds is the whole answer; `false` when one may. A read that admits only metric batches
(`signals` without 2 and 3) consults no bounds: it examines every batch above its watermark, as
before D72, and its `page_limit` says `last` only for the tail's last batch. A shard of an earlier release
sends no `last` (read it as unknown).

**What a caller passes.** A reader that needs every span starting (or record stamped) in the
nanosecond range `[lo, hi]` passes `minTs = floor(lo / 10⁶)` and `maxTs = floor(hi / 10⁶)`:
a row at `t ∈ [lo, hi]` has `floor(t / 10⁶)` in `[minTs, maxTs]` and in its batch's bounds, so
its batch is returned. A trace query passes the bound it reads spans in (its window widened by
`traceMarginMs`, D62), never the window alone. A batch is returned whole, so it can hold rows
outside the range; the reader still selects rows. `minTs > maxTs` is refused (`invalid`): a
reader whose range is empty reads no tail at all.

**What skipping can change, and release skew.** Skipping drops only batches with no row inside
the range. A reader whose answer depends on rows outside the range can therefore see a
difference: a later copy of a span (same `trace_id` and `span_id`) that starts outside the range
hides an earlier copy inside it only if its batch is read. A reader must drop rows outside the
range before it de-duplicates them (query does, D62; review of D72, m-2); then a shard of the
release before, which ignores the range for span and log batches and returns every batch of the
signal, gives the same answer, and a caller needs no change for skew.

## Routing (signals 2 and 3)

As for metrics, by sender: the routing key is `job=<job>\u0000instance=<instance>`.

- **OTLP traces and logs**: per resource, `job` is `service.name` with `service.namespace/`
  in front when that is set, and `instance` is `service.instance.id`; string values as they
  are, any other value as its plain JSON text. For the string values every sender uses, this
  is the key the OTLP metrics path builds, so one sender's metrics, spans and logs take the
  same slot number in their pools.
- **Loki push**: per stream, from its `job` and `instance` labels (missing = empty), as for
  Remote Write.

`edge` groups rows by slot and splits each slot's rows into batches of at most
`MAX_BATCH_BYTES`, in arrival order.

## Fingerprint, metering, responses (signals 2 and 3)

- **Fingerprint**: the lowercase hex SHA-256 of the batch bytes, as for metrics; it saves
  storage, the row keys above make retries safe.
- **Active series**: span batches are sent without `seriesIds` (not metered). Log batches
  too, for now; metering active streams with the same mechanism (`seriesIds` = the stream
  ids, against a separate per-tenant limit) is proposed, not built.
- **Responses** follow "Responses when a request spans shards": a request succeeds only if
  every batch is appended; `partial_success` (OTLP) and 400 (Loki push) are used only for
  items refused by validation.
