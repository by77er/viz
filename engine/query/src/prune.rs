//! File pruning from the ledger's index fragments (`viz_storage::FileIndex`).
//!
//! A query Worker gets the live files of a time range from the ledger, each with its
//! index fragment. Before fetching anything it asks here which files the fetch plan can
//! possibly read. The engine owns the fragment's format, so the decision lives here.
use crate::catalog;
use crate::error::QueryError;
use crate::plan::FetchRange;
use crate::split::SplitKey;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use viz_promql::{CompiledMatcher, MatchOp, NAME_LABEL};
use viz_storage::FileIndex;

/// For each index fragment (one per file, of either table): `true` if the file may hold
/// a row some range of the plan reads, `false` if it provably holds none and need not
/// be fetched.
///
/// A row group can contribute to a range only if its time span overlaps the range and,
/// when the range has an equality matcher on `__name__`, the name lies within the row
/// group's `[min_name, max_name]` (both exact, byte order). A file is skipped only when
/// no row group can contribute to any range. Everything else keeps the file: other
/// matcher kinds are not used, and a fragment that does not parse is kept (a file is
/// never skipped on a guess).
///
/// The same rule is sound for `metric_series` files: a series with a sample in the
/// range in this file has a row whose `[min_ts, max_ts]` covers that sample, so the
/// series row group overlaps whenever the sample row group does.
///
/// Guarantee (tested as `skipping_files_never_changes_a_result`): evaluating over only
/// the files marked `true` gives the same result as evaluating over all of them.
pub fn files_needed(indexes: &[&str], ranges: &[FetchRange]) -> Vec<bool> {
    scan_rows(indexes, ranges).into_iter().map(|rows| rows != Some(0)).collect()
}

/// For each index fragment: an upper bound on the rows a read of `ranges` decodes from
/// the file, or `None` if the fragment does not parse (the bound is then unknown and the
/// file must be read). `Some(0)` is exactly the "skip" of [`files_needed`].
///
/// The bound is the row count of every row group that may contribute to a range, summed
/// over the ranges (a row group two ranges touch is decoded once for each). For a
/// `metric_samples` file this bounds the samples a query can load from it, so a caller
/// can refuse a query that would decode too much BEFORE fetching anything: the limits on
/// loaded samples only fire once a selector's samples are in memory.
pub fn scan_rows(indexes: &[&str], ranges: &[FetchRange]) -> Vec<Option<u64>> {
    // The name each range is pinned to, if any. Two different equalities match nothing,
    // but that is the evaluator's business; here either may be used.
    let names: Vec<Option<&str>> = ranges
        .iter()
        .map(|r| r.matchers.iter().find(|m| m.name == NAME_LABEL && m.op == MatchOp::Eq).map(|m| m.value.as_str()))
        .collect();
    indexes
        .iter()
        .map(|text| {
            let index = FileIndex::from_json(text).ok()?;
            let mut rows = 0u64;
            for g in &index.row_groups {
                for (r, name) in ranges.iter().zip(&names) {
                    if g.min_ts <= r.max_ts
                        && g.max_ts >= r.min_ts
                        && name.is_none_or(|n| n.as_bytes() >= g.min_name.as_bytes() && n.as_bytes() <= g.max_name.as_bytes())
                    {
                        rows = rows.saturating_add(g.rows);
                    }
                }
            }
            Some(rows)
        })
        .collect()
}

// ───────────────────────── reading part of a file ─────────────────────────

/// Ranges less than this many bytes apart are read as one (contracts/TABLES.md, "Reading
/// part of a file"). A range read costs about one round trip whatever its size below
/// 1 MB, so reading 64 KiB too many beats a second read.
pub const RANGE_GAP: u64 = 64 << 10;

/// How a caller should read one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRead {
    /// Nothing in the file is needed.
    Skip,
    /// The whole object: the fragment has no footer location (written before 2026-11-19)
    /// or does not parse, or the ranges would cover at least half of the file anyway.
    Whole,
    /// These `(offset, length)` ranges, sorted and disjoint: the footer and the row groups
    /// needed. The engine takes them as a sparse file container (`viz_storage::sparse`).
    Ranges(Vec<(u64, u64)>),
}

