# lokidiff: black-box differential harness against Grafana Loki

**This program links AGPL-3.0 code (Grafana Loki).** It is a test tool only. It is built in a
scratch directory from Loki fetched through the Go module proxy at a pinned tag, and neither
Loki's source, the module cache nor the binary is ever committed or shipped in any viz
artifact. viz-logql itself contains nothing of Loki (`../../CLEANROOM.md`).

Pinned: `github.com/grafana/loki/v3` **v3.7.10** (commit
`c792f58577a46c64b0a8e808d7c643ed0e8c5e83`), its `pkg/push` module at the same commit
(`v0.0.0-20261113001030-c792f58577a4`), built with the Go toolchain its go.mod names
(`go1.26.10`, fetched by `GOTOOLCHAIN`).

## What it does

`main.go` reads a case file (data sets of log streams, and queries with their window,
direction and limit), evaluates every query with Loki's engine through its exported API
(`logql.NewEngine` over `logql.NewMockQuerier`, `logql.NewLiteralParams`, `Query(...).Exec`)
and serialises each result with `marshal.WriteQueryResponseJSON`, the function Loki's HTTP
API uses. In `probe` mode it records Loki's `data` object or error per case; `compare.py`
then compares those with viz's results and classifies every difference. (A Go-side
comparison also exists in `main.go`, run mode; `compare.py` is the one the README numbers
come from, because it knows the explained differences.)

## Use

```
export LOKIDIFF_WORK=/scratch/lokidiff      # outside the repository
./run.sh build                              # ~13 min on 2 cores; peak RSS 1.26 GB; ~2.5 GB of module + build cache
cd ../.. && VIZ_DIFF_ROUNDS=60 VIZ_DIFF_SEED=7 VIZ_DIFF_OUT=/scratch/cases.json \
    cargo test --release --test differential export_cases -- --ignored
tools/lokidiff/run.sh probe /scratch/cases.json /scratch/loki.json
python3 -I tools/lokidiff/compare.py /scratch/cases.json /scratch/loki.json
./run.sh clean                              # removes $LOKIDIFF_WORK
```

## Limits of the oracle

- `NewMockQuerier` drops structured metadata, so structured metadata is not part of the
  generated data; its semantics are covered by viz's own tests only.
- When a stage (`drop`, `keep`) maps several source streams to one label set, the mock
  querier returns their entries concatenated (or one source only) instead of merged by time
  as the HTTP API documents. `compare.py` recognises these cases from the data
  (`oracle-merged-streams*`).
- The engine accepts instant log queries; Loki's HTTP API rejects them with 400, as viz does.
