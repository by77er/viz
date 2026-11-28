//! LogQL over the `logs` table and log tail batches: the operations behind Loki's HTTP API
//! in the query Worker (`query_range`, `query`, labels, label values, series). The engine is
//! `viz-logql`; it reads through its documented seam, `LogSource` (`contracts/LOGS.md` §7).
//!
//! Rows are de-duplicated on the row key `(stream_id, ts, line, metadata)`, the later winning
//! for the other columns: files in the order given (ascending precedence), then tail batches
//! in order. Each stream's rows go to the engine in `(ts, line, metadata)` order.
use crate::sigfiles::{self, LogRec, Mem};
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
/// stream's labels once per file or batch entry, shared by its rows; what is held is charged
/// to `mem` as it is decoded ([`sigfiles::log_row_bytes`]) and refused past its limit.
/// With `want`, only rows some selector can read are kept: a row whose stream matches none of
/// the selectors, or whose time is outside all their ranges, cannot change the answer (the
/// engine re-applies both) and is dropped before it is held. Both are parts of the row key, so
/// dropping them before de-duplication changes no other row. `max_rows` bounds the rows held
/// (ABI 7; before, the rows decoded): a tail row outside every selector's range costs nothing.
/// `decoded` counts every row read.
pub(crate) fn rows(files: &[&[u8]], tails: &[&[u8]], max_rows: u64, decoded: &mut u64, want: Option<&[Sel]>, mem: &mut Mem) -> Res<Rows> {
    let compiled: Option<Vec<(Option<Compiled>, i64, i64)>> = want.map(|w| w.iter().map(|s| (Compiled::new(&s.matchers), s.start, s.end)).collect());
    // Per stream (by its shared labels), whether a selector's matchers admit it.
    let mut admitted: HashMap<Vec<(String, String)>, Vec<bool>> = HashMap::new();
    let mut kept: Vec<Option<LogRec>> = Vec::new();
    let mut index: HashMap<u64, Vec<u32>> = HashMap::new();
    let mut held = 0u64;
    let mut put = |r: LogRec, mem: &mut Mem| -> Res<()> {
        *decoded += 1;
        if let Some(c) = &compiled {
            if !admitted.contains_key(r.labels.as_slice()) {
                let v = c.iter().map(|(m, _, _)| m.as_ref().is_none_or(|m| m.matches(&r.labels))).collect();
                admitted.insert((*r.labels).clone(), v);
            }
            let ok = &admitted[r.labels.as_slice()];
            if !c.iter().zip(ok.iter()).any(|((_, lo, hi), m)| *m && r.ts >= *lo && r.ts < *hi) {
                return Ok(());
            }
        }
        held += 1;
        if held > max_rows {
            return Err(Fail::Limit("max_rows", max_rows, held, format!("query exceeded limit max_rows: it would hold more than {max_rows} log rows, the limit is {max_rows}. Narrow the time range, or select fewer streams (rows no selector reads are not held).")));
        }
        mem.charge(sigfiles::log_row_bytes(&r))?;
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
        sigfiles::read_logs(f, mem, &mut put)?;
    }
    for b in tails {
        sigfiles::batch_logs(b, mem, &mut put)?;
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
            // ABI 9 (D81): the groups whose every row the call is sure to hold: wholly inside a
            // selector's range, and every stream they hold (from the stream list) admitted by its
            // matchers. Their rows are a lower bound of what the engine counts against `max_rows`.
            let mut sure = BTreeSet::new();
            for (s, c) in sels.iter().zip(&compiled) {
                let inside = |lo: i64, hi: i64| lo >= s.start && hi < s.end;
                if let Some(streams) = &f.streams {
                    for (g, rg) in f.rg.iter().enumerate() {
                        if !inside(rg.min_ts, rg.max_ts) {
                            continue;
                        }
                        let mut held = streams.iter().filter(|st| st.first_rg <= g && g <= st.last_rg).peekable();
                        if held.peek().is_some() && held.all(|st| c.as_ref().is_none_or(|c| c.matches(&st.labels))) {
                            sure.insert(g);
                        }
                    }
                }
            }
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
            let certain: u64 = sure.iter().filter(|g| keep.contains(g)).filter_map(|g| f.rg.get(*g)).map(|g| g.rows).sum();
            let mut plan = crate::plan_json(&f.decide(&keep.into_iter().collect::<Vec<_>>(), gap));
            plan["certain"] = serde_json::json!(certain);
            plan
        })
        .collect();
    Ok(serde_json::Value::Array(plans).to_string().into_bytes())
}

