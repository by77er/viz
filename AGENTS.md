# Working in this repository

Procedures and rules that hold across tasks. Facts that change (test counts, costs, what is
finished) belong in each component's README and in `design/`, not here.

## Orientation

- `design/DESIGN.md` is the architecture. `design/DECISIONS.md` records each decision with
  its alternatives and what would change it. Read both before changing behaviour.
- `contracts/` holds the interfaces between components. Components live in sibling
  directories and depend only on `contracts/` and on each other's published types.
- `research/` is background. Each file tags claims as verified, secondary or training
  knowledge; treat the last two as leads, not facts.

## Changing things

1. **Contracts first.** If a component needs an interface to change, change `contracts/`
   in its own commit, then the components. Never redefine a contract locally. If you are
   working inside one component and cannot change the contract, implement the closest
   faithful thing and record it under a "Contract issues" heading in that component's README.
2. **Decisions are recorded, not implied.** A choice between real alternatives gets an entry
   in `design/DECISIONS.md`: decision, alternatives, why, "would change if". When the owner
   reverses a decision, rewrite the entry and say that it replaces an earlier one.
3. **Keep the design text true.** When code or a decision diverges from `DESIGN.md`, update
   `DESIGN.md` in the same change. The published design page is generated from
   `design/artifact/viz-design.html`; update it when the design or its status changes.
4. **Every component has a README** with: what is implemented, what is not, how it was
   verified (commands and results), known risks. "Not implemented" is a required section.

## Evidence

- **Say what kind of number it is.** Measured here, measured on Cloudflare, or modelled.
  Print modelled costs and latencies as ranges and name the experiment that would settle
  them (`design/VERIFICATION.md` §4).
- **Counterfactuals, not single runs.** To claim A beats B, implement the same workload
  both ways, tune each side separately, make them read each other's output, and require
  identical results before comparing times. Record the tuning steps, including the ones
  that did not help. `bench/README.md` is the template.
- **Tests must have teeth.** After writing tests for a safety property, break the property
  in the source on purpose, confirm a test fails, restore the source, and list the mutants
  and which test caught each in the README. A mutant that survives is reported, not hidden.
- **Independent readers.** Anything viz writes in an open format (Parquet, Iceberg, the
  Prometheus API) is also read back by an implementation viz did not write.
- **Review before building on it.** Protocol changes get an adversarial review by someone
  who has not seen the reasoning; findings and dispositions go in `design/REVIEW.md`.
- Report what failed and what was skipped as plainly as what passed.

## Durable Objects

- Storage is the only source of truth. Any in-memory state must be rebuilt from SQLite in
  the constructor; test it with `evictDurableObject`.
- Every SQL statement that touches tenant data names the tenant in its `WHERE` clause.
  Tenant identity comes from the credential, never from a header, path or body.
- A mutation and its change-log or outbox row go in the same transaction.
- Store whole batches as rows, never one row per sample: row writes are billed.
- One alarm per object, set to the earliest deadline, deleted when there is nothing to do.
  Alarm handlers are idempotent; alarms are at-least-once.
- Never hold `blockConcurrencyWhile` across R2 or network I/O.
- Refuse rather than guess: a caller holding a stale watermark, epoch or incarnation gets an
  explicit status, not a best-effort answer.
- Overload returns a retryable status. Nothing is acknowledged and then dropped.

## TypeScript components

- `shard/` is the reference setup: `wrangler.jsonc`, `vitest.config.ts` using
  `cloudflareTest` from `@cloudflare/vitest-plugin`, and bindings typed by declaring
  `namespace Cloudflare { interface Env { ... } }` in `test/env.d.ts`.
- Tests run inside the Workers runtime. Use `evictDurableObject`, `runDurableObjectAlarm`
  and `runInDurableObject` from `cloudflare:test`; import `env` from `cloudflare:workers`.
- `npm test` and `npx tsc --noEmit` both pass before a change is done.
- Nothing that needs `eval` or `new Function` at runtime; Workers forbid it.

## Git

- `node_modules/`, build output, `target*/` and generated benchmark data are ignored; do not
  commit them. Lockfiles are committed.
- One logical change per commit, with a message that says what changed and why.
