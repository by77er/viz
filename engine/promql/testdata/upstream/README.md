# Upstream promqltest corpus

Fetched unmodified with curl from
`https://raw.githubusercontent.com/prometheus/prometheus/v3.8.0/promql/promqltest/testdata/<file>`
(tag `v3.8.0`, Apache-2.0, © The Prometheus Authors).

The licence and the NOTICE that Apache-2.0 §4 requires to accompany these files are in
`LICENSE` and `NOTICE` here, copied from the same tag.

Files: aggregators, at_modifier, collision, functions, histograms (for its classic `le` bucket cases), literals, name_label_dropping, operators,
range_queries, selectors, staleness, subquery, trig_functions (`.test`).

Not fetched (features out of scope): native_histograms.test, limit.test,
duration_expression.test, extended_vectors.test (anchored/smoothed), info.test, type_and_unit.test,
fill-modifier.test.