/// `viz_q_lq_query`: Loki's `data` object (`resultType`, `result`, `stats`) for a range (kind
/// 0) or instant (kind 1) query, after `u64` rows decoded.
pub(crate) fn do_lq_query(mut r: Req<'_>) -> Res<Vec<u8>> {
    let max_rows = r.u64("max_rows")?;
    let mut mem = Mem::new(r.u64("max_bytes")?);
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
    mem.help = "Narrow the time range, or select fewer streams.";
    let src = rows(&files, &tails, max_rows, &mut decoded, Some(&sels), &mut mem)?;
    // A metric query's series hold one point per step: they must fit what the budget leaves.
    let steps = if kind == 1 { 1 } else { u64::try_from(end.saturating_sub(start) / step.max(1)).unwrap_or(u64::MAX).saturating_add(1) };
    let fit = usize::try_from(mem.left() / steps.saturating_mul(METRIC_POINT_BYTES)).unwrap_or(usize::MAX).max(1);
    // What the evaluation makes beyond the rows (label sets, samples, points, the vector
    // operations' series) is charged as it is made against what is left (ABI 8; review r2 R2-M2).
    let opts = Options { limit, direction, max_steps, max_series: max_series.min(fit), now_ns: None, max_bytes: mem.left() };
    let out = if kind == 1 { viz_logql::query_instant(&src, q, start, &opts) } else { viz_logql::query_range(&src, q, start, end, step, &opts) }.map_err(|e| {
        if let viz_logql::Error::Memory { what, used, .. } = e {
            mem.stage = match what {
                "entries" => "the log lines it keeps for the answer",
                "stream label sets" | "streams" => "the label sets its pipeline makes (one stream each)",
                "series label sets" => "the series its pipeline makes (one per label set)",
                "samples" => "the samples of its series",
                "points" => "the points of its series",
                _ => "the series of its vector operations",
            };
            mem.help = "Narrow the time range, select fewer streams, group by fewer labels, use a longer step, or lower limit; stages that make a label per line (regexp, label_format, json, logfmt) make a series per distinct value.";
            mem.refusal(mem.used.saturating_add(used))
        } else if fit < max_series && e.to_string().contains("maximum of series") {
            Fail::Limit(
                "max_decoded_bytes",
                mem.max,
                mem.used.saturating_add((fit as u64 + 1).saturating_mul(steps).saturating_mul(METRIC_POINT_BYTES)),
                format!("query exceeded limit max_decoded_bytes: more than {fit} series of {steps} steps do not fit what the limit ({} bytes) leaves once the rows are held. Narrow the time range, use a longer step, or group by fewer labels.", mem.max),
            )
        } else {
            lq_err(e)
        }
    })?;
    drop(src);
    // What the result holds while the answer is written, then the answer, before it is written:
    // lines as JSON escapes them, points as text.
    mem.help = "Narrow the time range, select fewer streams, or lower limit.";
    mem.charge_for("its result", out.held_bytes)?;
    mem.charge_answer(answer_bytes(&out.data))?;
    let json = out.data_json();
    let mut payload = Vec::with_capacity(8 + json.len());
    payload.extend_from_slice(&decoded.to_le_bytes());
    payload.extend_from_slice(json.as_bytes());
    Ok(payload)
}

/// Bytes charged per point of a LogQL metric series (`(i64, f64)` and its share of the text).
const METRIC_POINT_BYTES: u64 = 48;

/// The length of `s` as a JSON string written by `viz_logql`'s `json_str`, quotes included.
fn json_len(s: &str) -> u64 {
    2 + s
        .chars()
        .map(|c| match c {
            '"' | '\\' | '\n' | '\r' | '\t' => 2,
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => 6,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8() as u64,
        })
        .sum::<u64>()
}

