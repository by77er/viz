# Spike S8, second half: commits to Cloudflare's managed Iceberg catalog from a Worker

Decides whether managed-catalog publication ships or viz stays R2-native
(`design/VERIFICATION.md` §4, S8; `design/DECISIONS.md` D2, D4). The first half (R2-native
metadata read back by DuckDB and PyIceberg) is done and recorded in `publisher/README.md`.

**Status (2026-11-19): blocked on a token permission. Not decided.** The environment's API token
cannot use the managed catalog at all: every catalog call is refused with "Access denied by
Cloudflare IAM policy" (40306). It lacks **Workers R2 Data Catalog Write** (which also covers the
reads; Workers R2 Data Catalog Read alone would allow only loads). That part was stopped there,
with no workaround tried. Everything else is done: the documentation was checked, the Worker,
driver and reader script were built and tested, and the R2-native baseline was measured on
Cloudflare. The catalog run is one command sequence once the permission is granted ("How to
finish it"). Everything deployed was deleted (see "Deployed, and deleted").

## Worst-case cost (stated before anything was deployed)

Everything is named `viz-spike-s8-*`. Nothing runs on a timer. The long exercises run as
one-shot Durable Object alarms that are never re-armed and do not start after a 15-minute
deadline. Every endpoint bounds its own work: at most 16 committers, 20 commits each, 50 commits
per latency batch, 40 unknown-outcome trials per call.

| Item | Planned | Worst case allowed by the code and the plan | Price | Worst-case cost |
|---|---|---|---|---|
| Catalog operations (every Iceberg REST request is billed) | about 5,000 | 30,000 | 1M/month included, then $9.00/M | $0.27 if the allowance were already used up, else $0 |
| R2 Class A (put, list) | about 3,000 | 20,000 | $4.50/M | $0.09 |
| R2 Class B (get, head) | about 5,000 | 30,000 | $0.36/M | $0.01 |
| R2 storage | under 5 MB for under a day | 50 MB for a month | $0.015/GB-month | under $0.01 |
| Workers and Durable Object requests and duration | about 2,000 requests, under 1,000 GB-s | 20,000 requests, 10,000 GB-s | Workers Paid allowances; $0.30/M requests, $12.50/M GB-s | $0.13 |
| Compaction, snapshot expiration | off (D3a) | off | $0.005/GB, $2/M objects | $0 |

**Worst case: under $1.** It is $0 if the plan's included allowances are not already used up.
Prices from developers.cloudflare.com/basin-catalog/platform/pricing/ and
developers.cloudflare.com/r2/pricing/ as read on 2026-11-19.

### What it cost (measured on Cloudflare, analytics API, window 2026-11-19 02:35:38–03:07:22 UTC)

| Dataset | Measured |
|---|---|
| `r2CatalogDataOperationsAdaptiveGroups` (warehouse `…_viz-spike-s8-catalog`) | 0 catalog operations: the catalog was never enabled |
| `r2OperationsAdaptiveGroups` (bucket `viz-spike-s8-catalog`) | PutObject 6,026, GetObject 7,160, HeadObject 3,676, HeadBucket 8 |
| `workersInvocationsAdaptive` (`viz-spike-s8-managed-catalog`) | 608 requests, 1,277 subrequests, 0 errors; CPU p50 0.7 ms, p99 3.3 ms |
| `durableObjectsInvocationsAdaptiveGroups` / `PeriodicGroups` | 1,297 requests; 483 GB-s billed duration; 13.2 s CPU |

That is about **$0.04** at list prices: Class A 6,026 × $4.50/M = $0.027, Class B 10,844 ×
$0.36/M = $0.004, 483 GB-s × $12.50/M = $0.006. All of it falls inside the plan's included
allowances. Class A is twice what was planned because the R2-native baseline ran longer than
planned, including one exercise that ran three times ("An incident in the harness"). The wipe
at teardown (lists and deletes) came after this window.

## 1. What the managed catalog is, from current documentation (read 2026-11-19)

| Question | Answer | Source |
|---|---|---|
| Name | **Basin Catalog**, "formerly known as R2 Data Catalog, is now Generally Available". `/r2/data-catalog/` answers 301 to `/basin-catalog/` (checked here) | https://developers.cloudflare.com/basin-catalog/ |
| What it is | A managed Apache Iceberg catalog built into an R2 bucket that "exposes a standard Iceberg REST catalog interface". One catalog (warehouse) per bucket | same |
| Enabling it | Per bucket: `npx wrangler basin catalog enable <bucket>`, or the dashboard, or `POST /accounts/{account_id}/basin-catalog/{bucket_name}/enable`. The old path `…/r2-catalog/…` is deprecated but still served, and wrangler 4.164.0 still calls it. The response gives `id`, `name` (`{account}_{bucket}`, the warehouse) and `catalog_uri` | https://developers.cloudflare.com/basin-catalog/manage-catalogs/, https://developers.cloudflare.com/api/resources/basin_catalog/methods/enable/ |
| REST endpoint | The catalog URI. Checked here: `https://catalog.cloudflarestorage.com/{account_id}/{bucket}` answers `GET /v1/config?warehouse={account}_{bucket}` with 404 `WarehouseNotFound` for a bucket whose catalog is not enabled, both from this machine and from a Durable Object. This confirms the URI shape that research/01 had only as training knowledge | measured; the docs show the URI only as a placeholder |
| Authentication | `Authorization: Bearer <Cloudflare API token>`. The token needs **both** catalog and R2 storage permissions. Writes (create or drop table, commit) need **Workers R2 Data Catalog Write** (`d229766a2f7f4d299f20eaa8c9b1fde9`) plus **Workers R2 Storage Bucket Item Write** (`2efd5506f9c8494dacb1fa10a3e7d5b6`). Reads need the two Read groups (`45db74139a62490b9b60eb7c4f34994b`, `6a018a9f2fc74eb6b293b0c548f38b39`). Vended SigV4 credentials inherit the token's R2 permissions. In the dashboard this is an R2 token with "Admin Read & Write". Enabling needs Workers R2 Data Catalog Write; getting a catalog's status needs Read or Write | manage-catalogs (above); https://developers.cloudflare.com/api/resources/r2_data_catalog/methods/get/ |
| Commit semantics | Cloudflare documents none beyond "standard Iceberg REST". The REST spec (`updateTable`) says: requirements (e.g. `assert-ref-snapshot-id`) are checked before the updates are applied; **409** CommitFailedException means a requirement failed and "the client may retry"; **500, 502, 504** CommitStateUnknownException means "the commit state is unknown"; 400 for unknown updates or requirements. An optional `Idempotency-Key` (a UUIDv7) makes the server replay a finalized response, 409 included; 5xx responses are not finalized; the key lifetime is advertised in `/v1/config`. **Whether Basin implements any of this as specified is what the spike was to measure, and could not** | https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml |
| Limits | **None published.** The docs index has no limits page (Overview, Get started, Manage catalogs, Table maintenance, engine examples, Deleting data, Metrics, Platform/Pricing). The one stated limitation: buckets in a non-default jurisdiction are not supported | https://developers.cloudflare.com/basin-catalog/llms.txt, manage-catalogs |
| Pricing | Catalog operations ("metadata requests made to the Iceberg REST catalog"): 1M/month included, then $9.00/M. Compaction: 10 GB and 1M objects included, then $0.005/GB and $2.00/M objects, only when it is on. Snapshot expiration is free. Requires an R2 subscription and a payment card | https://developers.cloudflare.com/basin-catalog/platform/pricing/ |
| Maintenance | Compaction and snapshot expiration are opt-in, per catalog or per table. D3a requires both off for viz's tables | manage-catalogs |
| Metrics | GraphQL `r2CatalogDataOperationsAdaptiveGroups`: count, request body bytes, `requestDurationMs` quantiles, by `operation`, `httpStatus`, table. `run.mjs analytics` reads it | https://developers.cloudflare.com/basin-catalog/observability/metrics/ |

research/01 and research/05 hold up on the rename, GA, pricing and the absence of published
limits. Their catalog URI shape is now confirmed by measurement.

## 2. Access: blocked, and on which permission

The token is an account API token. It cannot read its own policy: `GET /accounts/{id}/tokens/{id}`
returns 9109 "Unauthorized". So the missing permission is inferred from what each endpoint
requires (API reference above) and what it returned:

| Call (2026-11-19 02:15–02:35 UTC) | Needs | Answer |
|---|---|---|
| `GET /accounts/{id}/basin-catalog/viz-spike-s8-catalog` | Catalog Read or Write | **40306** "Access denied by Cloudflare IAM policy" |
| `POST /accounts/{id}/basin-catalog/viz-spike-s8-catalog/enable` | Catalog Write | **40306** |
| `GET /accounts/{id}/r2-catalog` and `wrangler basin catalog enable` (deprecated path) | Catalog Read / Write | **10000** "Authentication error" |
| `GET /accounts/{id}/basin-catalog` (list) | | success, empty list (the list is filtered, not refused) |
| R2: create bucket; put, get and delete an object through the API | R2 storage write | all succeeded |

**Missing: Workers R2 Data Catalog Write** (permission group `d229766a2f7f4d299f20eaa8c9b1fde9`),
on the account or on the bucket's resource,
`com.cloudflare.edge.r2.bucket.{account_id}_default_viz-spike-s8-catalog`. It is enough for every
step: enable, create, commit, load. The readers need at least Workers R2 Data Catalog Read. R2
storage write, the other half of the pair, the token already has. No other credential (Global
API key, another token, the dashboard) was tried. `node run.mjs precheck` repeats the check and
exits 2 with this message while the permission is missing.

## 3. What was built

| File | Contents |
|---|---|
| `src/catalog.ts` | `IcebergCatalog`: the publisher's catalog seam made explicit (load, create, a compare-and-swap commit with four outcomes: committed, conflict, unknown, rejected or throttled), and two implementations. `RestCatalog` speaks Iceberg REST (`/v1/config` prefix, namespaces, `create-table`, `load-table`, and `commit-table` with `assert-table-uuid` + `assert-ref-snapshot-id` requirements and `add-snapshot`, `set-snapshot-ref`, `remove-snapshots` updates; optional `Idempotency-Key`; abort after N ms). `R2NativeCatalog` is the publisher's conditional write of `v{N+1}.metadata.json` |
| `src/commit.ts` | Building the publisher's snapshots with its own `iceberg.ts` and `avro.ts`: fast append; and the publisher's net-difference publication (removed files as DELETED entries in rewritten manifests, survivors EXISTING with their sequence numbers, untouched manifests kept). `commitWithRetry` with three rules (below), chain verification (I10) and `checkIds` |
| `src/index.ts` | The Worker and its `Committer` Durable Object: endpoints for setup, publication stages, contention, unknown outcomes, latency, probes, verify, drop and wipe. The long exercises are jobs: an idempotent start, a one-shot alarm, then polling |
| `run.mjs` | The driver: precheck, up, deploy, probe, publish, contend, unknown, latency, probes, readers, analytics, down. Secrets reach wrangler on stdin; the endpoint key lives in `$S8_STATE`, outside the repository |
| `readers.py` | PyIceberg (RestCatalog) and DuckDB (`ATTACH … TYPE ICEBERG`) read each stage of the managed tables by snapshot id. They are compared with the R2-native publication of the same data using the publisher's own `content_hash`, and the bench tables' row counts are checked |
| `test/` | 14 tests in workerd: an in-memory REST catalog test double with fault injection (`test/mock-catalog.ts`) and the R2-native implementation on a simulated bucket |
| `mutants.mjs` | Mutation checks on a copy under `$MUTANT_DIR` |

**The rules that make conflicts and unknown outcomes safe** (`commitWithRetry`):

1. A logical commit keeps **one snapshot id** across every attempt, so "did it land?" has an
   answer.
2. Every attempt **requires `main` to be at the snapshot it was built on**. Two copies of one
   request carry the same requirement, so at most one applies. Once `main` has moved, a delayed
   copy can never apply.
3. Before every submission, and after every conflict or unknown outcome, the table is **read
   again and the id looked for** in `main`'s ancestry. If it is found, the commit is done and is
   never sent again. If not and `main` has not moved, the identical request is resent. If
   `main` has moved, the commit is rebuilt on the new head with the same id.

Conflicts and unknown outcomes therefore take the same path, and none of it depends on the
catalog refusing a duplicate snapshot id or honouring `Idempotency-Key`. The tests run the
unknown-outcome cases against a test double that would accept a duplicate id.

## 4. What was measured

### 4.1 In workerd, against a REST test double (measured here; not the managed catalog)

`npm test`: **14 passed**; `npx tsc --noEmit` clean. The test double
(`test/mock-catalog.ts`) checks requirements and applies updates atomically, and on create it
assigns fresh field ids in field order, as the Java reference does. It was written here, so
these tests show the client's logic, not any catalog's behaviour.

| Area | Shown |
|---|---|
| Table creation | The publisher's field ids, partition field ids (1000, 1001) and sort order survive a catalog that assigns fresh ids, because the schema is sent in id order. A catalog that numbers the partition columns first is refused by `checkIds` |
| Publication | The first two end-to-end stages (all L0 files, then each tenant's first compaction): the live set equals the stage, DELETED entries equal the removed files, survivors keep sequence number 1, and a repeat commits nothing |
| Contention | 4 committers × 5 appends, REST (test double with 0–15 ms jitter) and R2-native (simulated R2): every commit lands once, conflicts > 0, the chain is 20 long and equals the intended set, 20 distinct files |
| Unknown outcomes | Applied then lost (found, not resent); lost before applying (resent, applied once); applied late after the resubmission committed (fenced by its requirement); applied late after another writer moved `main` (fenced; rebased with the same id); landed just before the identical resubmission (that one conflicts, then the id is found: `landedLate`); aborted by the client while the catalog applies (exactly one copy applies) |
| Harness | A job started twice runs once; an alarm after completion does nothing |

**Mutation checks** (`MUTANT_DIR=<scratch> node mutants.mjs`, on a copy; the shared tree was
only read): **9 mutants, 9 killed**.

| # | Mutation | Tests failing | A test that fails |
|---|---|---|---|
| R3 | rule 3 removed: no look in the chain before a resubmission | 3 | applied, answer lost: found in the chain and not sent again |
| R2 | rule 2 removed: the REST commit does not require `main` to be where it was read | 6 | REST: every commit lands exactly once and the chain is one straight line |
| R2b | the R2-native commit writes the next metadata version unconditionally | 1 | R2-native: the same, with the publisher's conditional write |
| R1 | rule 1 broken: a rebuilt commit gets a new snapshot id (guard removed) | 1 | refuses a plan that changes the snapshot id between attempts |
| V1 | chain verification does not report a snapshot listed twice | 1 | finds a duplicate id, a fork and sequence numbers out of order |
| V2 | chain verification does not report a fork | 1 | the same |
| P1 | publication ignores removed files (gross, not net) | 1 | makes the live set equal each stage … |
| J1 | a repeated job start runs the exercise again | 1 | a job started twice runs once … |
| L1 | after `main` moved, the old request is resent instead of a rebuilt one | 4 | REST: every commit lands exactly once … |

### 4.2 Reader script, R2-native half (measured here)

`readers.py --native-only` (PyIceberg 0.12.0, DuckDB 2.0.0, pyarrow 26.0.1 in a scratch
virtualenv) reads each stage of `publisher/export` and gives the content hashes the managed
tables must equal. They are identical to `publisher/README.md`: `metric_samples` b4a95a8a8c71,
b4a95a8a8c71, f5526a4e32d1, 9a5881afc385; `metric_series` 37d07b565ec3, a314ee83e768,
8ee872fe777a, 51e6163aea9b (initial, compacted, expired, rebased). The managed half (RestCatalog,
DuckDB `ATTACH`, `AT (VERSION => …)`) has not run. The DuckDB iceberg extension in this
environment is `4c0c0874c4`, the same as the publisher's.

### 4.3 On Cloudflare (measured on Cloudflare, 2026-11-19; Worker entered at colo CMH)

**The catalog endpoint is reachable from a Durable Object.** 20 × `GET /v1/config`: all 404
`WarehouseNotFound`, p50 91 ms, p90 134 ms, p99 162 ms. This is a front-door round trip with
authentication and a warehouse lookup, not a commit. It is a lower bound for a commit's network
cost, nothing more.

**R2-native baseline: the same workload the managed catalog was to run.** Each committer is its
own Durable Object, and an append is one 120-row data file. A commit cycle is: load (version
hint, probe, metadata), read the parent's manifest list, write a manifest and a list, the
conditional write, then the hint.

Concurrent committers on one table, 10 commits each:

| Committers | Landed | Gave up (50 attempts) | Conflicts (412) | Unknown outcomes | Attempts per commit p50 / p90 / max | Time to success p50 / p90 / max | Commits per second | Chain (I10) |
|---|---|---|---|---|---|---|---|---|
| 2 | 20 / 20 | 0 | 19 | 0 | 2 / 2 / 2 | 4.0 / 4.2 / 4.2 s | 0.50 | linear, 20 = intended |
| 4 | 40 / 40 | 0 | 89 | 0 | 3 / 3 / 21 | 4.9 / 6.0 / 37.5 s | 0.48 | linear, 40 = intended |
| 8 | 78 / 80 | 2 | 388 | 32 | 3 / 11 / 50 | 6.8 / 19.6 / 95.4 s | 0.49 | linear, 78 = intended |
| 8 (rerun) | 78 / 80 | 2 | 391 | 7 | 3 / 8 / 50 | 6.1 / 13.5 / 87.9 s | 0.54 | linear, 78 = intended |

- **Safety held in every run:** one straight chain, equal to the commits that reported success,
  no file twice.
- **Liveness did not hold at 8:** 2 of 80 commits starved and gave up after 50 attempts, in both
  runs. One table admits about **0.5 commits per second** however many writers there are.
- **The conditional write itself fails under contention.** In the rerun, 7 attempts got R2
  error **10058, "Reduce your concurrent request rate for the same object"**: eight writers were
  creating the same `v{N+1}.metadata.json`. The committer treats that as an unknown outcome and
  resolves it from the table, correctly. The first run's 32 were not broken down (the summary
  did not yet record messages).
- viz's design has one publisher per cell (D3a, I10), so this is a stress test beyond the
  design. It shows the cost of a second writer, and that the rules keep the table correct.

Uncontended commits, one Durable Object, n = 200 (4 batches of 50):

| Part of one publish of one table | p50 | p90 | p99 | max |
|---|---|---|---|---|
| Load (hint, probe, metadata.json) | 448 ms | 717 ms | 812 ms | 840 ms |
| Build (read list, write manifest, write list) | 1,418 ms | 1,856 ms | 2,143 ms | 2,258 ms |
| **Commit: the conditional write of metadata.json** | **635 ms** | **780 ms** | **1,002 ms** | 1,071 ms |
| Whole publish (also the hint) | about 3.2 s (batch p50s 3.15–4.24 s) | | | |

The first batch was slower (commit p50 760 ms against about 610 ms after). R2 writes from this
object took about 0.6 s, against 0.17–0.26 s in spike S5. The bucket's location relative to the
object was not controlled; that may explain it. Not investigated.

### 4.4 An incident in the harness, and the fix

The first contention run held one HTTP request open for minutes. The local HTTP proxy
**retried the non-idempotent `POST`** ("upstream connect error … retried and the latest reset
reason: connection termination"). The same 4 committers then ran three times: 120 appends of
the same 40 files, each file listed three times in the snapshot. The R2-native chain stayed one
straight line (120 versions). The fault was the harness's: a retried request means a new
logical commit. The long exercises are now jobs whose start is idempotent and whose results are
polled (`Committer.startJob`, test "a job started twice runs once", mutant J1). That table and
the first 2-committer run were deleted and are not reported above. The same lesson applies to
the publisher: whatever starts a publish must be safe to repeat. Today it is, because a
publication is a net difference and is idempotent.

## 5. Verdict against the kill criterion ("Unreliable → stay R2-native")

**Not decided: the managed catalog was not reached.** Nothing measured says it is unreliable,
and nothing says it is reliable. Until S8 runs, viz stays R2-native, as D4 already orders:
R2-native first, the managed catalog as a second implementation of the same interface. That is
not a finding against the catalog.

What the spike does settle:

- **A Worker can be a correct Iceberg REST committer** under conflicts and unknown outcomes. The
  three rules are enough, and they are tested with teeth. They do not rely on the catalog
  rejecting duplicate ids or honouring `Idempotency-Key`.
- **The R2-native path is correct under contention, but slow per commit** from a Durable Object
  (about 3 s per table per publish, about 0.5 commits per second per table). With one publisher
  per cell and a 2-minute publish interval, that is well inside budget.

**Recommendation.**

1. Grant Workers R2 Data Catalog Write on the `viz-spike-s8-catalog` bucket resource, or on the
   account.
2. Run "How to finish it" (about 30 minutes; the worst case above stands).
3. Judge by criteria fixed now, before the result is seen. Managed publication ships only if
   all of these hold:
   - every chain is linear and equals what was intended (I10), under 2–8 committers and every
     unknown-outcome trial, including after the 10 s settle;
   - every unknown outcome is decided from the catalog with no duplicate;
   - 409 appears only when a requirement failed, never on an uncontended commit;
   - the catalog does not change the publisher's field ids, properties or snapshot summaries;
   - PyIceberg and DuckDB hashes for every stage equal the R2-native ones above;
   - uncontended commit p99 is well under the 2-minute publish interval.

   Any failure: stay R2-native, and keep the managed catalog as an export only.

## How to finish it (once the token has the permission)

```
cd spikes/s8-managed-catalog
export S8_STATE=<scratch dir outside the repo> S8_PYTHON=<venv>/bin/python   # venv: pyiceberg==0.12.0 duckdb==2.0.0 pyarrow==26.0.1
(cd ../../publisher && npm test)           # writes publisher/export/expected.json, the stages
node run.mjs precheck                      # exits 2 while the permission is missing
node run.mjs up                            # bucket, catalog (stops if CATALOG_URI in wrangler.jsonc differs), Worker, data
node run.mjs probe && node run.mjs publish && node run.mjs contend && node run.mjs unknown
node run.mjs latency && node run.mjs probes && node run.mjs readers
node run.mjs analytics                     # before down: it needs the Durable Object namespace
node run.mjs down                          # drop and purge tables, wipe objects, delete Worker, disable catalog, delete bucket, list
```

## Deployed, and deleted

Created (2026-11-19):

- R2 bucket `viz-spike-s8-catalog` (02:15 UTC). The catalog was never enabled on it; that was
  refused.
- Worker `viz-spike-s8-managed-catalog` (workers.dev, 02:35 UTC) with the SQLite Durable Object
  class `Committer`, bound to the bucket. Secrets `KEY` (random, generated at deploy) and
  `CATALOG_TOKEN` (the environment's token), both set from stdin.
- 3,815 objects written by the runs: the 54 publisher data files, the bench data files, and the
  R2-native metadata.

**Deleted 2026-11-19 03:07–03:09 UTC** with `node run.mjs down`. The 3,815 objects were wiped
through the binding, the Worker deleted with its secrets and Durable Objects, and the bucket
deleted. Disabling the catalog was refused (40306), and there was nothing to disable. Account
listings afterwards (03:09:35 UTC): no bucket, Worker script, Durable Object namespace or
catalog warehouse whose name contains `viz-spike-s8`. The account's 6 other buckets were not
touched. Remove by hand, should anything remain:

```
npx wrangler delete --name viz-spike-s8-managed-catalog
npx wrangler r2 bucket delete viz-spike-s8-catalog      # after emptying it
```

## Needed changes (in `publisher/`, not edited from here)

1. **Extract the catalog interface** (D4). `currentMetadata`, `putMetadata` and `resync` in
   `publisher.ts` become `IcebergCatalog.load` and `commit` (`src/catalog.ts` here), and
   `Conflict` becomes the `conflict` outcome. The interface must take a snapshot plus the ids to
   expire, not a whole `metadata.json`: a REST catalog builds the metadata itself.
   `nextMetadata` stays in the R2-native implementation.
2. **Unknown outcomes.** Today a thrown conditional write ends the publish (rethrown, tenants
   left pending), and the next publish's `currentMetadata` converges. That is safe because a
   publication is a net difference. A REST implementation must also keep the snapshot id across
   attempts and look for it before resubmitting (rules 1–3). Otherwise a commit that landed is
   seen as a conflict and resynced, which is still safe for net publication but wastes a
   commit, and the publisher's 3-conflict limit would count it.
3. **Schema field order.** `icebergSchema` lists `tenant` and `day` first, with ids 5 and 6 (or
   6 and 7). A catalog that assigns fresh ids in field order would renumber every column and
   break the name mapping and the manifests' bounds. Send fields in id order to a REST catalog,
   as `RestCatalog.create` does, and refuse a table whose ids differ (`checkIds`).
4. **Paths come from the catalog.** A managed table's location, and so the place for manifests,
   manifest lists and the cursors object, is whatever `create-table` returns, not
   `{cell}/iceberg/{table}`. `version-hint.text` and `v{N}.metadata.json` do not exist there. The
   orphan sweep must list the table's own `metadata/` prefix, and must never delete what the
   catalog wrote (its `metadata.json` files).
5. **`current-snapshot-id: -1`.** Java-based catalogs write −1 for "no snapshot". Treat any
   negative id as none (`currentId` here).
6. **Expiry** becomes a `remove-snapshots` update in the same commit; the publisher already
   expires in its commits.

## Risks and what was not done

- **The managed catalog was not exercised at all**: not its commit semantics, 409 behaviour,
  unknown outcomes, latency, `Idempotency-Key`, duplicate-id handling, field-id assignment,
  table locations, vended credentials, or reads. Everything in §4.1 is against a test double
  written here.
- `run.mjs` steps `up`, `publish`, `unknown`, `probes` and `readers` (managed half) have not run,
  so they may need fixes on first contact (for example `remove-snapshots` of ancestors, or
  DuckDB's `AT (VERSION => …)` syntax against a REST catalog). `deploy`, `probe`, `contend`,
  `latency`, `analytics` and `down` ran.
- The R2-native unknown-outcome exercise is not possible: an R2 binding `put` takes no abort
  signal. Its unknown outcomes were the real 10058 errors under contention.
- Latencies are from one colo and one time of day, and the bucket's location was not chosen.
- The token is account-wide. The spike stored it as a Worker secret while deployed; a
  bucket-scoped token was not possible, because this token cannot create tokens.
- Not reviewed adversarially (AGENTS.md asks for that before a protocol is built on). The three
  rules should be reviewed before the publisher adopts them.
