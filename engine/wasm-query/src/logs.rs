//! LogQL over the `logs` table and log tail batches: the operations behind Loki's HTTP API
//! in the query Worker (`query_range`, `query`, labels, label values, series). The engine is
//! `viz-logql`; it reads through its documented seam, `LogSource` (`contracts/LOGS.md` §7).
//!
//! Rows are de-duplicated on the row key `(stream_id, ts, line, metadata)`, the later winning
//! for the other columns: files in the order given (ascending precedence), then tail batches
//! in order. Each stream's rows go to the engine in `(ts, line, metadata)` order.
use crate::sigfiles::{self, LogRec};
use crate::{Fail, Req, Res};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use viz_logql::{Direction, LogRow, LogSource, MatchOp, Matcher, Options, SelectRequest};
use viz_query::QueryError;

/// A LogQL error as the binding types it (`viz_logql::Error::error_type`).
pub(crate) fn lq_err(e: viz_logql::Error) -> Fail {
    let m = e.to_string();
    Fail::Query(match e.error_type() {
        "bad_data" => QueryError::bad_data(m),
        "unsupported" => QueryError::unsupported(m),
        "internal" => QueryError::internal(m),
        _ => QueryError::execution(m),
    })
}

/// The rows read, as streams (`LogSource`).
pub(crate) struct Rows {
    streams: Vec<(Vec<(String, String)>, Vec<LogRow>)>,
}

impl LogSource for Rows {
    fn select(&self, req: &SelectRequest<'_>, visit: &mut dyn FnMut(&[(String, String)], &LogRow)) -> Result<(), viz_logql::Error> {
        // Every stream; the engine applies the matchers and the range itself (`LogSource`'s
        // contract allows more), and counts only what it keeps.
        for (labels, rows) in &self.streams {
            let lo = rows.partition_point(|r| r.ts_ns < req.start_ns);
            let hi = rows.partition_point(|r| r.ts_ns < req.end_ns);
            for r in &rows[lo..hi.max(lo)] {
                visit(labels, r);
            }
        }
        Ok(())
    }
}

/// FNV-1a 64 of a row key `(stream_id, ts, line, metadata)`: the de-duplication index only
/// (equal hashes are compared in full).
fn row_hash(r: &LogRec) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |b: &[u8]| {
        for x in b {
            h = (h ^ *x as u64).wrapping_mul(0x100_0000_01b3);
        }
        h = (h ^ 0xff).wrapping_mul(0x100_0000_01b3);
    };
    eat(&r.stream_id.to_le_bytes());
    eat(&r.ts.to_le_bytes());
    eat(r.line.as_bytes());
    for (k, v) in &r.metadata {
        eat(k.as_bytes());
        eat(v.as_bytes());
    }
    h
}

