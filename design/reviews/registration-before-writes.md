# Adversarial review: registration before writes (R2) and the F16 fix

Reviewer stance: adversarial, not the author; not given the author's reasoning beyond what the
proposal itself says. Scope: `spec/README.md`, section "Proposed fixes: registration before
writes (F6, F6(b)) and the lost-incarnation leak (F16)" (variant R2 with the F16 fix), against
the code as built on 2026-11-19: `shard/src/shard.ts`, `ledger/src/ledger.ts`, `flush/src/`,
`query/src/coordinator.ts` and `tail.ts`, `janitor/src/`, `edge/src/route.ts` and `index.ts`,
and the contracts `contracts/ledger.ts`, `contracts/LEDGER-LOG.md`, `contracts/COMPATIBILITY.md`;
design text `design/DESIGN.md` §4 and §6.1–6.2, `design/DECISIONS.md` D30, D36, D37, D38, D46,
D47, D48. Nothing is built yet; this reviews a design and its code plan.

Model runs were made on a copy of `spec/bfs/` in a scratch directory, never in the tree (running
`bfs/run.ts` in place rewrites `spec/results/`). The copy adds one invariant and one option, both
described under "Model runs"; every configuration of the proposal is otherwise unchanged.

**Summary.** The safety core of R2 held under every attack I tried: an acknowledgement is
preceded by a registration in the logged prefix, a logged registration survives every rebuild
from the log, so every plan names every stream that holds acknowledged rows, and a shard asked
about an incarnation it lost answers with a fresh one instead of "ok, nothing". I found no
sequence that loses, duplicates or hides an acknowledged row, and my extra runs (two shard
losses, two ledger losses with a new invariant, the F16 fix with two shards and two tenants,
re-registration only where the planned code would call) found none either, within their bounds.
What breaks is around it: the planned ledger column `logged_inc` is maintained only by the new
release, so an ordinary rollback and roll-forward refuses a stream's writes for good (blocker);
the planned append path awaits the ledger, outside D37's early refusal (major); and edge, which
the proposal leaves unchanged, answers the new refusal 429, which Remote Write senders may drop
(major). Nine minors: an unbounded refusal with no alert while a ledger cannot log, a cached
`registered` flag that nothing clears, reads that create durable streams nothing retires, a
refusal burst on map changes that R2 could avoid, the six-connection budget, release skew at the
janitor, S5, the contract's shape, and the latency figures.

**Verdict: build R2 with changes** (B-1, M-1 and M-2 before building; the minors with it or
recorded as open). Not R3 or R4; reasons at the end.

| # | Severity | Property | Where | Model could reproduce? |
|---|---|---|---|---|
| B-1 | blocker | unbounded refusal; COMPATIBILITY §2.3, §6 | proposal: `ledger/` code change (`spec/README.md:1034-1042`); `ledger/src/ledger.ts:796-799`, `:1279-1293`; D46 | no: the model derives `loggedIncs` from the log; no release skew |
| M-1 | major | D37 (overload bound); DESIGN §4.3 tenant isolation | proposal: `shard/` code change (`spec/README.md:1023-1027`) vs. its own table (`:843`); `shard/src/shard.ts:483-487` | no: no concurrency limit, memory or time in the model |
| M-2 | major | AGENTS "Overload returns a retryable status"; D37 | `edge/src/route.ts:292-301`, `edge/src/index.ts:72`, `:258-260`; proposal `spec/README.md:1050` | no: no HTTP or sender in the model |
| m-1 | minor | write availability (unbounded refusal) | `ledger/src/ledger.ts:192-193`, LEDGER-LOG "Drain"; proposal `:852`, `:1102-1105` | in principle (a stuck drain); not run, the result is immediate |
| m-2 | minor | statement 1 outside the model's faults; proposal text vs. code plan | proposal F1 fix (`spec/README.md:516-519`) vs. `:1023-1033`; `flush/src/flush.ts:258-270` | the oracle half: checked, not load-bearing; the log-loss half: no |
| m-3 | minor | leak; cost; tenant deletion | `query/src/coordinator.ts:515-519`; proposal `:1028-1029`, `:1045-1047` | no: no map changes, no deletion |
| m-4 | minor | availability on map changes | DESIGN §4.1; D13 | no |
| m-5 | minor | six-connection limit (unmeasured) | `shard/src/shard.ts:633`; `spikes/s1-fanout-r2/` | no |
| m-6 | minor | COMPATIBILITY §1.1, §3.3 | proposal `:1045-1047`; `janitor/src/janitor.ts:293-299` | no |
| m-7 | minor | S5 fails closed with no remedy | proposal `:1029-1031`; `shard/src/shard.ts` `newIncarnation` | no (S5 not modelled) |
| m-8 | minor | contract shape; log format | proposal `:996-999`; `contracts/ledger.ts` `Watermark`, `LedgerChange.watermark` | n/a |
| m-9 | minor | evidence: modelled latency and cost | proposal `:848`, `:979-985`, `:1031-1033` | n/a |

