//! Generates the publisher's test fixtures with the project's own flush encoder.
//!
//! For 3 tenants over 3 UTC days it encodes synthetic batches with
//! `viz_storage::encode_segment` (exactly what a flush produces) and builds the compaction
//! outputs with `viz_storage::merge_files`. It writes one JSON file holding, for each
//! Parquet file: the ledger `FileEntry`, the bytes (base64) and statistics computed from the
//! synthetic rows themselves (a model, not a read of the Parquet file), so a reader's
//! answer can be compared with something that never went through Parquet.
//!
//! Usage: publisher-fixtures <out.json>
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use viz_storage::batch::{self, Row, SeriesDef};
use viz_storage::{encode_segment, merge_files, EncodedFile, Table};

const CELL: &str = "cell-0";
const SHARD: &str = "pool/0";
const INCARNATION: i64 = 7001;
/// 2026-11-10T00:00:00Z
const D0: i64 = 1_794_268_800_000;
const DAY_MS: i64 = 86_400_000;
const STEP_MS: i64 = 15_000;

/// A sample in the model: (metric_name, series_id, ts) -> value.
type SampleKey = (String, i64, i64);

struct Model {
    samples: BTreeMap<SampleKey, f64>,
}

struct Stats {
    rows: u64,
    /// samples: sum of ts, sum of value. series: sum of min_ts, sum of max_ts.
    sum_a: i128,
    sum_b: i128,
}

fn day_of(ts: i64) -> i64 {
    ts.div_euclid(DAY_MS)
}

impl Model {
    fn stats(&self, table: Table, day: i64) -> Stats {
        match table {
            Table::MetricSamples => {
                let mut s = Stats { rows: 0, sum_a: 0, sum_b: 0 };
                for ((_, _, ts), v) in &self.samples {
                    if day_of(*ts) == day {
                        s.rows += 1;
                        s.sum_a += *ts as i128;
                        s.sum_b += *v as i128;
                    }
                }
                s
            }
            Table::MetricSeries => {
                let mut per: BTreeMap<(String, i64), (i64, i64)> = BTreeMap::new();
                for ((name, sid, ts), _) in &self.samples {
                    if day_of(*ts) == day {
                        let e = per.entry((name.clone(), *sid)).or_insert((*ts, *ts));
                        e.0 = e.0.min(*ts);
                        e.1 = e.1.max(*ts);
                    }
                }
                Stats { rows: per.len() as u64, sum_a: per.values().map(|v| v.0 as i128).sum(), sum_b: per.values().map(|v| v.1 as i128).sum() }
            }
        }
    }
    fn merged(models: &[&Model]) -> Model {
        let mut samples = BTreeMap::new();
        for m in models {
            for (k, v) in &m.samples {
                samples.insert(k.clone(), *v);
            }
        }
        Model { samples }
    }
}

struct OutFile {
    tenant: String,
    key: String,
    table: Table,
    day: String,
    level: u32,
    enc: EncodedFile,
    stats: Stats,
}

