//! Experiment for DESIGN §5.1: does putting a hash of "locality labels" in the top bits
//! of `series_id` make label matchers map to fewer row groups / pages?
//!
//!   CARGO_TARGET_DIR=$PWD/target cargo run --release --example locality -- [series] [samples_per_series]
//!
//! The same dataset is encoded twice with `encode_segment`:
//!   (a) series_id = FNV-1a 64 of all labels (contracts/BATCH.md, as today)
//!   (b) series_id = 12 bits of FNV(namespace) | 12 bits of FNV(job) | low 40 bits of (a)
//! and three queries are run on both with `select`. The two results must be identical
//! (labels, timestamps, value bits) before anything is compared. Reported per query:
//! row groups that row-group statistics cannot exclude (the engine's own pruning rule) and
//! their compressed bytes; data pages and bytes that would be read if page statistics
//! existed (computed from the offset index and the real column values); select time.
//!
//! Nothing here is linked into the engine; it only uses the crate's public API.
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::serialized_reader::ReadOptionsBuilder;
use parquet::file::statistics::Statistics;
use parquet::record::RowAccessor;
use std::time::Instant;
use viz_storage::batch::{self, Row, SeriesDef};
use viz_storage::{encode_segment, select, EncodedFile, MatchOp, Matcher, ScanInput, Table};

const T0: i64 = 1_700_006_400_000; // 2023-11-15T00:00:00Z

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    /// Zipf-like pick: index i with weight 1/(i+1)^s.
    fn zipf(&mut self, cdf: &[f64]) -> usize {
        let u = (self.next() >> 11) as f64 / (1u64 << 53) as f64;
        cdf.partition_point(|c| *c < u).min(cdf.len() - 1)
    }
}

fn zipf_cdf(n: usize, s: f64) -> Vec<f64> {
    let w: Vec<f64> = (0..n).map(|i| 1.0 / ((i + 1) as f64).powf(s)).collect();
    let total: f64 = w.iter().sum();
    let mut acc = 0.0;
    w.iter().map(|x| { acc += x / total; acc }).collect()
}