---

## Blocker

### B-1. `logged_inc` is maintained only by the new release: a rollback and roll-forward refuses a stream's writes for good

The plan (`spec/README.md:1034-1042`): the ledger gains `stream.logged_inc`, advanced in
`segmentWritten` and set by a rebuild; `registerStream` answers `logged = logged_inc >=
ref.incarnation`; the shard accepts a stream's appends only after such an answer. The migration
is not classified. It looks additive (a new column), so `compat` stays where it is and D46's
release tool lets a rollback through it. But the release before does not maintain the column,
and COMPATIBILITY §2.3 lists exactly this as breaking: "Anything newer code *relies on* that older
code does not maintain (a backfilled column, …)".

**Sequence** (tenant T, pooled shard S):

1. Release N+1 runs: the ledger's migration adds `logged_inc` (backfilled by the outbox rule), the
   shard's schema 2 adds `stream.registered`.
2. Rollback to N, for any reason. D46 allows it: no class's `compat` rose.
3. S, on N, takes T's first append (a new tenant; or S lost its storage): `stream()` creates
   incarnation X lazily and acknowledges. The segment is sealed; flush's `addUnit(X, 1..k)`
   registers X in the same transaction (`ledger.ts` `addUnit`, `register`) and is admitted; N's
   drain advances `logged` and never touches `logged_inc`, which stays at the column's default
   (0) for a new row, or at the older incarnation for a stream the ledger already had. Every
   segment is recorded and discarded.
4. Roll forward to N+1. The ledger's migration has already run and does not run again:
   `logged_inc` for S stays 0.
5. T's next append to S: stream X has `registered = 0` (N's insert left the default), so the shard
   calls `registerStream(X)`. Same incarnation, so it is the idempotent path
   (`ledger.ts:796-799`): no change is recorded, and the answer is `logged = (0 >= X)`, false.
   The append is refused `registering`. Every retry is the same.
6. Nothing can move `logged_inc` for (S, X): it moves only when a drained change names X
   (`segmentWritten`), and no unit of X will ever be flushed again because no append of X is
   accepted. T's writes routed to S are refused until the ledger loses its storage, an operator
   calls `restartFromSqlite`, or S loses its storage. Through edge as built they are answered
   429 (M-2).

