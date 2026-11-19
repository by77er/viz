//! Results as Loki's HTTP API JSON: the `data` object (`resultType`, `result`, `stats`)
//! of `/loki/api/v1/query` and `/loki/api/v1/query_range`, and the full response.

use crate::eval::{Data, QueryResult, Stats};
use crate::text::format_float_f;

/// A JSON string as Go's `encoding/json` writes it (`<`, `>`, `&`, U+2028 and U+2029
/// escaped, control characters as `\u00XX` except `\n`, `\r`, `\t`).
pub fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn labels_obj(out: &mut String, labels: &[(String, String)]) {
    out.push('{');
    for (i, (k, v)) in labels.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_str(out, k);
        out.push(':');
        json_str(out, v);
    }
    out.push('}');
}

/// Seconds with millisecond precision, as Prometheus' `model.Time` marshals:
/// the timestamp is truncated to milliseconds and printed without trailing zeros.
pub fn seconds(t_ns: i64) -> String {
    let ms = t_ns.div_euclid(1_000_000);
    let (s, frac) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    if frac == 0 {
        return s.to_string();
    }
    let f = format!("{frac:03}");
    let f = f.trim_end_matches('0');
    if s < 0 && frac > 0 {
        // ms = s*1000 + frac with s negative: e.g. -1500 ms = -1.5 s.
        let neg = -ms;
        let f2 = format!("{:03}", neg % 1000);
        return format!("-{}.{}", neg / 1000, f2.trim_end_matches('0'));
    }
    format!("{s}.{f}")
}

fn stats_obj(out: &mut String, st: &Stats) {
    // The documented shape, with what this engine knows; times are the caller's to fill.
    out.push_str(&format!(
        concat!(
            "{{\"summary\":{{\"bytesProcessedPerSecond\":0,\"linesProcessedPerSecond\":0,",
            "\"totalBytesProcessed\":{b},\"totalLinesProcessed\":{l},\"execTime\":0,\"queueTime\":0,",
            "\"totalEntriesReturned\":{r}}},",
            "\"querier\":{{\"store\":{{\"totalChunksRef\":0,\"totalChunksDownloaded\":0,\"chunksDownloadTime\":0,",
            "\"chunk\":{{\"decompressedBytes\":{b},\"decompressedLines\":{l},\"postFilterLines\":{p},\"totalDuplicates\":0}}}}}},",
            "\"ingester\":{{\"totalReached\":0,\"totalChunksMatched\":0,\"totalBatches\":0,\"totalLinesSent\":0,",
            "\"store\":{{\"chunk\":{{\"decompressedBytes\":0,\"decompressedLines\":0,\"postFilterLines\":0,\"totalDuplicates\":0}}}}}}}}"
        ),
        b = st.bytes_processed,
        l = st.lines_processed,
        p = st.entries_after_pipeline,
        r = st.returned
    ));
}

impl QueryResult {
    /// The `data` object of a Loki query response.
    pub fn data_json(&self) -> String {
        let mut out = String::with_capacity(256);
        out.push_str("{\"resultType\":");
        match &self.data {
            Data::Streams(streams) => {
                out.push_str("\"streams\",\"result\":[");
                for (i, s) in streams.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"stream\":");
                    labels_obj(&mut out, &s.labels);
                    out.push_str(",\"values\":[");
                    for (j, (ts, line)) in s.entries.iter().enumerate() {
                        if j > 0 {
                            out.push(',');
                        }
                        out.push_str(&format!("[\"{ts}\","));
                        json_str(&mut out, line);
                        out.push(']');
                    }
                    out.push_str("]}");
                }
                out.push(']');
            }
            Data::Matrix(series) => {
                out.push_str("\"matrix\",\"result\":[");
                for (i, s) in series.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"metric\":");
                    labels_obj(&mut out, &s.labels);
                    out.push_str(",\"values\":[");
                    for (j, (t, v)) in s.points.iter().enumerate() {
                        if j > 0 {
                            out.push(',');
                        }
                        out.push_str(&format!("[{},\"{}\"]", seconds(*t), format_float_f(*v)));
                    }
                    out.push_str("]}");
                }
                out.push(']');
            }
            Data::Vector(samples) => {
                out.push_str("\"vector\",\"result\":[");
                for (i, (labels, t, v)) in samples.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"metric\":");
                    labels_obj(&mut out, labels);
                    out.push_str(&format!(",\"value\":[{},\"{}\"]}}", seconds(*t), format_float_f(*v)));
                }
                out.push(']');
            }
            Data::Scalar(t, v) => {
                out.push_str(&format!("\"scalar\",\"result\":[{},\"{}\"]", seconds(*t), format_float_f(*v)));
            }
        }
        out.push_str(",\"stats\":");
        stats_obj(&mut out, &self.stats);
        out.push('}');
        out
    }

    /// The whole response body: `{"status":"success","data":{…}}`.
    pub fn response_json(&self) -> String {
        format!("{{\"status\":\"success\",\"data\":{}}}", self.data_json())
    }
}

/// An error response body in the Prometheus/Loki shape.
pub fn error_json(e: &crate::error::Error) -> String {
    let mut out = String::from("{\"status\":\"error\",\"errorType\":");
    json_str(&mut out, e.error_type());
    out.push_str(",\"error\":");
    json_str(&mut out, &e.to_string());
    out.push('}');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seconds_like_model_time() {
        assert_eq!(seconds(1_500_000_000), "1.5");
        assert_eq!(seconds(2_000_000_001), "2");
        assert_eq!(seconds(1_700_000_000_123_000_000), "1700000000.123");
        assert_eq!(seconds(-1_500_000_000), "-1.5");
    }

    #[test]
    fn strings_like_go() {
        let mut s = String::new();
        json_str(&mut s, "a<b>&\u{1b}\n\"é");
        assert_eq!(s, "\"a\\u003cb\\u003e\\u0026\\u001b\\n\\\"é\"");
    }
}
