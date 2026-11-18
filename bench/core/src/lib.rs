//! Benchmark core: Parquet encode and a rate-and-sum query over metric samples.
//! No I/O; the host passes byte buffers in and gets byte buffers out.
use bytes::Bytes;
use parquet::basic::{Compression, Encoding, Repetition, Type as PhysicalType};
use parquet::column::reader::ColumnReader;
use parquet::column::writer::ColumnWriter;
use parquet::data_type::ByteArray;
use parquet::file::properties::{EnabledStatistics, WriterProperties, WriterVersion};
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::statistics::Statistics;
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::types::{ColumnPath, Type};
use std::sync::Arc;

pub const ROW_GROUP: usize = 240_000;
const STEP_MS: i64 = 60_000;
const WINDOW_MS: i64 = 300_000;

pub fn encode(names: &[&str], name_idx: &[u32], sid: &[i64], ts: &[i64], val: &[f64]) -> Vec<u8> {
    let f = |n: &str, t: PhysicalType| {
        Arc::new(Type::primitive_type_builder(n, t).with_repetition(Repetition::REQUIRED).build().unwrap())
    };
    let name_t = Arc::new(
        Type::primitive_type_builder("metric_name", PhysicalType::BYTE_ARRAY)
            .with_repetition(Repetition::REQUIRED)
            .with_converted_type(parquet::basic::ConvertedType::UTF8)
            .build()
            .unwrap(),
    );
    let schema = Arc::new(
        Type::group_type_builder("root")
            .with_fields(vec![name_t, f("series_id", PhysicalType::INT64), f("ts", PhysicalType::INT64), f("value", PhysicalType::DOUBLE)])
            .build()
            .unwrap(),
    );
    let props = Arc::new(
        WriterProperties::builder()
            .set_writer_version(WriterVersion::PARQUET_2_0)
            .set_compression(Compression::SNAPPY)
            .set_statistics_enabled(EnabledStatistics::Chunk)
            .set_data_page_size_limit(256 * 1024)
            .set_column_dictionary_enabled(ColumnPath::from("series_id"), false)
            .set_column_encoding(ColumnPath::from("series_id"), Encoding::DELTA_BINARY_PACKED)
            .set_column_dictionary_enabled(ColumnPath::from("ts"), false)
            .set_column_encoding(ColumnPath::from("ts"), Encoding::DELTA_BINARY_PACKED)
            .set_column_dictionary_enabled(ColumnPath::from("value"), false)
            .set_column_encoding(ColumnPath::from("value"), Encoding::BYTE_STREAM_SPLIT)
            .build(),
    );
    let name_vals: Vec<ByteArray> = names.iter().map(|n| ByteArray::from(*n)).collect();
    let mut out = Vec::with_capacity(val.len() * 4);
    let mut w = SerializedFileWriter::new(&mut out, schema, props).unwrap();
    let n = val.len();
    let mut start = 0;
    let mut name_buf: Vec<ByteArray> = Vec::with_capacity(ROW_GROUP);
    while start < n {
        let end = (start + ROW_GROUP).min(n);
        let mut rg = w.next_row_group().unwrap();
        let mut col = 0;
        while let Some(mut cw) = rg.next_column().unwrap() {
            match cw.untyped() {
                ColumnWriter::ByteArrayColumnWriter(c) => {
                    name_buf.clear();
                    name_buf.extend(name_idx[start..end].iter().map(|i| name_vals[*i as usize].clone()));
                    c.write_batch(&name_buf, None, None).unwrap();
                }
                ColumnWriter::Int64ColumnWriter(c) => {
                    let src = if col == 1 { sid } else { ts };
                    c.write_batch(&src[start..end], None, None).unwrap();
                }
                ColumnWriter::DoubleColumnWriter(c) => {
                    c.write_batch(&val[start..end], None, None).unwrap();
                }
                _ => unreachable!(),
            }
            cw.close().unwrap();
            col += 1;
        }
        rg.close().unwrap();
        start = end;
    }
    w.close().unwrap();
    out
}

