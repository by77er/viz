//! The C ABI exercised natively: the same functions the WASM module exports, called with
//! real pointers. (The TypeScript binding is tested in workerd, in `test/`.)
use viz_engine::{viz_abi_version, viz_alloc, viz_encode_segment, viz_free, viz_free_file, viz_merge_files, viz_select};
use viz_storage::batch::{encode, Row, SeriesDef, STALE_NAN_BITS};

const T: i64 = 1_700_000_000_000;

fn call(f: unsafe extern "C" fn(*const u8, usize) -> *mut u8, req: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let p = viz_alloc(req.len());
        std::ptr::copy_nonoverlapping(req.as_ptr(), p, req.len());
        let r = f(p, req.len());
        viz_free(p, req.len());
        let total = u32::from_le_bytes(std::slice::from_raw_parts(r, 4).try_into().unwrap()) as usize;
        let all = std::slice::from_raw_parts(r, total).to_vec();
        viz_free(r, total);
        let status = u32::from_le_bytes(all[4..8].try_into().unwrap());
        if status == 0 { Ok(all[8..].to_vec()) } else { Err(String::from_utf8(all[8..].to_vec()).unwrap()) }
    }
}

struct Rd<'a>(&'a [u8], usize);
impl<'a> Rd<'a> {
    fn u32(&mut self) -> u32 {
        self.1 += 4;
        u32::from_le_bytes(self.0[self.1 - 4..self.1].try_into().unwrap())
    }
    fn u64(&mut self) -> u64 {
        self.1 += 8;
        u64::from_le_bytes(self.0[self.1 - 8..self.1].try_into().unwrap())
    }
    fn bytes(&mut self) -> &'a [u8] {
        let n = self.u32() as usize;
        self.1 += n;
        &self.0[self.1 - n..self.1]
    }
}

fn batch() -> Vec<u8> {
    let s = vec![SeriesDef::new([("__name__", "up"), ("job", "a")]), SeriesDef::new([("__name__", "up"), ("job", "b")])];
    let rows = vec![Row::new(0, T, 1.0), Row { series_idx: 1, ts: T + 1, value_bits: STALE_NAN_BITS }, Row::new(0, T + 2, 3.0)];
    encode(&s, &rows).unwrap()
}

fn encode_req(batches: &[&[u8]]) -> Vec<u8> {
    let mut r = (batches.len() as u32).to_le_bytes().to_vec();
    for b in batches {
        r.extend_from_slice(&(b.len() as u32).to_le_bytes());
        r.extend_from_slice(b);
    }
    r
}

#[test]
fn encode_then_select_through_the_abi() {
    assert_eq!(viz_abi_version(), 2);
    let b = batch();
    let out = call(viz_encode_segment, &encode_req(&[&b])).unwrap();
    let native = viz_storage::encode_segment(&[&b]).unwrap();
    let mut r = Rd(&out, 0);
    assert_eq!(r.u32(), 2);
    let mut files = Vec::new();
    for f in &native {
        let table = r.u32();
        assert_eq!(table, matches!(f.table, viz_storage::Table::MetricSeries) as u32);
        assert_eq!(r.u64(), f.rows);
        assert_eq!(r.u64() as i64, f.min_ts);
        assert_eq!(r.u64() as i64, f.max_ts);
        assert_eq!(r.bytes(), f.day.as_bytes());
        assert_eq!(r.bytes(), f.index.as_bytes());
        let bytes = r.bytes();
        assert_eq!(bytes, f.bytes.as_slice());
        files.push(bytes.to_vec());
    }
    assert_eq!(r.1, out.len());

    // select job="b" over lake + the same batch as tail.
    let mut q = Vec::new();
    q.extend_from_slice(&0i64.to_le_bytes());
    q.extend_from_slice(&i64::MAX.to_le_bytes());
    for n in [1u32, 1, 1, 1] {
        q.extend_from_slice(&n.to_le_bytes());
    }
    for part in [&files[1], &files[0], &b] {
        q.extend_from_slice(&(part.len() as u32).to_le_bytes());
        q.extend_from_slice(part);
    }
    q.push(0);
    for part in ["job", "b"] {
        q.extend_from_slice(&(part.len() as u32).to_le_bytes());
        q.extend_from_slice(part.as_bytes());
    }
    let out = call(viz_select, &q).unwrap();
    let mut r = Rd(&out, 0);
    assert_eq!(r.u32(), 1);
    assert_eq!(r.u32(), 2);
    assert_eq!((r.bytes(), r.bytes()), (&b"__name__"[..], &b"up"[..]));
    assert_eq!((r.bytes(), r.bytes()), (&b"job"[..], &b"b"[..]));
    assert_eq!(r.u32(), 1);
    r.1 = r.1.div_ceil(8) * 8;
    assert_eq!(f64::from_bits(r.u64()), (T + 1) as f64);
    assert_eq!(r.u64(), STALE_NAN_BITS);
    assert_eq!(r.1, out.len());
}