The same happens to any stream that N re-registers during the rollback (a shard storage loss),
and to **every** stream of a tenant whose ledger N rebuilds during the rollback (N's rebuild
inserts every stream row with the column's default). The F16 fix degrades the same way
(`loggedIncarnation` stays low), in the safe direction: files are kept, not deleted.

**Why the model cannot show it.** `loggedIncs` (`spec/bfs/model.ts:1197`) is recomputed from the
base and the logged prefix of the change history in every state: it is what any release would
derive from the log, not a stored column. The model's only release skew is S-1's rollback to
the first-layout ledger (`maxRB`).

**Change.** Derive both answers from facts every release maintains, instead of storing them:

- `registerStream(ref)` answers `logged: true` iff the stream's committed incarnation is
  `ref.incarnation` **and no outbox row is a `register_stream` change naming
  `(ref.shard, ref.incarnation)`**. Outbox rows are deleted only with their segment, or by a new
  incarnation whose base (already in R2) holds their effect, so a committed registration with no
  pending row is logged. This is the proposal's own migration rule, evaluated at call time and
  narrowed to registrations (a busy stream almost always has an `add_unit` of its incarnation in
  the outbox, so "no change naming it" would refuse a busy pre-existing stream at the upgrade
  until its flushes stop). Both releases write the same outbox, so no rollback can make it
  stale.
- `loggedIncarnation` for the sweep: the committed incarnation under the same condition, else the
  as-built rule (a newer incarnation counts once its logged watermark is above 0). It can only be
  too low, never too high, which is the sweep's safe direction (F15).
- The scan is over the outbox (one drain cycle of rows; more while the drain is stuck). If that
  cost matters, store the kind beside the body in a nullable column that older code leaves NULL
  and readers then parse.

Or make the migration forward-only (`readableFrom` its own version, recorded by D46) and accept
no rollback below it. The derivation is cheaper than a forward-only ledger release. Either way,
the ledger needs a test that runs the rollback and roll-forward above, with the release before
as the old code, and shows the stream accepted afterwards (the ledger keeps older code under
`ledger/bench/` for this kind of comparison).

## Major

### M-1. The append path awaits the ledger, outside D37's early refusal

The proposal's own table says an append before the registration is logged is "refused at once
… the shard never holds an append across the ledger's R2 write" (`spec/README.md:843`). The code
plan says `append` calls `ensureRegistered` "before joining a group", which, if `registered = 0`,
calls `registerStream` ("one call in flight per tenant, later callers await it") and answers
`registering` unless the answer is logged (`:1023-1027`). So every append to an unregistered
stream is held for at least one shard→ledger round trip, with its payload in the shard's memory.

D37's bound is applied before that (`shard.ts:483-487`) and counts only appends that have joined
the group (`inFlight` is incremented when an append is pushed into the group). An append waiting
in `ensureRegistered` is either outside the bound or inside it; both break something.

**Sequence (outside the bound).** Pooled shard S holds 40 tenants and loses its storage, the
event the proposal exists for: every tenant's next append finds no stream. Tenant A's ledger is
starting an incarnation (a rebuild: 5.4 s for 5,008 changes measured on Cloudflare, 20 s for
300,000 files measured locally, D47), so `registerStream` waits `START_WAIT_MS` (2 s,
`ledger.ts:233`) and is refused. A's senders keep their requests in flight (Prometheus sends up
to `max_shards` requests at once per remote, 50 by default: training knowledge), each split by
edge into batches of up to 1 MiB (`MAX_BATCH_BYTES`). All of them wait on A's one call, holding
up to ~50 MiB in S's isolate for 2 s, then retry. A few such tenants pass the 128 MB isolate
limit (modelled from those numbers, not measured); the isolate is reset, every in-flight append
of every tenant of S fails, and the senders' retries rebuild the same pile. D37 promised refusal "before it reads or writes anything" at 64 in flight
or 16 MB pending; that no longer bounds what S holds.

**Sequence (inside the bound).** If the implementation counts waiting appends in `inFlight`, A's
appends fill the 64 slots within the first second and every other tenant of S is refused
`overload` (503) for as long as A's ledger is slow. DESIGN §4.3: "one tenant's ledger being slow
never blocks another tenant in the same shard".

The same holds, more mildly, in normal operation: every first append of a stream waits one
shard→ledger round trip that nobody has measured (m-9), and the k refused attempts each make
one.

**Change.** Take the registration off the append path. An append to a stream that is not
registered starts (or finds) that stream's registration task and answers `registering` at once,
holding nothing, counted nowhere. The task (one per stream; started under `ctx.waitUntil`;
retried from the shard's one alarm, whose deadline joins `arm()`; never inside a transaction or
`blockConcurrencyWhile`) calls `registerStream` until it answers logged, with backoff from about
250 ms. The ledger may long-poll (answer once logged or after about 1 s), so a registration costs
one or two calls whatever the senders do. Cap the tasks a shard runs at once (m-5). `tailRead`
and `ensureStream` may still await their call: they hold no payload and are not what D37
bounds. Measure it: a pooled shard after `deleteAll` with one tenant's ledger held in its start,
s3's clients on the other tenants; their 99th percentile and the shard's memory, before and
after.

### M-2. Edge answers `registering` with 429, which Remote Write senders may drop

The proposal: "`edge/`. None needed (an unknown backpressure scope is backpressure)"
(`spec/README.md:1050`). As built, any `backpressure` whose scope is not `overload` becomes the
outcome `backpressure` (`edge/src/route.ts:292-301`) and is answered **429** "ingest buffer is
full" (`edge/src/index.ts:258-260`) with `Retry-After` rounded up to whole seconds (`:72`). D37
moved overload to 503 precisely because Remote Write senders "MUST retry 5xx, MAY retry 429"
(the comment at `route.ts:292`; D37, training knowledge, not checked here). The same applies to
the ruler's entrypoint (`edge/src/recorded.ts:137`).

`registering` is not an exceptional answer under R2. It is the answer, for about one to two
seconds, to:

- a new tenant's first writes, and to every new slot a tenant starts writing to;
- every tenant of a pooled shard after that shard loses its storage;
- every (tenant, shard) pair a shard-map change creates (m-4);
- at the upgrade, every stream the ledger has not registered yet. Registration is lazy today, at
  the first flush, and a low-volume tenant seals after 10 minutes (`sealAgeMs`), so such
  streams are common.

A sender that drops on 429 loses those samples. Nothing acknowledged is lost inside viz, but the
data never arrives, and the rule "Overload returns a retryable status" is kept only on paper.

**Change.** Edge answers `registering` with 503 and the shard's `Retry-After` (and may refuse
early, as for `overload`). The shard must not send the new scope before every edge maps it, so
the deploy order is ledger, edge, shard, janitor (the proposal names only "ledgers before
shards", `:994`), and a rollback goes in reverse. "R2 changes fewer components" then counts four,
not three.

## Minor

### m-1. While a ledger cannot log, new streams are refused without bound and without an alert

A drain that is `stuck` (a `LogFault`; only an operator ends it), or R2 PUTs that keep failing
(backoff doubling to 60 s, `ledger.ts:192-193`), leaves every new stream of the tenant refused: a
new tenant cannot write at all, a shard that lost its storage takes nothing for that tenant, a
map change stops the moved keys. As built the same faults stall only discards, and existing
streams keep accepting until their 64 MB buffer fills. The proposal states the dependency
(`spec/README.md:852`, `:1102-1105`); what it lacks is a way to see it: an alert when a stream
has waited for its registration longer than about a minute (per tenant, from the shard), and a
note that a registration can wait up to 60 s after R2 recovers because of the drain's backoff.

### m-2. `registered = 1` is cached for ever; nothing re-registers a stream the ledger forgot

The model's R2 has `reRegister` (`spec/bfs/model.ts:563` in the copy; `:559` in the tree): a
shard re-registers whenever the ledger's committed incarnation is below its own, at any moment,
as an oracle. The code plan re-registers only while `registered = 0` and only when an append,
a tail read or `ensureStream` arrives. I restricted the model's step to the code's triggers
(option `reRegFaithful`): safety, query liveness and the no-leak property still hold (runs F_*
below), so the oracle is not load-bearing within the model's faults.

Outside them, the ledger can forget a logged registration: a tenant deleted and recreated with
the same id, if its ledger and log are removed while a pooled shard keeps its stream (the
procedure sketched in `research/07-ingest-auth-tenancy.md` §8.5 calls `deleteAll()` on buffer
objects, which a pooled shard cannot do for one tenant; deletion is not built), a log looked for
under another cell or bucket while the tenant has no data objects yet (review S-5's rule then starts the ledger empty, which covers a
low-volume tenant's first 10–15 minutes), a point-in-time restore of the ledger's storage. The
shard keeps accepting, flush's `addUnit(X, n..)` is answered `not_contiguous(0)` for ever
(`flush.ts:258-270`, then `no_progress`), the buffer fills, and F6(b) is back for that stream.
The code as built is stuck the same way, so R2 does not make this worse; but the proposal's F1
fix promises "repeats the idempotent registration whenever `addUnit` / `loggedWatermarks` shows
the ledger does not know its incarnation" (`spec/README.md:516-519`) and the code plan does not
do it. Either do it (flush, seeing `not_contiguous(0)` for a stream the ledger does not list,
tells the shard to drop `registered` and start a fresh incarnation; the rows of the forgotten
stream are then a declared loss), or say that a lost log is out of scope.

### m-3. Reads and the janitor now create durable streams, and nothing retires one

Under R2, `tailRead` (called by the coordinator and by leaves) and `ensureStream` create a stream
row in the shard and commit a registration in the ledger. The ledger never drops a stream, every
plan lists every stream, and the coordinator asks the shard of each on every query
(`coordinator.ts:515-519`). After a pool is retired and its shards' storage deleted, the first
query of each tenant that ever wrote there recreates a stream in the retired shard, and every
later query of that tenant wakes it (one more Durable Object request per query, $0.15 per million
[V, `research/10`], and a shard that can never be deleted). The janitor does the same for any
pending flush file of a retired shard. Tenant deletion is not built; when it is, these are two
new paths that recreate a deleted tenant's streams and its ledger object, which the deletion
workflow must fence. **Change:** a stream-retirement change in the ledger (drop a stream whose
newest incarnation has watermark 0, no live file and a shard that confirms it holds nothing), and
no creation on the read path for a tenant marked deleted.

### m-4. Map changes cause a refusal burst that R2 makes avoidable

Every (tenant, new shard) pair a map change creates is a new stream refused until its
registration is logged: for a pool resize (D13), every moved tenant's senders at once. R2 makes
the remedy simple, and the proposal does not use it: the map-change procedure (and tenant
creation) calls `ensureStream(tenant)` on each new slot and publishes the new epoch only when
each answers `registered`. With that, a refusal happens only after a shard storage loss.

### m-5. Outbound calls from the shard and the six-connection budget (unmeasured)

The shard gains outbound calls to ledgers on three paths. `commitGroup` awaits `deliver()` (queue
send, KV put) before it answers a group that sealed (`shard.ts:633`). Whether concurrent incoming
calls to one Durable Object share one budget of six outbound connections, or each has its own, is
not measured here (`spikes/s1-fanout-r2/` measured R2 reads from a Durable Object in one
invocation). If they share it, a pooled shard after a loss, with many tenants registering at once
(each call up to 2 s during a ledger start), queues the seal notifications, and every tenant's
acknowledgements wait behind other tenants' ledgers. M-1's change with a cap of a few concurrent
registration tasks per shard makes the question moot; otherwise it needs the s1-style experiment
from inside a shard.

### m-6. Release skew at the janitor

A janitor of N+1 calling `ensureStream` on a shard of N gets a missing-method error; the plan does
not say what then. If it escapes `sweepOrphans`, that tenant's sweep stops for the length of the
skew (fails closed). Keep the file and go on. Also, the plan names the shard by turning `_` back
into `/` (`spec/README.md:1046`); `orphanCheck`'s `logged[].shard` already carries the exact name
(`janitor.ts:295` matches on it): use that, not D38's encoding.

### m-7. S5 can heal itself under R2

The plan leaves a stream whose `registerStream` throws (a lower incarnation: the shard's clock
stepped back across a storage loss) refused "until an operator acts" (`spec/README.md:1029-1031`),
and no operator action exists. Under R2 a stream that has never been registered and holds no batch
row has acknowledged nothing, so the shard can drop it and start one above the ledger's
incarnation. (Not a stream from before the upgrade: those start with `registered = 0` and do hold
acknowledged rows.) That needs the ledger's
incarnation in the refusal (a status in a union rather than a throw), a contract change best made
with the others.

### m-8. `loggedIncarnation` on `Watermark` reaches the plan and the log

`Watermark` is also `Plan.watermarks`' type and `LedgerChange.watermark`'s, which is part of the
R2 log's format. The field must be optional, and must not be written into change lines (a new
field in the log is a format change for the publisher's goldens, COMPATIBILITY §3.1). Cleaner: a
separate type for `loggedWatermarks()` and `OrphanCheck.logged`.

### m-9. The latency and cost figures

- Edge rounds `Retry-After` up to whole seconds (`index.ts:72`), so a sender that honours it
  retries after 1 s, not 0.5 s: the first acknowledgement of a stream is about 1–2 s after its
  first append, not 0.5–1.5 s (both modelled).
- A sender that ignores `Retry-After` on 5xx retries on its own backoff (Prometheus starts at
  30 ms and doubles: training knowledge): more attempts, each one a shard call, and in the code
  plan a ledger call. M-1's change makes the ledger side independent of it.
- The 15–47 ms round trip is Worker→ledger measured in one place (s4). A pooled shard serves
  tenants whose ledgers were created elsewhere, possibly on another continent: unmeasured.
- In money it is negligible: (1 + k) Durable Object requests per stream lifetime at $0.15 per
  million [V], and a segment PUT shared with other changes.
- At the upgrade every existing stream pays one round trip on its first append, and those the
  ledger has not registered are refused (M-2). Pre-existing streams already hold acknowledged
  rows, so refusing them removes no exposure; with M-1's change they should keep accepting while
  their registration is confirmed in the background.

---

## Model runs (scratch copy of `spec/bfs/`)

Additions in the copy, nothing else changed:

- **Invariant `P_LoggedRegistrationKnown`**: for every stream with `rg = 1` (the shard accepts its
  writes under R2), the log replayed from R2 names that incarnation or a newer one, and so does a
  serving ledger. This is the proposal's central claim, "a registration in the logged prefix
  survives every rebuild", checked in every state instead of argued.
- **Option `reRegFaithful`**: the model's `reRegister` and "registration logged" steps fire only
  when the planned code would call the ledger: a pending write of that stream, a query in flight
  naming another incarnation for that shard, or the janitor's trigger; and `reRegister` only while
  `rg = 0`.

Bounds as in the proposal's rows unless the row says otherwise; one checker at a time,
`--max-old-space-size=1024`, state caps of 2–7 million. "Stopped" means every state within that
depth was checked, no violation; it is not exhaustive.

<!-- RESULTS -->

## Checked and found safe

- **A logged registration cannot regress after a ledger loss** within the protocol: the rebuild
  replays the newest incarnation's checkpoint (or base) and every segment after it, and a new
  incarnation's base is in R2 before it commits. A format-2 checkpoint captures the streams at
  its version in the same synchronous step that fixes the segment ending there
  (`beginCheckpoint`), and a rebuild that passes over a bad checkpoint falls back to an older one
  or the base, so a registration at or before the checkpoint's version is in it and one after it
  is in a later segment. A segment PUT that lands after a rebuild listed (review S-8) never
  produced `logged: true`: `segmentWritten` ignores a drain of a replaced incarnation
  (`ledger.ts:1282`), and the answer comes only after it. The invariant above holds with two
  ledger losses. (Checkpoints are not in the model; that part is argued from the code.)
- **Paged and filtered tail reads (D48, D54).** A mismatch on any page is a refusal; the fresh
  incarnation in R2's answer only changes what the coordinator learns (newer than the plan's),
  so it re-plans; a leaf's rest read is handled the same way (`tailRefused`). Concurrent reads
  after a loss create one fresh incarnation, provided the stream row is inserted before the first
  await (the first read creates it; the others see it and are answered with it).
- **Release skew on the read path.** The coordinator and flush are unchanged, and the coordinator
  as built handles `incarnation_mismatch(fresh)` (learn, re-plan). A shard of N meeting a ledger of
  N+1 is today's lazy path.
- **The F16 rule.** A flush file of incarnation `i` is deleted only once a newer incarnation's
  registration is logged; the ledger then refuses `i` for good (`registerStream` refuses a lower
  incarnation, `addUnit` answers `incarnation_mismatch`), so the file can never be listed. The
  proposed migration of `logged_inc` never overestimates (a committed change that is not in the
  outbox is logged; an incarnation holding both log layouts is refused, not replayed).
- **The shard's flag.** `registered = 1` is written before the group it admits commits, and the
  output gate holds the acknowledgement until both are durable.

## Does the stated reasoning hold

- "R2 changes fewer components": it also changes edge (M-2), so four.
- "Refused at once": not in the code plan (M-1).
- "Fails closed" for a stuck drain: yes, but without bound or alert (m-1); and after a rollback,
  closed for good (B-1).
- "Statement 1": holds wherever the log persists; the text promises a re-registration the code
  plan drops (m-2).
- The bounds: the proposal did not run two shard losses or the F16 fix with two shards or two
  tenants; I did (above), with the limits stated there.

## Verdict

**Build R2 with changes.** Before building:

1. **B-1**: derive `logged` and `loggedIncarnation` from pending `register_stream` rows in the
   outbox (or make the ledger's migration forward-only), with a rollback/roll-forward test.
2. **M-1**: register in the background; an append to an unregistered stream is refused at once,
   holds nothing and waits for nothing; at most a few registration tasks per shard; measure it
   with one tenant's ledger slowed.
3. **M-2**: edge answers `registering` with 503; deploy ledger, edge, shard, janitor in that order.

With it, or recorded as open: an alert for long registration waits (m-1); the re-registration
the text promises, or the scope statement (m-2); stream retirement (m-3); registration ahead of
map changes and at tenant creation (m-4), which leaves a refusal only after a shard storage loss;
the janitor's skew handling and shard naming (m-6); S5 self-healing (m-7); the contract's shape
(m-8); corrected figures (m-9).

**Why not R3.** R3 keeps reads free of side effects (it avoids half of m-3), but every query of
every tenant of a shard that lost its storage pays a refused attempt and a re-plan until that
tenant writes there again or the janitor's next sweep calls `ensureStream`, which F16 needs
anyway; and it changes the coordinator as well. Nothing I found against R2 is fixed by R3.

**Why not R4.** R4 avoids the write side's dependency on R2 (m-1) and the refusals (M-2), but its
re-check covers only shards it read without a watermark. A shard that has left the tenant's pool
after a map change, holding rows under a committed registration that a rebuild rolled back, is
not read at all, so F6(b) returns there silently. Closing that means re-reading the whole
watermark list after every query attempt's tail reads (one more ledger round trip on every
query), and the F16 fix still needs a logged registration. R2 with the changes above pays only
when a stream is new, and with registration ahead of map changes (m-4), almost never.