fn read_i64(r: ColumnReader, n: usize, out: &mut Vec<i64>) {
    out.clear();
    out.reserve(n);
    if let ColumnReader::Int64ColumnReader(mut c) = r {
        while out.len() < n {
            let (got, _, _) = c.read_records(n - out.len(), None, None, out).unwrap();
            if got == 0 { break; }
        }
    }
}
fn read_f64(r: ColumnReader, n: usize, out: &mut Vec<f64>) {
    out.clear();
    out.reserve(n);
    if let ColumnReader::DoubleColumnReader(mut c) = r {
        while out.len() < n {
            let (got, _, _) = c.read_records(n - out.len(), None, None, out).unwrap();
            if got == 0 { break; }
        }
    }
}
fn read_names(r: ColumnReader, n: usize, out: &mut Vec<ByteArray>) {
    out.clear();
    out.reserve(n);
    if let ColumnReader::ByteArrayColumnReader(mut c) = r {
        while out.len() < n {
            let (got, _, _) = c.read_records(n - out.len(), None, None, out).unwrap();
            if got == 0 { break; }
        }
    }
}

/// Add each series' windowed rate into `acc` (one slot per step).
#[inline]
fn eval_series(ts: &[i64], val: &[f64], t0: i64, acc: &mut [f64], cum: &mut Vec<f64>) {
    let n = ts.len();
    if n < 2 { return; }
    cum.clear();
    cum.push(0.0);
    let mut c = 0.0;
    for i in 1..n {
        let d = val[i] - val[i - 1];
        c += if d >= 0.0 { d } else { val[i] };
        cum.push(c);
    }
    let (mut lo, mut hi) = (0usize, 0usize);
    for (k, slot) in acc.iter_mut().enumerate() {
        let t = t0 + k as i64 * STEP_MS;
        while hi < n && ts[hi] <= t { hi += 1; }
        while lo < hi && ts[lo] <= t - WINDOW_MS { lo += 1; }
        if hi >= lo + 2 {
            let dt = (ts[hi - 1] - ts[lo]) as f64;
            if dt > 0.0 { *slot += (cum[hi - 1] - cum[lo]) / dt * 1000.0; }
        }
    }
}

/// sum(rate(metric[5m])) at 60 s steps. `metric` empty = every metric whose name sorts even
/// (the counters in the synthetic data). Returns one f64 per step.
pub fn query(file: Bytes, metric: &[u8], t0: i64, steps: usize) -> Vec<f64> {
    let rdr = SerializedFileReader::new(file).unwrap();
    let mut acc = vec![0.0f64; steps];
    let (mut sid, mut ts, mut val, mut names, mut cum) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for g in 0..rdr.num_row_groups() {
        let rg = rdr.get_row_group(g).unwrap();
        let md = rg.metadata();
        let n = md.num_rows() as usize;
        if !metric.is_empty() {
            if let Some(Statistics::ByteArray(st)) = md.column(0).statistics() {
                if let (Some(mn), Some(mx)) = (st.min_opt(), st.max_opt()) {
                    if metric < mn.data() || metric > mx.data() { continue; }
                }
            }
        }
        read_names(rg.get_column_reader(0).unwrap(), n, &mut names);
        read_i64(rg.get_column_reader(1).unwrap(), n, &mut sid);
        read_i64(rg.get_column_reader(2).unwrap(), n, &mut ts);
        read_f64(rg.get_column_reader(3).unwrap(), n, &mut val);
        let mut i = 0;
        while i < n {
            let mut j = i + 1;
            while j < n && sid[j] == sid[i] && names[j].data().as_ptr() == names[i].data().as_ptr() { j += 1; }
            // run of one (metric, series); fall back to byte compare at run edges
            while j < n && sid[j] == sid[i] && names[j].data() == names[i].data() { j += 1; }
            let nm = names[i].data();
            let keep = if metric.is_empty() { is_counter(nm) } else { nm == metric };
            if keep { eval_series(&ts[i..j], &val[i..j], t0, &mut acc, &mut cum); }
            i = j;
        }
    }
    acc
}