fn fnv(parts: &[&str]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 12 well-mixed bits of a 64-bit hash (xor-fold; FNV's low bits alone are weak).
fn fold12(h: u64) -> u64 {
    let h = h ^ (h >> 32);
    (h ^ (h >> 12) ^ (h >> 24)) & 0xfff
}

fn local_id(labels: &[(String, String)], plain: i64) -> i64 {
    let get = |k: &str| labels.iter().find(|(n, _)| n == k).map_or("", |(_, v)| v.as_str());
    let ns = fold12(fnv(&["namespace", get("namespace")]));
    let job = fold12(fnv(&["job", get("job")]));
    ((ns << 52) | (job << 40) | (plain as u64 & ((1u64 << 40) - 1))) as i64
}

fn dataset(n_series: usize, rng: &mut Rng) -> Vec<Vec<(String, String)>> {
    const METRICS: usize = 50;
    const NAMESPACES: usize = 40;
    const JOBS: usize = 160;
    let metric_cdf = zipf_cdf(METRICS, 0.8);
    let job_cdf = zipf_cdf(JOBS, 1.0);
    let ns_cdf = zipf_cdf(NAMESPACES, 1.0);
    // Each job lives in one namespace (as a Kubernetes workload does); big namespaces hold more jobs.
    let job_ns: Vec<usize> = (0..JOBS).map(|_| rng.zipf(&ns_cdf)).collect();
    // Pods per job: skewed, 3 to ~300.
    let job_pods: Vec<usize> = (0..JOBS).map(|j| 3 + 300 / (j / 4 + 1)).collect();
    let routes = ["/", "/api/v1/query", "/api/v1/write", "/healthz", "/login", "/items", "/items/:id", "/cart", "/checkout", "/static/*", "/metrics", "/admin"];
    let statuses = ["200", "204", "400", "404", "500"];
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(n_series);
    while out.len() < n_series {
        let m = rng.zipf(&metric_cdf);
        let j = rng.zipf(&job_cdf);
        let pod = rng.below(job_pods[j]);
        let mut l = vec![
            ("__name__".to_string(), format!("metric_{m:02}_total")),
            ("instance".to_string(), format!("10.{}.{}.{}:9090", j % 250, pod / 250, pod % 250)),
            ("job".to_string(), format!("job-{j:03}")),
            ("namespace".to_string(), format!("ns-{:02}", job_ns[j])),
            ("pod".to_string(), format!("job-{j:03}-{:05x}-{pod}", (j * 7919) & 0xfffff)),
        ];
        // Two thirds of the metrics are HTTP-shaped: route × status per pod.
        if m % 3 != 0 {
            l.push(("route".to_string(), routes[rng.below(routes.len())].to_string()));
            l.push(("status".to_string(), statuses[rng.zipf(&[0.8, 0.85, 0.9, 0.97, 1.0])].to_string()));
        }
        l.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let id = batch::series_id(&l);
        if seen.insert(id) {
            out.push(l);
        }
    }
    out
}

fn encode(series: &[Vec<(String, String)>], ids: &[i64], samples: usize) -> (EncodedFile, EncodedFile) {
    // Batches of 2,000 series, as arrival order (unsorted); values depend on series and time.
    let mut batches = Vec::new();
    for (c, chunk) in series.chunks(2000).enumerate() {
        let defs: Vec<SeriesDef> = chunk.iter().enumerate().map(|(i, l)| SeriesDef { series_id: ids[c * 2000 + i], labels: l.clone() }).collect();
        let mut rows = Vec::with_capacity(chunk.len() * samples);
        for k in 0..samples {
            for i in 0..chunk.len() {
                rows.push(Row::new(i as u32, T0 + (k as i64) * 60_000 + (i as i64 % 1000), ((c * 2000 + i) * 31 + k) as f64 * 0.5));
            }
        }
        batches.push(batch::encode(&defs, &rows).expect("valid batch"));
    }
    let refs: Vec<&[u8]> = batches.iter().map(|b| b.as_slice()).collect();
    let mut files = encode_segment(&refs).expect("encode");
    assert_eq!(files.len(), 2, "one day");
    let series_file = files.pop().unwrap();
    let samples_file = files.pop().unwrap();
    assert!(samples_file.table == Table::MetricSamples && series_file.table == Table::MetricSeries);
    (samples_file, series_file)
}

struct Touch {
    rg: usize,
    rg_total: usize,
    rg_bytes: u64,
    pages: usize,
    pages_total: usize,
    page_bytes: u64,
}

/// Which row groups the engine's pruning keeps for this (metric names, ids) set, and what a
/// page-level reader would fetch: every page of every column that overlaps a matching row.
fn touch(samples: &[u8], want_names: &[Vec<u8>], want_ids: &[i64]) -> Touch {
    let r = SerializedFileReader::new_with_options(bytes::Bytes::copy_from_slice(samples), ReadOptionsBuilder::new().with_page_index().build()).unwrap();
    let md = r.metadata();
    let mut t = Touch { rg: 0, rg_total: md.num_row_groups(), rg_bytes: 0, pages: 0, pages_total: 0, page_bytes: 0 };
    let offset_index = md.page_index();
    for g in 0..md.num_row_groups() {
        let rg = md.row_group(g);
        if let Some(oi) = offset_index {
            for c in 0..4 {
                t.pages_total += oi.offset_index(g, c).map_or(0, |o| o.page_locations().len());
            }
        }
        let Some(Statistics::ByteArray(names)) = rg.column(0).statistics() else { panic!("no name stats") };
        let Some(Statistics::Int64(ids)) = rg.column(1).statistics() else { panic!("no id stats") };
        let (nlo, nhi) = (names.min_opt().unwrap().data(), names.max_opt().unwrap().data());
        let (ilo, ihi) = (*ids.min_opt().unwrap(), *ids.max_opt().unwrap());
        let name_hit = want_names.is_empty() || { let i = want_names.partition_point(|n| n.as_slice() < nlo); i < want_names.len() && want_names[i].as_slice() <= nhi };
        let id_hit = { let i = want_ids.partition_point(|x| *x < ilo); i < want_ids.len() && want_ids[i] <= ihi };
        if !(name_hit && id_hit) {
            continue;
        }
        t.rg += 1;
        t.rg_bytes += rg.compressed_size() as u64;
        // Page level: rows of this group whose series is wanted.
        let rows = rg.num_rows() as usize;
        let mut hit = vec![false; rows];
        let reader = r.get_row_group(g).unwrap();
        for (i, row) in reader.get_row_iter(None).unwrap().enumerate() {
            let row = row.unwrap();
            let id = row.get_long(1).unwrap();
            hit[i] = want_ids.binary_search(&id).is_ok() && (want_names.is_empty() || want_names.binary_search_by(|n| n.as_slice().cmp(row.get_string(0).unwrap().as_bytes())).is_ok());
        }
        if let Some(oi) = offset_index {
            for c in 0..4 {
                let Some(o) = oi.offset_index(g, c) else { continue };
                let locs = o.page_locations();
                for (p, loc) in locs.iter().enumerate() {
                    let lo = loc.first_row_index as usize;
                    let hi = locs.get(p + 1).map_or(rows, |n| n.first_row_index as usize);
                    if hit[lo..hi].iter().any(|h| *h) {
                        t.pages += 1;
                        t.page_bytes += loc.compressed_page_size as u64;
                    }
                }
            }
        }
    }
    t
}

fn canon(series: &[viz_storage::SeriesData]) -> (usize, usize, u64) {
    // Order-independent digest of (labels, ts, value bits); select output is sorted by labels.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut samples = 0;
    for s in series {
        for (n, v) in &s.labels {
            h = (h ^ fnv(&[n, v])).wrapping_mul(0x0000_0100_0000_01b3);
        }
        for (t, v) in s.ts.iter().zip(&s.values) {
            h = (h ^ (*t as u64)).wrapping_mul(0x0000_0100_0000_01b3);
            h = (h ^ v.to_bits()).wrapping_mul(0x0000_0100_0000_01b3);
        }
        samples += s.ts.len();
    }
    (series.len(), samples, h)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n_series: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(200_000);
    let samples: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30);
    let mut rng = Rng(42);
    let series = dataset(n_series, &mut rng);
    let plain: Vec<i64> = series.iter().map(|l| batch::series_id(l)).collect();
    let local: Vec<i64> = series.iter().zip(&plain).map(|(l, p)| local_id(l, *p)).collect();
    {
        let mut u = local.clone();
        u.sort_unstable();
        u.dedup();
        println!("series {n_series}, samples/series {samples}, rows {}; distinct ids: plain {} local {}", n_series * samples, { let mut p = plain.clone(); p.sort_unstable(); p.dedup(); p.len() }, u.len());
        assert_eq!(u.len(), n_series, "scheme (b) collided on this dataset");
    }

    let get = |l: &Vec<(String, String)>, k: &str| l.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
    // Queries: the biggest metric; a mid-sized namespace on it; a mid-sized job across all metrics.
    let count = |k: &str| { let mut m = std::collections::HashMap::<String, usize>::new(); for l in &series { *m.entry(get(l, k)).or_default() += 1; } let mut v: Vec<_> = m.into_iter().collect(); v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0))); v };
    let metrics = count("__name__");
    let namespaces = count("namespace");
    let jobs = count("job");
    let metric = metrics[0].0.clone();
    let ns_mid = namespaces[namespaces.len() / 4].0.clone();
    let ns_big = namespaces[0].0.clone();
    let job_mid = jobs[jobs.len() / 4].0.clone();
    println!("metric {metric} has {} series; namespace {ns_mid} has {}, {ns_big} has {}; job {job_mid} has {}", metrics[0].1, namespaces[namespaces.len() / 4].1, namespaces[0].1, jobs[jobs.len() / 4].1);

    let m = |n: &str, v: &str| Matcher::new(n, MatchOp::Eq, v);
    let queries: Vec<(String, Vec<Matcher>)> = vec![
        (format!("{{__name__=\"{metric}\",namespace=\"{ns_mid}\"}}"), vec![m("__name__", &metric), m("namespace", &ns_mid)]),
        (format!("{{__name__=\"{metric}\",namespace=\"{ns_big}\"}}"), vec![m("__name__", &metric), m("namespace", &ns_big)]),
        (format!("{{namespace=\"{ns_mid}\"}}"), vec![m("namespace", &ns_mid)]),
        (format!("{{job=\"{job_mid}\"}}"), vec![m("job", &job_mid)]),
        (format!("{{__name__=\"{metric}\",job=\"{job_mid}\"}}"), vec![m("__name__", &metric), m("job", &job_mid)]),
        (format!("{{__name__=\"{metric}\"}}"), vec![m("__name__", &metric)]),
    ];

    let schemes: [(&str, &Vec<i64>); 2] = [("(a) plain FNV-64", &plain), ("(b) ns12|job12|fnv40", &local)];
    let mut encoded = Vec::new();
    for (name, ids) in schemes {
        let t = Instant::now();
        let (sf, rf) = encode(&series, ids, samples);
        println!("{name}: samples file {} bytes ({} rows), series file {} bytes, encode {:.1}s", sf.bytes.len(), sf.rows, rf.bytes.len(), t.elapsed().as_secs_f64());
        encoded.push((name, ids, sf, rf));
    }

    println!("\n| query | scheme | series | samples | row groups | rg bytes | pages | page bytes | select ms |");
    println!("|---|---|---|---|---|---|---|---|---|");
    for (text, matchers) in &queries {
        let mut digests = Vec::new();
        for (name, ids, sf, rf) in &encoded {
            let input = ScanInput { series_files: vec![&rf.bytes], sample_files: vec![&sf.bytes], tail_batches: vec![] };
            let mut times = Vec::new();
            let mut result = Vec::new();
            for _ in 0..5 {
                let t = Instant::now();
                result = select(&input, matchers, i64::MIN, i64::MAX).expect("select");
                times.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let d = canon(&result);
            // The ids and names the query resolves to, from the generated dataset itself.
            let matches = |l: &Vec<(String, String)>| matchers.iter().all(|q| get(l, &q.name) == q.value);
            let mut want_ids: Vec<i64> = series.iter().zip(ids.iter()).filter(|(l, _)| matches(l)).map(|(_, i)| *i).collect();
            want_ids.sort_unstable();
            let mut want_names: Vec<Vec<u8>> = series.iter().filter(|l| matches(l)).map(|l| get(l, "__name__").into_bytes()).collect();
            want_names.sort_unstable();
            want_names.dedup();
            assert_eq!(want_ids.len(), d.0, "select returned a different number of series than the dataset has");
            let t = touch(&sf.bytes, &want_names, &want_ids);
            println!("| `{text}` | {name} | {} | {} | {}/{} | {} | {}/{} | {} | {:.1} |", d.0, d.1, t.rg, t.rg_total, t.rg_bytes, t.pages, t.pages_total, t.page_bytes, times[2]);
            digests.push(d);
        }
        assert_eq!(digests[0], digests[1], "the two encodings returned different results for {text}");
    }
    println!("\nresults identical between the two encodings for every query");
}
