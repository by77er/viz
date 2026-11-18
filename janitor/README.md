# Janitor

Retention and physical deletion for one tenant: three stateless jobs. What was removed,
when, and whether that removal is durably logged is kept by the tenant's ledger
(tombstones; `contracts/ledger.ts`, "PROPOSED ADDITION").

| File | Contents |
|---|---|
| `src/janitor.ts` | `retentionPolicy`, `expireTenant`, `purgeTenant`, `sweepOrphans` |
| `test/janitor.test.ts` | 10 tests in workerd against the real `Shard`, `Ledger`, flush and compaction, and a simulated R2 |

Bindings: `LEDGER`, `BUCKET`, `CONFIG` (KV), `CELL`.

## What is implemented

**`expireTenant(env, tenant, now)`** reads `retention:<tenant>` = `{ "metric_samples_days": N }`
from KV (default 30; a record that cannot be read or is not a positive integer gives the
default, never a shorter retention) and calls `ledger.expire` for both tables with
`beforeDay` = the UTC day N days before `now`: today and the N days before it are kept.
Samples first, then series, so a day never has samples without the series that describe
them. No object is touched. It returns the cutoff and the policy (`keepDays`): day D
expires at 00:00 UTC on day D + keepDays + 1, which is how `stack/` knows when an idle
tenant next has anything to expire.

**`purgeTenant(env, tenant, { graceMs })`** deletes the objects of keys the ledger removed,
whether by `expire` or by compaction's `replace`. It deletes exactly what
`ledger.deletable({ minAgeMs: graceMs })` returns, and the ledger returns a key only when

1. the change that removed it is in the ledger's R2 log (a ledger rebuilt from its log
   would otherwise list the file again, and the object must then still exist),
2. it was removed at least `graceMs` ago by the ledger's own clock (default one hour: a
   query holding a plan from before the removal may still be reading the file), and
3. the key is not live.

A removal that is committed but not yet logged is simply not returned; the next run finds
it. Deletes go to R2 as one request per thousand keys; tombstones are forgotten only after
the delete returned.

**`sweepOrphans(env, tenant, { graceMs })`** lists the tenant's data prefix, then asks the
ledger about those keys in one consistent read (`orphanCheck`) and deletes an object only
if it is neither live nor tombstoned, and:

| Object | Deleted when |
|---|---|
| Flush file `L0-{shard}-{incarnation}-{seqLo}-{seqHi}-…` | its stream's **logged** watermark is at or past `seqHi` (a unit for that range is then answered as a replay and adds no file), or the ledger has a newer incarnation of the stream; and it is at least `graceMs` old (default 24 h) |
| Compaction output `L{1,2}-…` | it is at least `max(graceMs, 2 × maxStepMs)` old. A compaction step gives up before `replace` once it has run `maxStepMs`, so an output that old cannot be about to become live |
| Anything else under the prefix | never (reported as `unknown_name`) |

So the files of a unit that is written but not yet admitted are kept however old they are
(`pending_unit`, or `unknown_stream` for the first unit of a stream the ledger has not
seen), and age alone never deletes a flush file.

**Why the tombstones are in the ledger** and not in a janitor object: `design/DECISIONS.md` D20.

## R2 operations per retention run

`expireTenant`: none by the janitor; the ledger logs at most two changes (one per table).
`purgeTenant`: one DELETE request per 1,000 keys, one at a time. `sweepOrphans`: one LIST
page per 1,000 objects per table and one DELETE request per 1,000 orphans. No PUT anywhere.
Locally a run takes a few milliseconds. On Cloudflare (modelled from
`spikes/s5-r2-writes/`: a write 0.17–0.26 s at the median, one `delete()` of 1,000 keys
5.5 s): expire is the ledger's two log writes, about 0.35–0.5 s today and a few
milliseconds once its log is batched; deletion is about **5.5 s per 1,000 keys**, so a
purge at its default cap of 10,000 keys is about a minute of one maintenance run. That is
background work, never on a write or query path, and the cap keeps one run well inside a
queue consumer's time limit.

## Not implemented

- **The wait for publication.** `DESIGN.md` §5.2 deletes after the removal is *published*;
  there is no publisher on this path yet. Tombstones carry the ledger version so that gate
  can be added to `deletable`.
- **Tiers and signals.** One number per tenant, raw metric samples only.
- **Partial days.** Retention removes whole UTC days; a file is never rewritten to trim it.
- **Tombstones of earlier ledger incarnations.** A ledger rebuilt from its log restores the
  tombstones of that log; removals logged only in an older incarnation are found by the
  orphan sweep instead (their flush files are below the logged watermark).
- **Deleting the ledger's own log objects**, and shard-side data.
- Not run on Cloudflare; R2's `uploaded` time and list consistency are miniflare's here.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)
npm ci && npm test       # 10 tests in workerd
npx tsc --noEmit         # clean
```

| Test | What it asserts |
|---|---|
| policy | KV record, default 30, six kinds of bad record keep the default, cutoff day arithmetic at day boundaries |
| expires whole days | both tables, right days, no object touched, the remaining rows read exactly, idempotent, default policy removes nothing |
| grace, with a reader holding the old plan | compaction replaces every file of a plan; within the grace nothing is deleted and the old plan reads completely and correctly; after the grace the inputs go and the live outputs stay |
| committed but not logged | with the ledger's log broken, nothing is deleted even with no grace; after the log catches up the same call deletes |
| `maxKeys` | stops and continues |
| pending unit (the race) | a flush stopped between PUT and `addUnit`: the sweep, with no grace and a clock a year ahead, keeps its files; the flush then finds them (`exists`) and they are live. Same for a stream's first unit |
| logged, not committed, watermark | a stray object for a range that is committed but not logged is kept; deleted once logged |
| true orphans | a superseded flush file, a file of an older incarnation and the outputs of a crashed merge are kept while young and deleted when old; an unknown name is never deleted |
| merge in flight | the sweep runs between a step's PUTs and its `replace` and keeps the outputs |
| live, tombstoned, other tenants | untouched with no grace at all |

Mutants: `stack/scripts/mutants.mjs deletion`; results in `stack/README.md`.

## Known risks

- **The grace is a time, not a lease.** A query that runs longer than the delete grace can
  lose a file under it. The default is one hour; nothing enforces a query time limit yet.
- **Compaction outputs are protected by clocks**: the step's deadline and R2's `uploaded`
  time. A Worker clock that is wrong by more than `maxStepMs` could break that.
- **Listing a large prefix** is one request per 1,000 objects; a tenant with millions of
  files needs the sweep split by day. It runs at most daily per tenant (`stack/`).
- **A retention shortened by mistake** removes data at the next run; the delete grace is
  the only window in which the ledger's log could still be used to restore the listing.