fn is_counter(name: &[u8]) -> bool {
    // app_metric_NN_total: NN even
    name.len() > 12 && (name[12] - b'0') % 2 == 0
}

/// Same query through the Arrow reader, keeping `metric_name` dictionary-encoded so no
/// per-row string is ever built.
#[cfg(feature = "arrow")]
pub fn query_arrow(file: Bytes, metric: &[u8], t0: i64, steps: usize) -> Vec<f64> {
    use arrow_array::{cast::AsArray, types::{Float64Type, Int32Type, Int64Type}, Array};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::arrow_reader::{ArrowReaderOptions, ParquetRecordBatchReaderBuilder};
    let schema = Arc::new(Schema::new(vec![
        Field::new("metric_name", DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8)), false),
        Field::new("series_id", DataType::Int64, false),
        Field::new("ts", DataType::Int64, false),
        Field::new("value", DataType::Float64, false),
    ]));
    let b = ParquetRecordBatchReaderBuilder::try_new_with_options(file, ArrowReaderOptions::new().with_schema(schema)).unwrap();
    let mut groups = Vec::new();
    for (g, md) in b.metadata().row_groups().iter().enumerate() {
        if !metric.is_empty() {
            if let Some(Statistics::ByteArray(st)) = md.column(0).statistics() {
                if let (Some(mn), Some(mx)) = (st.min_opt(), st.max_opt()) {
                    if metric < mn.data() || metric > mx.data() { continue; }
                }
            }
        }
        groups.push(g);
    }
    let rdr = b.with_row_groups(groups).with_batch_size(ROW_GROUP).build().unwrap();
    let mut acc = vec![0.0f64; steps];
    let mut cum = Vec::new();
    for batch in rdr {
        let batch = batch.unwrap();
        let d = batch.column(0).as_dictionary::<Int32Type>();
        let keys = d.keys().values();
        let dict = d.values().as_string::<i32>();
        let keep: Vec<bool> = (0..dict.len()).map(|i| { let nm = dict.value(i).as_bytes(); if metric.is_empty() { is_counter(nm) } else { nm == metric } }).collect();
        let sid = batch.column(1).as_primitive::<Int64Type>().values();
        let ts = batch.column(2).as_primitive::<Int64Type>().values();
        let val = batch.column(3).as_primitive::<Float64Type>().values();
        let n = batch.num_rows();
        let mut i = 0;
        while i < n {
            let (s, k) = (sid[i], keys[i]);
            let mut j = i + 1;
            while j < n && sid[j] == s && keys[j] == k { j += 1; }
            if keep[k as usize] { eval_series(&ts[i..j], &val[i..j], t0, &mut acc, &mut cum); }
            i = j;
        }
    }
    acc
}

/// Tail scan: unsorted, uncompressed columnar batches as a shard would hold them in its
/// write-ahead log. Layout per batch: n:u32, pad:u32, name_idx:[u32;n] (padded to 8),
/// sid:[i64;n], ts:[i64;n], val:[f64;n]. `keep[i]` says whether metric i is selected.
/// No statistics, no pruning: every batch is visited, matching rows are gathered, sorted
/// by (series, time), then evaluated with the same function as the Parquet path.
pub fn tail_query(buf: &[u8], keep: &[u8], t0: i64, steps: usize) -> Vec<f64> {
    let mut rows: Vec<(i64, i64, f64)> = Vec::new();
    let mut o = 0usize;
    let rd64 = |b: &[u8], at: usize| i64::from_le_bytes(b[at..at + 8].try_into().unwrap());
    while o < buf.len() {
        let n = u32::from_le_bytes(buf[o..o + 4].try_into().unwrap()) as usize;
        let idx = o + 8;
        let sid = idx + ((n * 4 + 7) & !7);
        let ts = sid + n * 8;
        let val = ts + n * 8;
        for i in 0..n {
            let m = u32::from_le_bytes(buf[idx + i * 4..idx + i * 4 + 4].try_into().unwrap()) as usize;
            if keep[m] != 0 {
                rows.push((rd64(buf, sid + i * 8), rd64(buf, ts + i * 8), f64::from_bits(rd64(buf, val + i * 8) as u64)));
            }
        }
        o = val + n * 8;
    }
    rows.sort_unstable_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    let mut acc = vec![0.0f64; steps];
    let (mut tsv, mut vv, mut cum) = (Vec::new(), Vec::new(), Vec::new());
    let mut i = 0;
    while i < rows.len() {
        let mut j = i;
        tsv.clear(); vv.clear();
        while j < rows.len() && rows[j].0 == rows[i].0 { tsv.push(rows[j].1); vv.push(rows[j].2); j += 1; }
        eval_series(&tsv, &vv, t0, &mut acc, &mut cum);
        i = j;
    }
    acc
}