/// One file's plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePlan {
    pub read: FileRead,
    /// The rows of the row groups the reads may decode, each row group once per read that
    /// may use it (the bound of [`scan_rows`], narrowed); `None` when the fragment does not
    /// parse.
    pub rows: Option<u64>,
}

impl FilePlan {
    /// Bytes a caller fetches for this plan (`size` is the object's size).
    pub fn bytes(&self, size: u64) -> u64 {
        match &self.read {
            FileRead::Skip => 0,
            FileRead::Whole => size,
            FileRead::Ranges(r) => r.iter().map(|x| x.1).sum(),
        }
    }
}

/// What a set of reads needs of a list of files.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReadPlan {
    pub files: Vec<FilePlan>,
    /// Series the reads select, summed over the reads as `max_series` counts them: per read,
    /// the distinct series whose labels match and that are in the read's time range in some
    /// series file (decided per file). Exact for the lake; the tail is not in it.
    pub series: u64,
}

/// Which row groups of one fragment the reads use, and the rows they decode.
fn groups_of(index: &FileIndex, uses: &dyn Fn(&viz_storage::RowGroupIndex) -> u64) -> (Vec<usize>, u64) {
    let mut groups = Vec::new();
    let mut rows = 0u64;
    for (g, rg) in index.row_groups.iter().enumerate() {
        let k = uses(rg);
        if k > 0 {
            groups.push(g);
            rows = rows.saturating_add(rg.rows.saturating_mul(k));
        }
    }
    (groups, rows)
}

fn decide(index: &FileIndex, groups: &[usize], rows: u64, gap: u64) -> FilePlan {
    if groups.is_empty() {
        return FilePlan { read: FileRead::Skip, rows: Some(0) };
    }
    let read = match index.byte_ranges(groups, gap) {
        Some(r) => {
            let size = index.foot.map_or(0, |(o, l)| o + l);
            let held: u64 = r.iter().map(|x| x.1).sum();
            if held.saturating_mul(2) >= size {
                FileRead::Whole
            } else {
                FileRead::Ranges(r)
            }
        }
        None => FileRead::Whole,
    };
    FilePlan { read, rows: Some(rows) }
}

const ANY_SID: [(i64, i64); 1] = [(i64::MIN, i64::MAX)];

/// From the fragments alone: the row groups each file's reads may use by time and, where
/// a read pins `__name__` with `=`, by name; the rows they decode (exactly [`scan_rows`])
/// and the byte ranges to fetch. For either table; no series are resolved.
pub fn file_plan(indexes: &[&str], ranges: &[FetchRange], gap: u64) -> Vec<FilePlan> {
    let names: Vec<Option<&str>> = ranges
        .iter()
        .map(|r| r.matchers.iter().find(|m| m.name == NAME_LABEL && m.op == MatchOp::Eq).map(|m| m.value.as_str()))
        .collect();
    indexes
        .iter()
        .map(|text| {
            let Ok(index) = FileIndex::from_json(text) else { return FilePlan { read: FileRead::Whole, rows: None } };
            let (groups, rows) = groups_of(&index, &|g| {
                ranges.iter().zip(&names).filter(|(r, n)| g.overlaps(r.min_ts, r.max_ts) && n.is_none_or(|n| g.may_hold(n.as_bytes(), &ANY_SID))).count() as u64
            });
            decide(&index, &groups, rows, gap)
        })
        .collect()
}

/// One part of a split: only series whose split key falls in part `part` of `parts`.
#[derive(Debug, Clone, Copy)]
pub struct PartFilter<'a> {
    pub key: &'a SplitKey,
    pub part: u32,
    pub parts: u32,
}

