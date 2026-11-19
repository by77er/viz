//! Benchmark: `cargo run --release --example bench [rows]` (default 1,000,000 rows).
//!
//! Generates `rows` log rows over 200 streams and one hour (deterministic), then times
//! representative queries, best of 3 runs each. Uses the wall clock of this example only;
//! the engine itself reads no clock.

use std::time::Instant;

use viz_logql::{query_range, Direction, LogRow, LogStream, MemSource, Options};

const S: i64 = 1_000_000_000;
const T0: i64 = 1_700_000_000 * S;

fn data(rows: usize) -> Vec<LogStream> {
    let streams = 200usize;
    let per = rows / streams;
    let mut x: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let apps = ["api", "web", "db", "worker"];
    let levels = ["debug", "info", "info", "info", "warn", "error"];
    (0..streams)
        .map(|s| {
            let labels = vec![
                ("app".to_string(), apps[s % 4].to_string()),
                ("env".to_string(), if s % 3 == 0 { "dev" } else { "prod" }.to_string()),
                ("pod".to_string(), format!("pod-{s:03}")),
            ];
            let mut ts = T0;
            let rows = (0..per)
                .map(|i| {
                    ts += (3600 * S) / per as i64;
                    let r = next();
                    let line = if i % 2 == 0 {
                        format!(
                            "level={} msg=\"request {}\" status={} latency={}ms user=u{} trace={:016x}",
                            levels[(r % 6) as usize],
                            r % 1000,
                            [200, 200, 200, 404, 500][(r >> 8) as usize % 5],
                            (r >> 16) % 900,
                            (r >> 24) % 50,
                            r
                        )
                    } else {
                        format!(
                            r#"{{"level":"{}","msg":"request {}","status":{},"latency_ms":{},"user":{{"id":{}}},"trace":"{:016x}"}}"#,
                            levels[(r % 6) as usize],
                            r % 1000,
                            [200, 200, 200, 404, 500][(r >> 8) as usize % 5],
                            (r >> 16) % 900,
                            (r >> 24) % 50,
                            r
                        )
                    };
                    LogRow { ts_ns: ts, line, metadata: vec![] }
                })
                .collect();
            LogStream { labels, rows }
        })
        .collect()
}

fn time(name: &str, src: &MemSource, q: &str, step: i64, total_rows: usize) {
    let opts = Options { limit: 100, direction: Direction::Backward, ..Options::default() };
    let mut best = f64::MAX;
    let mut stats = None;
    for _ in 0..3 {
        let t = Instant::now();
        let r = query_range(src, q, T0, T0 + 3600 * S, step, &opts).expect(q);
        let el = t.elapsed().as_secs_f64();
        if el < best {
            best = el;
            stats = Some(r.stats);
        }
    }
    let st = stats.unwrap();
    println!(
        "| {name} | `{q}` | {:.0} | {:.1} | {:.2} | {} |",
        best * 1000.0,
        st.lines_processed as f64 / best / 1e6,
        st.bytes_processed as f64 / best / 1e6 / 1.0,
        st.lines_processed,
    );
    let _ = total_rows;
}

fn main() {
    let rows: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1_000_000);
    let t = Instant::now();
    let streams = data(rows);
    let bytes: usize = streams.iter().flat_map(|s| s.rows.iter()).map(|r| r.line.len()).sum();
    let src = MemSource::new(streams);
    println!("{rows} rows, {:.1} MB of lines, generated in {:.1} s", bytes as f64 / 1e6, t.elapsed().as_secs_f64());
    println!();
    println!("| case | query | best ms | M rows/s read | MB/s read | rows read |");
    println!("|---|---|---:|---:|---:|---:|");
    time("needle, log query", &src, r#"{env="prod"} |= "trace=00000000deadbeef""#, 60 * S, rows);
    time("filter + logfmt + label filter, log query", &src, r#"{app="api"} |= "error" | logfmt | status >= 500"#, 60 * S, rows);
    time("count by app", &src, r#"sum by (app) (count_over_time({env=~".+"}[1m]))"#, 60 * S, rows);
    time("rate of errors, logfmt", &src, r#"sum by (app) (rate({env="prod"} | logfmt | level="error" | __error__="" [5m]))"#, 60 * S, rows);
    time("json unwrap quantile", &src, r#"quantile_over_time(0.99, {app="web"} | json | unwrap latency_ms | __error__="" [5m]) by (app)"#, 60 * S, rows);
    time("line_format", &src, r#"{app="db"} | logfmt | line_format "{{.level | upper}} {{.status}} {{.latency}}""#, 60 * S, rows);
}