/// Decode the files (in the order given) and the tail batches, de-duplicate, group by stream.
/// Memory: each row is held once (no copy of its line or metadata for the index), and a
/// stream's labels once per file or batch entry, shared by its rows.
/// With `want`, only rows some selector can read are kept: a row whose stream matches none of
/// the selectors, or whose time is outside all their ranges, cannot change the answer (the
/// engine re-applies both) and is dropped before it is held. Both are parts of the row key, so
/// dropping them before de-duplication changes no other row.
pub(crate) fn rows(files: &[&[u8]], tails: &[&[u8]], max_rows: u64, decoded: &mut u64, want: Option<&[Sel]>) -> Res<Rows> {
    let compiled: Option<Vec<(Option<Compiled>, i64, i64)>> = want.map(|w| w.iter().map(|s| (Compiled::new(&s.matchers), s.start, s.end)).collect());
    // Per stream (by its shared labels), whether a selector's matchers admit it.
    let mut admitted: HashMap<*const Vec<(String, String)>, Vec<bool>> = HashMap::new();
    let mut kept: Vec<Option<LogRec>> = Vec::new();
    let mut index: HashMap<u64, Vec<u32>> = HashMap::new();
    let mut put = |r: LogRec| -> Res<()> {
        *decoded += 1;
        if *decoded > max_rows {
            return Err(Fail::Limit("max_rows", max_rows, *decoded, format!("query exceeded limit max_rows: more than {max_rows} log rows decoded, the limit is {max_rows}. Narrow the time range, or select fewer streams.")));
        }
        if let Some(c) = &compiled {
            let ok = admitted.entry(std::rc::Rc::as_ptr(&r.labels)).or_insert_with(|| c.iter().map(|(m, _, _)| m.as_ref().is_none_or(|m| m.matches(&r.labels))).collect());
            if !c.iter().zip(ok.iter()).any(|((_, lo, hi), m)| *m && r.ts >= *lo && r.ts < *hi) {
                return Ok(());
            }
        }
        let slots = index.entry(row_hash(&r)).or_default();
        for &i in slots.iter() {
            let old = kept[i as usize].as_ref().expect("indexed rows are kept");
            if old.stream_id == r.stream_id && old.ts == r.ts && old.line == r.line && old.metadata == r.metadata {
                // The later row wins for the other columns.
                kept[i as usize] = Some(r);
                return Ok(());
            }
        }
        slots.push(kept.len() as u32);
        kept.push(Some(r));
        Ok(())
    };
    for f in files {
        sigfiles::read_logs(f, &mut put)?;
    }
    for b in tails {
        sigfiles::batch_logs(b, &mut put)?;
    }
    drop(index);
    let mut grouped: BTreeMap<std::rc::Rc<Vec<(String, String)>>, Vec<(Vec<(String, String)>, LogRow)>> = BTreeMap::new();
    for r in kept.into_iter().flatten() {
        let metadata = r.logql_metadata();
        grouped.entry(r.labels).or_default().push((r.metadata, LogRow { ts_ns: r.ts, line: r.line, metadata }));
    }
    let streams = grouped
        .into_iter()
        .map(|(labels, mut v)| {
            v.sort_by(|a, b| (a.1.ts_ns, a.1.line.as_bytes()).cmp(&(b.1.ts_ns, b.1.line.as_bytes())).then_with(|| a.0.cmp(&b.0)));
            (std::rc::Rc::unwrap_or_clone(labels), v.into_iter().map(|x| x.1).collect())
        })
        .collect();
    Ok(Rows { streams })
}

fn op_name(op: MatchOp) -> &'static str {
    match op {
        MatchOp::Eq => "=",
        MatchOp::Ne => "!=",
        MatchOp::Re => "=~",
        MatchOp::Nre => "!~",
    }
}

/// `viz_q_lq_plan`: the selectors a query reads (`viz_logql::selectors`) with their matchers
/// and half-open nanosecond ranges, and whether it is a metric query. Kind 1 (instant) refuses
/// a log query, as Loki's HTTP API does.
pub(crate) fn do_lq_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let kind = r.u8("kind")?;
    let (start, end, step) = (r.i64("start")?, r.i64("end")?, r.i64("step")?);
    let q = r.str("query")?;
    r.end()?;
    let expr = viz_logql::parse(q).map_err(lq_err)?;
    let metric = matches!(expr, viz_logql::Expr::Metric(_));
    if kind == 1 && !metric {
        return Err(Fail::Query(QueryError::bad_data("log queries are not supported as an instant query type, please change your query to a range query type")));
    }
    let sels = if kind == 1 { viz_logql::selectors(q, start, start, 1) } else { viz_logql::selectors(q, start, end, step) }.map_err(lq_err)?;
    let list: Vec<serde_json::Value> = sels
        .iter()
        .map(|s| {
            serde_json::json!({
                "matchers": s.matchers.iter().map(|m| serde_json::json!({"name": m.name, "op": op_name(m.op), "value": m.value})).collect::<Vec<_>>(),
                "start": s.start_ns.to_string(), "end": s.end_ns.to_string(),
            })
        })
        .collect();
    Ok(serde_json::json!({"metric": metric, "selectors": list}).to_string().into_bytes())
}

/// Matchers compiled as LogQL compiles them (Go's dialect, fully anchored).
struct Compiled(Vec<(Matcher, Option<regex::Regex>)>);

impl Compiled {
    /// `None` when a regular expression does not compile: then nothing is pruned by it (the
    /// engine reports the error when it evaluates).
    fn new(ms: &[Matcher]) -> Option<Compiled> {
        let mut out = Vec::with_capacity(ms.len());
        for m in ms {
            let re = match m.op {
                MatchOp::Re | MatchOp::Nre => Some(viz_goregex::compile_anchored(&m.value).ok()?),
                _ => None,
            };
            out.push((m.clone(), re));
        }
        Some(Compiled(out))
    }
    fn matches(&self, labels: &[(String, String)]) -> bool {
        self.0.iter().all(|(m, re)| {
            let v = labels.iter().find(|(n, _)| *n == m.name).map_or("", |(_, v)| v.as_str());
            match m.op {
                MatchOp::Eq => v == m.value,
                MatchOp::Ne => v != m.value,
                MatchOp::Re => re.as_ref().is_some_and(|r| r.is_match(v)),
                MatchOp::Nre => !re.as_ref().is_some_and(|r| r.is_match(v)),
            }
        })
    }
}