/// Series-level pruning (query/CARDINALITY.md, item 2): resolve each read's matchers
/// against the `metric_series` files (whole or sparse; `series_files`), keep the series of
/// `part` if given, and plan each `metric_samples` file (`indexes`: their fragments) to
/// fetch only the footer and the row groups whose key range can hold one of those series
/// and whose time overlaps the read (`viz_storage::RowGroupIndex::may_hold`).
///
/// `series_files` must describe every series of the sample files (the files written with
/// them, as for `viz_storage::select`). A read whose only matcher is `__name__ = x` needs no
/// labels: every series of `x` is wanted.
///
/// Guarantee (tested as `the_sample_plan_never_changes_a_result`): evaluating over the
/// sample files read as planned (skipped, whole, or as sparse files of the ranges) gives the
/// same result as over the whole files.
pub fn sample_plan(series_files: &[&[u8]], indexes: &[&str], reads: &[FetchRange], part: Option<PartFilter<'_>>, gap: u64) -> Result<ReadPlan, QueryError> {
    struct Read {
        ms: Vec<CompiledMatcher>,
        name: Option<Vec<u8>>,
        /// Only `__name__ = x`: no labels needed.
        name_only: bool,
        min_ts: i64,
        max_ts: i64,
        /// Wanted sids per metric name (sorted, then turned into intervals).
        sids: BTreeMap<Vec<u8>, Vec<i64>>,
        /// Distinct series in the window (decided per file).
        seen: HashSet<i64>,
    }
    let mut rs: Vec<Read> = reads
        .iter()
        .map(|r| {
            let ms = r.matchers.iter().map(|m| m.compile()).collect::<Result<Vec<_>, _>>().map_err(QueryError::from_promql)?;
            let name = r.matchers.iter().find(|m| m.name == NAME_LABEL && m.op == MatchOp::Eq).map(|m| m.value.as_bytes().to_vec());
            let name_only = name.is_some() && r.matchers.iter().all(|m| m.name == NAME_LABEL && m.op == MatchOp::Eq);
            Ok(Read { ms, name, name_only, min_ts: r.min_ts, max_ts: r.max_ts, sids: BTreeMap::new(), seen: HashSet::new() })
        })
        .collect::<Result<_, QueryError>>()?;
    let part_needs_labels = part.is_some_and(|p| !p.key.without.is_empty());
    // A series' split key is its series_id unless it carries a `without` label: as canonical
    // JSON keys, `"name":` can only occur in the labels text as a key (a quote inside a
    // value is escaped), so a text without any of them needs no parse to place the series.
    let needles: Vec<Vec<u8>> = part
        .map(|p| {
            p.key
                .without
                .iter()
                .map(|w| {
                    let mut s = String::new();
                    viz_storage::json::write_string(&mut s, w);
                    s.push(':');
                    s.into_bytes()
                })
                .collect()
        })
        .unwrap_or_default();
    let carries = |json: &[u8]| needles.iter().any(|n| json.windows(n.len()).any(|w| w == &n[..]));
    let need_labels = part_needs_labels || rs.iter().any(|r| !r.name_only);
    let names: Option<BTreeSet<Vec<u8>>> = rs.iter().map(|r| r.name.clone()).collect();
    let want = |n: &[u8]| names.as_ref().is_none_or(|s| s.contains(n));
    let want_range = |lo: &[u8], hi: &[u8]| lo > hi || names.as_ref().is_none_or(|s| s.range(lo.to_vec()..=hi.to_vec()).next().is_some());

    // series_id -> (in the part, which reads match), decided once from its labels.
    let mut decided: HashMap<i64, (bool, Vec<bool>)> = HashMap::new();
    for (fi, f) in series_files.iter().enumerate() {
        catalog::for_each_series_with(f, fi, &want_range, &want, need_labels, &mut |row| {
            let (mine, hits) = match decided.get(&row.series_id) {
                Some(d) => d.clone(),
                None => {
                    let parse = rs.iter().any(|r| !r.name_only) || (part_needs_labels && carries(row.labels_json));
                    let labels = if parse { Some(catalog::parse_labels(row.labels_json)?) } else { None };
                    let labels_or = || labels.as_ref().ok_or_else(|| QueryError::internal("sample plan: labels were not read"));
                    let mine = match part {
                        None => true,
                        Some(p) if p.key.without.is_empty() || !carries(row.labels_json) => SplitKey::part_of(row.series_id as u64, p.parts) == p.part,
                        Some(p) => p.key.part(labels_or()?, p.parts) == p.part,
                    };
                    let mut hits: Vec<bool> = Vec::with_capacity(rs.len());
                    for r in rs.iter() {
                        let hit = if r.name_only {
                            r.name.as_deref() == Some(row.metric_name)
                        } else {
                            let l = labels_or()?;
                            r.ms.iter().all(|m| m.matches(l))
                        };
                        hits.push(hit);
                    }
                    decided.insert(row.series_id, (mine, hits.clone()));
                    (mine, hits)
                }
            };
            if !mine {
                return Ok(());
            }
            for (r, hit) in rs.iter_mut().zip(hits) {
                if hit {
                    // Wanted whatever its time here: the row groups' own times decide.
                    let v = r.sids.entry(row.metric_name.to_vec()).or_default();
                    if v.last() != Some(&row.series_id) {
                        v.push(row.series_id);
                    }
                    if row.min_ts <= r.max_ts && row.max_ts >= r.min_ts {
                        r.seen.insert(row.series_id);
                    }
                }
            }
            Ok(())
        })?;
    }
    let series = rs.iter().map(|r| r.seen.len() as u64).sum();
    let wanted: Vec<Vec<(Vec<u8>, Vec<(i64, i64)>)>> = rs
        .iter_mut()
        .map(|r| {
            std::mem::take(&mut r.sids)
                .into_iter()
                .map(|(n, mut ids)| {
                    ids.sort_unstable();
                    ids.dedup();
                    (n, ids.into_iter().map(|i| (i, i)).collect())
                })
                .collect()
        })
        .collect();
    let files = indexes
        .iter()
        .map(|text| {
            let Ok(index) = FileIndex::from_json(text) else { return FilePlan { read: FileRead::Whole, rows: None } };
            let (groups, rows) = groups_of(&index, &|g| {
                rs.iter().zip(&wanted).filter(|(r, w)| g.overlaps(r.min_ts, r.max_ts) && w.iter().any(|(n, iv)| g.may_hold(n, iv))).count() as u64
            });
            decide(&index, &groups, rows, gap)
        })
        .collect();
    Ok(ReadPlan { files, series })
}