#[test]
fn malformed_requests_are_errors_not_traps() {
    let b = batch();
    let good = encode_req(&[&b]);
    for n in 0..good.len() {
        assert!(call(viz_encode_segment, &good[..n]).is_err(), "prefix {n}");
    }
    let mut trailing = good.clone();
    trailing.push(0);
    assert!(call(viz_encode_segment, &trailing).unwrap_err().contains("trailing"));
    // A huge count in a tiny request must not allocate.
    assert!(call(viz_encode_segment, &u32::MAX.to_le_bytes()).unwrap_err().contains("truncated"));
    assert!(call(viz_select, &[0u8; 31]).unwrap_err().contains("truncated"));
    let mut q = vec![0u8; 16];
    for n in [0u32, 0, 0, u32::MAX] {
        q.extend_from_slice(&n.to_le_bytes());
    }
    assert!(call(viz_select, &q).unwrap_err().contains("truncated"));
    // Bad matcher op, bad regex, bad batch: all messages.
    let mut q = vec![0u8; 16];
    for n in [0u32, 0, 0, 1] {
        q.extend_from_slice(&n.to_le_bytes());
    }
    let mut bad_op = q.clone();
    bad_op.extend_from_slice(&[9, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert!(call(viz_select, &bad_op).unwrap_err().contains("unknown matcher op"));
    let mut bad_re = q.clone();
    bad_re.extend_from_slice(&[2, 1, 0, 0, 0, b'a', 1, 0, 0, 0, b'(']);
    assert!(call(viz_select, &bad_re).unwrap_err().contains("matcher"));
    assert!(call(viz_encode_segment, &encode_req(&[b"nope"])).unwrap_err().contains("batch 0"));
    // An empty request list is fine.
    assert_eq!(call(viz_encode_segment, &encode_req(&[])).unwrap(), 0u32.to_le_bytes());
}

fn merge_req(table: u8, inputs: &[&[u8]]) -> Vec<u8> {
    let mut r = vec![table, 0, 0, 0];
    r.extend_from_slice(&(inputs.len() as u32).to_le_bytes());
    for b in inputs {
        r.extend_from_slice(&(b.len() as u32).to_le_bytes());
        r.extend_from_slice(b);
    }
    r
}

/// Parse a merge payload and take the file out of the module's memory, releasing it:
/// (table, rows, min_ts, max_ts, day, index, bytes).
fn file(r: &mut Rd<'_>) -> (u32, u64, u64, u64, Vec<u8>, Vec<u8>, Vec<u8>) {
    let (table, rows, min_ts, max_ts, day, index) = (r.u32(), r.u64(), r.u64(), r.u64(), r.bytes().to_vec(), r.bytes().to_vec());
    // Natively a pointer does not fit the payload's u32: the test reads it back as usize.
    let (ptr, len, cap) = (r.usize(), r.usize(), r.usize());
    let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, len).to_vec() };
    unsafe { viz_free_file(ptr as *mut u8, cap) };
    (table, rows, min_ts, max_ts, day, index, bytes)
}

#[test]
fn merge_through_the_abi_equals_the_library() {
    // Two segments that overlap: the second repeats (series 0, T) with another value.
    let a = batch();
    let s = vec![SeriesDef::new([("__name__", "up"), ("job", "a")]), SeriesDef::new([("__name__", "zz"), ("job", "c")])];
    let b = encode(&s, &[Row::new(0, T, 9.0), Row::new(1, T + 5, 4.0)]).unwrap();
    let fa = viz_storage::encode_segment(&[&a]).unwrap();
    let fb = viz_storage::encode_segment(&[&b]).unwrap();
    for (t, table) in [(0usize, viz_storage::Table::MetricSamples), (1, viz_storage::Table::MetricSeries)] {
        let inputs: [&[u8]; 2] = [&fa[t].bytes, &fb[t].bytes];
        let native = viz_storage::merge_files(table, &inputs).unwrap();
        let out = call(viz_merge_files, &merge_req(t as u8, &inputs)).unwrap();
        let mut r = Rd(&out, 0);
        let (tb, rows, min_ts, max_ts, day, index, bytes) = file(&mut r);
        assert_eq!(r.1, out.len(), "nothing after the one file");
        assert_eq!(tb, t as u32);
        assert_eq!(rows, native.rows);
        assert_eq!((min_ts as i64, max_ts as i64), (native.min_ts, native.max_ts));
        assert_eq!(day, native.day.as_bytes());
        assert_eq!(index, native.index.as_bytes());
        assert_eq!(bytes, native.bytes);
    }
    // 3 + 2 rows with one duplicate key: 4 samples; 2 + 2 series with one shared: 3 series.
    let merged = call(viz_merge_files, &merge_req(0, &[&fa[0].bytes, &fb[0].bytes])).unwrap();
    assert_eq!(file(&mut Rd(&merged, 0)).1, 4);
    let merged = call(viz_merge_files, &merge_req(1, &[&fa[1].bytes, &fb[1].bytes])).unwrap();
    assert_eq!(file(&mut Rd(&merged, 0)).1, 3);
}

#[test]
fn merge_refuses_malformed_requests_without_trapping() {
    let a = batch();
    let fa = viz_storage::encode_segment(&[&a]).unwrap();
    let good = merge_req(0, &[&fa[0].bytes, &fa[0].bytes]);
    assert!(call(viz_merge_files, &good).is_ok());
    for cut in 0..good.len() {
        assert!(call(viz_merge_files, &good[..cut]).is_err(), "prefix of {cut} bytes");
    }
    let mut trailing = good.clone();
    trailing.push(0);
    assert!(call(viz_merge_files, &trailing).unwrap_err().contains("trailing"));
    // An unknown table, non-zero padding, a series file passed as samples, no inputs, a huge count.
    assert!(call(viz_merge_files, &merge_req(2, &[&fa[0].bytes])).unwrap_err().contains("unknown table"));
    let mut pad = good.clone();
    pad[2] = 1;
    assert!(call(viz_merge_files, &pad).unwrap_err().contains("unknown table"));
    assert!(call(viz_merge_files, &merge_req(0, &[&fa[1].bytes])).is_err());
    assert!(call(viz_merge_files, &merge_req(0, &[])).is_err());
    assert!(call(viz_merge_files, &merge_req(0, &[b"not parquet"])).is_err());
    let mut huge = vec![0u8, 0, 0, 0];
    huge.extend_from_slice(&u32::MAX.to_le_bytes());
    assert!(call(viz_merge_files, &huge).is_err());
}