/// A selector's read: matchers and `[start, end)` in nanoseconds.
pub(crate) struct Sel {
    matchers: Vec<Matcher>,
    start: i64,
    end: i64,
}

fn read_sels(r: &mut Req<'_>) -> Res<Vec<Sel>> {
    let n = r.u32("n_selectors")?;
    let mut out = Vec::new();
    for _ in 0..n {
        let (start, end) = (r.i64("start")?, r.i64("end")?);
        out.push(Sel { matchers: r.matchers()?, start, end });
    }
    Ok(out)
}

/// `viz_q_lq_file_plan`: per fragment, the row groups some selector may read: by time, and by
/// the fragment's stream list when it has one (streams whose labels match the selector and
/// whose rows overlap its range: their row groups), else by `service_name` bounds when the
/// selector pins `service_name` with `=`.
pub(crate) fn do_lq_file_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let gap = r.u64("gap")?;
    let sels = read_sels(&mut r)?;
    let raw = r.files("index fragment")?;
    r.end()?;
    let compiled: Vec<Option<Compiled>> = sels.iter().map(|s| Compiled::new(&s.matchers)).collect();
    let plans: Vec<serde_json::Value> = raw
        .iter()
        .map(|b| {
            let Some(f) = std::str::from_utf8(b).ok().and_then(sigfiles::Frag::parse) else { return crate::plan_json(&sigfiles::unknown()) };
            let mut keep = BTreeSet::new();
            for (s, c) in sels.iter().zip(&compiled) {
                let overlaps = |lo: i64, hi: i64| hi >= s.start && lo < s.end;
                match (&f.streams, c) {
                    (Some(streams), Some(c)) => {
                        for st in streams {
                            if overlaps(st.min_ts, st.max_ts) && c.matches(&st.labels) {
                                for g in st.first_rg..=st.last_rg.min(f.rg.len().saturating_sub(1)) {
                                    if overlaps(f.rg[g].min_ts, f.rg[g].max_ts) {
                                        keep.insert(g);
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        let svc = s.matchers.iter().find(|m| m.name == "service_name" && m.op == MatchOp::Eq).map(|m| m.value.as_str());
                        for (i, g) in f.rg.iter().enumerate() {
                            let by_name = svc.is_none_or(|v| g.min_name.as_deref().is_none_or(|a| a <= v) && g.max_name.as_deref().is_none_or(|b| v <= b));
                            if overlaps(g.min_ts, g.max_ts) && by_name {
                                keep.insert(i);
                            }
                        }
                    }
                }
            }
            crate::plan_json(&f.decide(&keep.into_iter().collect::<Vec<_>>(), gap))
        })
        .collect();
    Ok(serde_json::Value::Array(plans).to_string().into_bytes())
}

/// `viz_q_lq_query`: Loki's `data` object (`resultType`, `result`, `stats`) for a range (kind
/// 0) or instant (kind 1) query, after `u64` rows decoded.
pub(crate) fn do_lq_query(mut r: Req<'_>) -> Res<Vec<u8>> {
    let max_rows = r.u64("max_rows")?;
    let max_series = usize::try_from(r.u64("max_series")?).unwrap_or(usize::MAX);
    let max_steps = usize::try_from(r.u64("max_steps")?).unwrap_or(usize::MAX);
    let limit = r.u32("limit")?;
    let direction = if r.u8("direction")? == 1 { Direction::Forward } else { Direction::Backward };
    let kind = r.u8("kind")?;
    let (start, end, step) = (r.i64("start")?, r.i64("end")?, r.i64("step")?);
    let q = r.str("query")?;
    let files = r.files("logs file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    // Refuse a bad query before reading anything; what each selector reads.
    viz_logql::parse(q).map_err(lq_err)?;
    let sels: Vec<Sel> = if kind == 1 { viz_logql::selectors(q, start, start, 1) } else { viz_logql::selectors(q, start, end, step) }
        .map_err(lq_err)?
        .into_iter()
        .map(|s| Sel { matchers: s.matchers, start: s.start_ns, end: s.end_ns })
        .collect();
    let mut decoded = 0u64;
    let src = rows(&files, &tails, max_rows, &mut decoded, Some(&sels))?;
    let opts = Options { limit, direction, max_steps, max_series, now_ns: None };
    let out = if kind == 1 { viz_logql::query_instant(&src, q, start, &opts) } else { viz_logql::query_range(&src, q, start, end, step, &opts) }.map_err(lq_err)?;
    let json = out.data_json();
    let mut payload = Vec::with_capacity(8 + json.len());
    payload.extend_from_slice(&decoded.to_le_bytes());
    payload.extend_from_slice(json.as_bytes());
    Ok(payload)
}

/// A bare stream selector (`{…}`) as matchers; anything else is `bad_data`.
fn selector(text: &str) -> Res<Vec<Matcher>> {
    match viz_logql::parse(text).map_err(lq_err)? {
        viz_logql::Expr::Log(l) if l.stages.is_empty() => Ok(l.matchers),
        _ => Err(Fail::Query(QueryError::bad_data(format!("not a stream selector: {text:?}")))),
    }
}

/// `viz_q_lq_labels`: Loki's `/labels` (kind 0), `/label/<name>/values` (1) or `/series` (2)
/// `data` array: the streams with a row in `[start, end]` whose labels match one of the
/// selectors (none: every stream). Streams come from fragments' stream lists (a stream counts
/// when its first-to-last span overlaps the window: Loki documents that it "may use a larger
/// time span"), from the `labels` and `ts` columns of files without one, and from the tail.
pub(crate) fn do_lq_labels(mut r: Req<'_>) -> Res<Vec<u8>> {
    let kind = r.u8("kind")?;
    let name = r.str("name")?.to_string();
    let (start, end) = (r.i64("start")?, r.i64("end")?);
    let selectors = r.strs("selector")?;
    let fragments = r.files("index fragment")?;
    let files = r.files("logs file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    if kind > 2 {
        return Err(Fail::Malformed(format!("unknown kind {kind}")));
    }
    let sets: Vec<Compiled> = selectors
        .iter()
        .map(|s| Compiled::new(&selector(s)?).ok_or_else(|| Fail::Query(QueryError::bad_data(format!("invalid regular expression in {s:?}")))))
        .collect::<Res<_>>()?;
    let mut streams: BTreeSet<Vec<(String, String)>> = BTreeSet::new();
    let mut add = |labels: Vec<(String, String)>, lo: i64, hi: i64| {
        if hi < start || lo > end {
            return;
        }
        if sets.is_empty() || sets.iter().any(|c| c.matches(&labels)) {
            streams.insert(labels);
        }
    };
    for f in &fragments {
        let text = std::str::from_utf8(f).map_err(|e| sigfiles::internal("index fragment", e))?;
        let frag = sigfiles::Frag::parse(text).ok_or_else(|| sigfiles::internal("index fragment", "does not parse"))?;
        let list = frag.streams.ok_or_else(|| sigfiles::internal("index fragment", "has no stream list"))?;
        for s in list {
            add(s.labels, s.min_ts, s.max_ts);
        }
    }
    for f in &files {
        for (labels, lo, hi) in sigfiles::file_streams(f)? {
            add(labels, lo, hi);
        }
    }
    for b in &tails {
        for (labels, lo, hi) in sigfiles::batch_streams(b)? {
            add(labels, lo, hi);
        }
    }
    let json = match kind {
        0 => serde_json::json!(streams.iter().flat_map(|s| s.iter().map(|(n, _)| n.clone())).collect::<BTreeSet<_>>()),
        1 => serde_json::json!(streams.iter().filter_map(|s| s.iter().find(|(n, _)| *n == name).map(|(_, v)| v.clone())).collect::<BTreeSet<_>>()),
        _ => serde_json::Value::Array(
            streams
                .iter()
                .map(|s| {
                    let mut m = serde_json::Map::new();
                    for (n, v) in s {
                        m.insert(n.clone(), v.clone().into());
                    }
                    serde_json::Value::Object(m)
                })
                .collect(),
        ),
    };
    Ok(json.to_string().into_bytes())
}