/// The `series_id`s whose split key is in part `part` of `parts` when the key is the
/// `series_id` (`SplitKey::part_of`): sorted, disjoint, inclusive intervals in `i64`
/// order (one, or two when the part spans the sign boundary of the `u64` key space).
pub fn part_sids(part: u32, parts: u32) -> Vec<(i64, i64)> {
    if parts == 0 || part >= parts {
        return Vec::new();
    }
    // Smallest key k with (k * parts) >> 64 == j is ceil(j * 2^64 / parts).
    let first = |j: u32| -> u128 { ((j as u128) << 64).div_ceil(parts as u128) };
    let lo = first(part) as u64;
    let hi = (first(part + 1) - 1) as u64;
    if (lo as i64) <= (hi as i64) {
        vec![(lo as i64, hi as i64)]
    } else {
        // lo < 2^63 <= hi: the part wraps from i64::MAX to i64::MIN.
        vec![(i64::MIN, hi as i64), (lo as i64, i64::MAX)]
    }
}

/// From the fragments alone, for one part of a split: the row groups of each file whose
/// time overlaps a range and whose key range can hold a series of `ranges`' metric (where
/// a range pins `__name__` with `=`) with a `series_id` in the part ([`part_sids`]). Exact
/// for series whose split key is their `series_id`, which is every series that carries
/// none of the key's `without` labels; a reader that finds a series of its part outside
/// this (one that does carry them) must read more, which [`sample_plan`] with the part
/// tells it. A range without a name keeps every row group it overlaps.
pub fn part_plan(indexes: &[&str], ranges: &[FetchRange], part: u32, parts: u32, gap: u64) -> Vec<FilePlan> {
    let sids = part_sids(part, parts);
    let names: Vec<Option<&str>> = ranges
        .iter()
        .map(|r| r.matchers.iter().find(|m| m.name == NAME_LABEL && m.op == MatchOp::Eq).map(|m| m.value.as_str()))
        .collect();
    indexes
        .iter()
        .map(|text| {
            let Ok(index) = FileIndex::from_json(text) else { return FilePlan { read: FileRead::Whole, rows: None } };
            let (groups, rows) = groups_of(&index, &|g| {
                ranges.iter().zip(&names).filter(|(r, n)| g.overlaps(r.min_ts, r.max_ts) && n.is_none_or(|n| g.may_hold(n.as_bytes(), &sids))).count() as u64
            });
            decide(&index, &groups, rows, gap)
        })
        .collect()
}
