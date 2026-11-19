# Third-party material in this repository

Everything viz copies, transcribes or ports from another project, with its licence and what
that licence requires of us. Dependencies installed by npm or cargo from lockfiles are not
listed: they are fetched, not stored here. Harnesses that compare viz with another
implementation fetch that implementation at run time and do not store it (`engine/promql/tools/godiff`).

| What | Where | From | Licence | Obligation, and where it is met |
|---|---|---|---|---|
| PromQL test corpus, 13 `.test` files, unmodified | `engine/promql/testdata/upstream/` | Prometheus v3.8.0 | Apache-2.0 | Licence and NOTICE accompany the files: `LICENSE`, `NOTICE` there |
| NAB scorer, line-by-line port to TypeScript | `anomaly/bench/nab.ts` | numenta/NAB | MIT | Copyright and permission notice: `anomaly/bench/LICENSE-NAB.txt`, cited in the file header |
| NAB data (fetched by `fetch-nab.sh`, git-ignored) | `anomaly/bench/data/` (not committed) | numenta/NAB | MIT | Not redistributed |
| Fonts: JetBrains Mono, Schibsted Grotesk (variable WOFF2) | `design-system/project/fonts/` | JetBrains; Schibsted | SIL OFL 1.1 | Licence accompanies the fonts: `OFL-*.txt` there; fonts are not sold on their own and keep their names |

The TraceQL and LogQL engines (`engine/traceql/`, `engine/logql/`) are clean-room work:
written from the public language documentation and checked against Grafana Tempo and Loki
(both AGPL-3.0) only as black boxes run at test time, with their test suites fetched at test
time and never stored here. An earlier TraceQL crate that transcribed and ported Tempo's
code was removed from the tree on 2026-11-19 and is replaced, not shipped; git history still
holds it. Each crate's `CLEANROOM.md` records what its author consulted.

viz itself is licensed under Apache-2.0 (`LICENSE`, `NOTICE`, decision D35). Everything in this
table is compatible with it: Apache-2.0 and MIT material is redistributed with its notices,
and the fonts stay under the OFL. A dependency licence check on 2026-11-19 found no copyleft
package that ships: every npm dependency bundled into a Worker is MIT, ISC, BSD-3-Clause,
Apache-2.0, BlueOak-1.0.0 or Unlicense, and every Rust dependency is permissive (`r-efi` is
MIT OR Apache-2.0 OR LGPL-2.1, used under MIT/Apache). LGPL (`sharp`/libvips) and MPL
(`lightningcss`, `axe-core`) packages appear only as development and test tooling, which is
never bundled or distributed.