fn hash8(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

fn key(tenant: &str, f: &EncodedFile, level: u32, seq_lo: u64, seq_hi: u64) -> String {
    format!(
        "{CELL}/data/{}/tenant={tenant}/day={}/L{level}-{}-{INCARNATION}-{seq_lo}-{seq_hi}-{}.parquet",
        f.table.as_str(),
        f.day,
        SHARD.replace('/', "_"),
        hash8(&f.bytes)
    )
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => write!(o, "\\u{:04x}", c as u32).unwrap(),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn entry_json(f: &OutFile) -> String {
    format!(
        "{{\"table\":\"{}\",\"day\":\"{}\",\"key\":{},\"bytes\":{},\"rows\":{},\"minTs\":{},\"maxTs\":{},\"level\":{},\"index\":{}}}",
        f.table.as_str(),
        f.day,
        json_str(&f.key),
        f.enc.bytes.len(),
        f.enc.rows,
        f.enc.min_ts,
        f.enc.max_ts,
        f.level,
        json_str(&f.enc.index)
    )
}

fn main() {
    let out_path = std::env::args().nth(1).expect("usage: publisher-fixtures <out.json>");
    // (tenant, instances per metric). Different sizes so that per-tenant counts differ.
    let tenants: [(&str, usize); 3] = [("acme", 2), ("globex", 3), ("initech", 5)];
    let metrics = ["cpu_seconds_total", "http_requests_total", "up"];
    // Units: (seqLo, seqHi, start offset from D0 in ms, number of steps). Windows do not
    // overlap, so no (series, ts) appears in two units.
    let units: [(u64, u64, i64, i64); 5] = [
        (1, 1, DAY_MS - 20 * STEP_MS, 40),            // D0 and D1
        (2, 3, DAY_MS + 3_600_000, 30),               // D1
        (4, 4, 2 * DAY_MS - 10 * STEP_MS, 25),        // D1 and D2
        (5, 5, 2 * DAY_MS + 7_200_000, 20),           // D2
        (6, 6, 2 * DAY_MS + 10_800_000, 12),          // D2
    ];

    let mut files: Vec<OutFile> = Vec::new();
    let mut units_json: Vec<String> = Vec::new();
    let mut compactions_json: Vec<String> = Vec::new();

    for (ti, (tenant, instances)) in tenants.iter().enumerate() {
        let series: Vec<SeriesDef> = metrics
            .iter()
            .flat_map(|m| {
                (0..*instances).map(move |i| {
                    SeriesDef::new([
                        ("__name__".to_string(), m.to_string()),
                        ("instance".to_string(), format!("{tenant}-host-{i}")),
                        ("job".to_string(), "node".to_string()),
                    ])
                })
            })
            .collect();
        // unit index -> (files produced, model)
        let mut unit_files: Vec<Vec<usize>> = Vec::new();
        let mut unit_models: Vec<Model> = Vec::new();
        let mut tenant_units: Vec<String> = Vec::new();
        for (ui, (seq_lo, seq_hi, start, steps)) in units.iter().enumerate() {
            let mut rows = Vec::new();
            let mut model = Model { samples: BTreeMap::new() };
            for step in 0..*steps {
                let ts = D0 + start + step * STEP_MS;
                for (si, s) in series.iter().enumerate() {
                    let value = ((ti as i64 + 1) * 100_000 + (ui as i64) * 1_000 + step * 7 + si as i64) as f64;
                    rows.push(Row::new(si as u32, ts, value));
                    let name = s.labels.iter().find(|(n, _)| n == "__name__").unwrap().1.clone();
                    model.samples.insert((name, s.series_id, ts), value);
                }
            }
            // Two batches per unit, as a sealed segment would hold several.
            let half = rows.len() / 2;
            let b1 = batch::encode(&series, &rows[..half]).expect("batch");
            let b2 = batch::encode(&series, &rows[half..]).expect("batch");
            let encoded = encode_segment(&[&b1, &b2]).expect("encode_segment");
            let mut idx = Vec::new();
            let mut entries = Vec::new();
            for enc in encoded {
                let day_num = day_of(enc.min_ts);
                let stats = model.stats(enc.table, day_num);
                assert_eq!(stats.rows, enc.rows, "model and encoder disagree on rows");
                let f = OutFile { tenant: tenant.to_string(), key: key(tenant, &enc, 0, *seq_lo, *seq_hi), table: enc.table, day: enc.day.clone(), level: 0, enc, stats };
                entries.push(entry_json(&f));
                idx.push(files.len());
                files.push(f);
            }
            tenant_units.push(format!(
                "{{\"shard\":\"{SHARD}\",\"incarnation\":{INCARNATION},\"seqLo\":{seq_lo},\"seqHi\":{seq_hi},\"files\":[{}]}}",
                entries.join(",")
            ));
            unit_files.push(idx);
            unit_models.push(model);
        }
        units_json.push(format!("{}:[{}]", json_str(tenant), tenant_units.join(",")));

        // Compactions. c0: day D1 of units 1..3 (indexes 0,1,2). c1: day D2 of units 3..5 (indexes 2,3,4).
        let mut tenant_compactions = Vec::new();
        for (unit_idx, day_num, seq_lo, seq_hi) in [(vec![0usize, 1, 2], day_of(D0 + DAY_MS), 1u64, 4u64), (vec![2usize, 3, 4], day_of(D0 + 2 * DAY_MS), 4, 6)] {
            let model = Model::merged(&unit_idx.iter().map(|u| &unit_models[*u]).collect::<Vec<_>>());
            let mut remove = Vec::new();
            let mut add = Vec::new();
            for table in [Table::MetricSamples, Table::MetricSeries] {
                let inputs: Vec<usize> = unit_idx
                    .iter()
                    .flat_map(|u| unit_files[*u].iter().copied())
                    .filter(|i| files[*i].table == table && day_of(files[*i].enc.min_ts) == day_num)
                    .collect();
                let bytes: Vec<&[u8]> = inputs.iter().map(|i| files[*i].enc.bytes.as_slice()).collect();
                let enc = merge_files(table, &bytes).expect("merge_files");
                let stats = model.stats(table, day_num);
                assert_eq!(stats.rows, enc.rows, "model and merge disagree on rows");
                for i in &inputs {
                    remove.push(json_str(&files[*i].key));
                }
                let f = OutFile { tenant: tenant.to_string(), key: key(tenant, &enc, 1, seq_lo, seq_hi), table, day: enc.day.clone(), level: 1, enc, stats };
                add.push(entry_json(&f));
                files.push(f);
            }
            tenant_compactions.push(format!("{{\"remove\":[{}],\"add\":[{}]}}", remove.join(","), add.join(",")));
        }
        compactions_json.push(format!("{}:[{}]", json_str(tenant), tenant_compactions.join(",")));
    }

    let b64 = base64::engine::general_purpose::STANDARD;
    let files_json: Vec<String> = files
        .iter()
        .map(|f| {
            format!(
                "{}:{{\"tenant\":{},\"entry\":{},\"stats\":{{\"rows\":{},\"sumA\":{},\"sumB\":{}}},\"b64\":\"{}\"}}",
                json_str(&f.key),
                json_str(&f.tenant),
                entry_json(f),
                f.stats.rows,
                f.stats.sum_a,
                f.stats.sum_b,
                b64.encode(&f.enc.bytes)
            )
        })
        .collect();
    let tenants_json: Vec<String> = tenants.iter().map(|(t, _)| json_str(t)).collect();
    let doc = format!(
        "{{\"cell\":\"{CELL}\",\"tenants\":[{}],\"days\":[\"2026-11-10\",\"2026-11-11\",\"2026-11-12\"],\"units\":{{{}}},\"compactions\":{{{}}},\"files\":{{{}}}}}\n",
        tenants_json.join(","),
        units_json.join(","),
        compactions_json.join(","),
        files_json.join(",")
    );
    std::fs::write(&out_path, doc).expect("write fixture");
    let total: usize = files.iter().map(|f| f.enc.bytes.len()).sum();
    eprintln!("wrote {} files, {} Parquet bytes, to {}", files.len(), total, out_path);
}
