# Shard

The first piece of viz product code: the pooled shard Durable Object and its routing.

A shard is the write-ahead log for incoming telemetry. One shard object serves several
tenants. Each tenant's log inside it is a **stream**, identified by
`(shard, tenant, incarnation)`; sequence numbers, seals, discard marks, quotas and dedup
fingerprints all belong to a stream. A dedicated tenant is a pool of its own, so pooled and
dedicated tenants run the same code.

| File | Contents |
|---|---|
| `src/shard.ts` | `Shard`: append, seal, pending segments, read segment, recorded, tail read, alarm housekeeping |
| `src/pool.ts` | Pool maps and routing: which slots a tenant may use, which slot a sender goes to |
| `test/` | 18 tests, run inside the Workers runtime |

## What is implemented

- **Durable acknowledgement.** `append` returns after the batch is written to SQLite; the
  runtime holds the response until the write is durable.
- **Per-tenant sequencing and dedup.** Retries with the same fingerprint return the original
  sequence number. The same fingerprint from another tenant is a different batch.
- **Backpressure that does not cross tenants.** Each tenant has its own byte cap. When the
  whole shard is over budget, only tenants above their fair share are refused; there is a
  hard ceiling at twice the budget.
- **Seal on size or age**, per stream, with the boundary written durably.
- **Recorded marks** accepted only at the next segment boundary and for the current
  incarnation.
- **Discard with a fence.** Payloads are dropped after a retention window; a tail read
  asking about rows below the discard mark is refused rather than answered with a gap.
- **Tail reads scoped to one tenant.**
- **Map-epoch fencing** per stream.
- **Batch size cap (contracts v2).** `append` answers `{ status: 'too_large', maxBytes }`
  for a payload over `maxBatchBytes` (configurable, default `MAX_BATCH_BYTES` = 1,048,576,
  the one place the number of `contracts/BATCH.md` exists in code; `edge` imports it).
  Nothing is stored and no stream is created for a tenant whose first payload is too large.
- **New incarnation after storage loss**, so sequence numbers are never silently reused.
  **Incarnations are monotonic in time**: `newIncarnation(now, random)` is
  `now_ms * 1024 + 10 random bits`, so a stream recreated at a later millisecond always
  gets a larger number (verified by test, with the worst-case random bits), and the value
  is a safe integer until the year 2248. The only ways to get a non-increasing value are
  two creations of the same stream in one millisecond or a clock that steps backwards
  across a storage loss; the ledger refuses a lower incarnation, so that fails closed.
- **One alarm per shard**, set to the earliest deadline and absent when idle.
- **Shuffle-shard routing**: each tenant gets a small subset of the pool by rendezvous
  hashing, so tenants rarely share their whole subset.

## Tests

```
npm install
npm test          # 18 tests in workerd, 2 files
npx tsc --noEmit  # clean
npm run typecheck
```

The isolation tests were checked by breaking the code on purpose. Each of these mutations
makes at least one test fail: dropping the tenant filter from tail reads; applying the
tenant cap to the shard total; removing the discard fence; removing the fair-share check.

## Not implemented yet

- **Group commit.** Each append is one SQLite row. Batching several requests into one row
  to cut billed row writes is not done.
- **A seal notification.** `flush/` reads `pendingSegments` and calls `recorded`, but the
  shard tells nobody when it seals; something has to call flush (see `flush/README.md`).
- **Map-epoch handover**: draining shards and moving fingerprints on a map change.
- **Incarnation handshake** from the shard's side. The shard only reports mismatches;
  `flush/` registers a new incarnation with the ledger when `addUnit` reports one.
- **CPU fairness.** Byte budgets are isolated; a tenant sending many tiny requests still
  shares the object's single thread with its neighbours. Not measured.
- **Load behaviour.** Nothing here has been run under load or on Cloudflare.