/// An upper bound on the bytes of a query's `data` object, from the result before it is
/// written: what is charged for the answer.
fn answer_bytes(d: &viz_logql::Data) -> u64 {
    use viz_logql::Data;
    let labels = |l: &[(String, String)]| 2 + l.iter().map(|(k, v)| 2 + json_len(k) + json_len(v)).sum::<u64>();
    1024 + match d {
        Data::Streams(v) => v.iter().map(|s| labels(&s.labels) + 32 + s.entries.iter().map(|(_, line)| 28 + json_len(line)).sum::<u64>()).sum(),
        Data::Matrix(v) => v.iter().map(|s| labels(&s.labels) + 32 + METRIC_POINT_BYTES * s.points.len() as u64).sum(),
        Data::Vector(v) => v.iter().map(|(l, _, _)| labels(l) + 64).sum(),
        Data::Scalar(..) => 64,
    }
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
///
/// Memory (ABI 8; design/reviews/signals-end-to-end-r2.md R2-M1: before, nothing was counted,
/// and 300 streams of 3.45 MiB of files held 399 MiB): `max_bytes` bounds the label texts read
/// from each file or batch (released once it is done), what the call keeps (only the names for
/// kind 0, only the values of `name` for kind 1, the label sets for kind 2, each charged when it
/// is first kept), and the answer, charged four times its exact length before it is written.
/// Past it `max_decoded_bytes`, never a shortened list: Loki's API documents no `limit` for these
/// calls (its HTTP API reference, read 2026-11-19), so a cut list would be a wrong answer.
pub(crate) fn do_lq_labels(mut r: Req<'_>) -> Res<Vec<u8>> {
    let kind = r.u8("kind")?;
    let name = r.str("name")?.to_string();
    let (start, end) = (r.i64("start")?, r.i64("end")?);
    let mut mem = Mem::new(r.u64("max_bytes")?);
    let selectors = r.strs("selector")?;
    let fragments = r.files("index fragment")?;
    let files = r.files("logs file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    if kind > 2 {
        return Err(Fail::Malformed(format!("unknown kind {kind}")));
    }
    mem.help = "Narrow the time range, or pass a stream selector that matches fewer streams (`query`, or `match[]` for series).";
    let sets: Vec<Compiled> = selectors
        .iter()
        .map(|s| Compiled::new(&selector(s)?).ok_or_else(|| Fail::Query(QueryError::bad_data(format!("invalid regular expression in {s:?}")))))
        .collect::<Res<_>>()?;
    // What the answer lists: names, values of `name`, or label sets; each charged when first kept.
    let mut names: BTreeSet<String> = BTreeSet::new();
    let mut streams: BTreeSet<Vec<(String, String)>> = BTreeSet::new();
    let mut add = |labels: Vec<(String, String)>, lo: i64, hi: i64, mem: &mut Mem| -> Res<()> {
        if hi < start || lo > end {
            return Ok(());
        }
        if !(sets.is_empty() || sets.iter().any(|c| c.matches(&labels))) {
            return Ok(());
        }
        match kind {
            0 => {
                for (n, _) in labels {
                    if !names.contains(&n) {
                        mem.charge_for("the label names it lists", KEPT + n.len() as u64)?;
                        names.insert(n);
                    }
                }
            }
            1 => {
                if let Some((_, v)) = labels.into_iter().find(|(n, _)| *n == name) {
                    if !names.contains(&v) {
                        mem.charge_for("the label values it lists", KEPT + v.len() as u64)?;
                        names.insert(v);
                    }
                }
            }
            _ => {
                if !streams.contains(&labels) {
                    mem.charge_for("the label sets it lists", KEPT + sigfiles::labels_bytes(&labels))?;
                    streams.insert(labels);
                }
            }
        }
        Ok(())
    };
    for f in &fragments {
        // A fragment lists at most `viz_storage::FRAGMENT_MAX_STREAMS` streams of at most
        // `FRAGMENT_MAX_LABEL_BYTES` (16 KiB) of labels: parsed one at a time, let go after.
        let text = std::str::from_utf8(f).map_err(|e| sigfiles::internal("index fragment", e))?;
        let frag = sigfiles::Frag::parse(text).ok_or_else(|| sigfiles::internal("index fragment", "does not parse"))?;
        let list = frag.streams.ok_or_else(|| sigfiles::internal("index fragment", "has no stream list"))?;
        for s in list {
            add(s.labels, s.min_ts, s.max_ts, &mut mem)?;
        }
    }
    mem.stage = "the streams of the files it reads";
    for f in &files {
        let (list, charged) = sigfiles::file_streams(f, &mut mem)?;
        for (labels, lo, hi) in list {
            add(labels, lo, hi, &mut mem)?;
        }
        mem.release(charged);
    }
    for b in &tails {
        let (list, charged) = sigfiles::batch_streams(b, &mut mem)?;
        for (labels, lo, hi) in list {
            add(labels, lo, hi, &mut mem)?;
        }
        mem.release(charged);
    }
    // The answer: its exact length charged before it is written.
    let len = match kind {
        0 | 1 => 2 + names.iter().map(|x| 1 + sigfiles::json_str_len(x)).sum::<u64>(),
        _ => 2 + streams.iter().map(|s| 3 + s.iter().map(|(n, v)| 2 + sigfiles::json_str_len(n) + sigfiles::json_str_len(v)).sum::<u64>()).sum::<u64>(),
    };
    mem.charge_answer(len)?;
    let mut out = String::with_capacity(len as usize);
    out.push('[');
    if kind < 2 {
        for (i, x) in names.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            sigfiles::json_str(x, &mut out);
        }
    } else {
        for (i, s) in streams.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push('{');
            for (j, (n, v)) in s.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                sigfiles::json_str(n, &mut out);
                out.push(':');
                sigfiles::json_str(v, &mut out);
            }
            out.push('}');
        }
    }
    out.push(']');
    Ok(out.into_bytes())
}

/// Bytes charged per name, value or label set a label call keeps (its set's node share and
/// string header), beside the text.
const KEPT: u64 = 64;
