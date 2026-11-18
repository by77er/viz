//! The C ABI exercised natively: the same functions the WASM module exports, called with
//! real pointers. (The TypeScript binding is tested in workerd, in `test/`.)
use viz_engine::{viz_abi_version, viz_alloc, viz_encode_segment, viz_free, viz_select};
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
    assert_eq!(viz_abi_version(), 1);
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