// ---- C ABI for the WASM host ----
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(8));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, cap: usize) {
    drop(Vec::from_raw_parts(p, 0, cap.max(8)));
}
static mut OUT: (usize, usize, usize) = (0, 0, 0);
#[no_mangle]
pub extern "C" fn out_ptr() -> usize { unsafe { OUT.0 } }
#[no_mangle]
pub extern "C" fn out_len() -> usize { unsafe { OUT.1 } }
#[no_mangle]
pub unsafe extern "C" fn out_free() {
    if OUT.0 != 0 { drop(Vec::from_raw_parts(OUT.0 as *mut u8, OUT.1, OUT.2)); OUT = (0, 0, 0); }
}
unsafe fn set_out(mut v: Vec<u8>) {
    out_free();
    OUT = (v.as_mut_ptr() as usize, v.len(), v.capacity());
    std::mem::forget(v);
}

/// names: '\n'-joined UTF-8.
#[no_mangle]
pub unsafe extern "C" fn encode_c(names: *const u8, names_len: usize, idx: *const u32, sid: *const i64, ts: *const i64, val: *const f64, n: usize) {
    let names = std::str::from_utf8_unchecked(std::slice::from_raw_parts(names, names_len));
    let names: Vec<&str> = names.split('\n').collect();
    let v = encode(&names, std::slice::from_raw_parts(idx, n), std::slice::from_raw_parts(sid, n), std::slice::from_raw_parts(ts, n), std::slice::from_raw_parts(val, n));
    set_out(v);
}
/// Takes ownership of the file buffer (allocated with `alloc`, capacity == len).
#[no_mangle]
pub unsafe extern "C" fn query_c(file: *mut u8, file_len: usize, metric: *const u8, metric_len: usize, t0: i64, steps: usize) {
    let file = Bytes::from(Vec::from_raw_parts(file, file_len, file_len.max(8)));
    #[cfg(feature = "arrow")]
    let r = query_arrow(file, std::slice::from_raw_parts(metric, metric_len), t0, steps);
    #[cfg(not(feature = "arrow"))]
    let r = query(file, std::slice::from_raw_parts(metric, metric_len), t0, steps);
    let mut r = std::mem::ManuallyDrop::new(r);
    let v = Vec::from_raw_parts(r.as_mut_ptr() as *mut u8, r.len() * 8, r.capacity() * 8);
    set_out(v);
}

#[no_mangle]
pub unsafe extern "C" fn tail_query_c(buf: *const u8, len: usize, keep: *const u8, keep_len: usize, t0: i64, steps: usize) {
    let r = tail_query(std::slice::from_raw_parts(buf, len), std::slice::from_raw_parts(keep, keep_len), t0, steps);
    let mut r = std::mem::ManuallyDrop::new(r);
    let v = Vec::from_raw_parts(r.as_mut_ptr() as *mut u8, r.len() * 8, r.capacity() * 8);
    set_out(v);
}
