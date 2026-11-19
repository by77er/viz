use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
struct Counting;
static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { let p = System.alloc(l); let n = NOW.fetch_add(l.size(), Relaxed) + l.size(); PEAK.fetch_max(n, Relaxed); p }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { System.dealloc(p, l); NOW.fetch_sub(l.size(), Relaxed); }
}
#[global_allocator]
static A: Counting = Counting;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::reader::RowIter;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "merge" {
        let table = match args[2].as_str() { "spans" => viz_storage::SignalTable::Spans, "trace_index" => viz_storage::SignalTable::TraceIndex, _ => viz_storage::SignalTable::Logs };
        let ins: Vec<bytes::Bytes> = args[4..].iter().map(|p| bytes::Bytes::from(std::fs::read(p).unwrap())).collect();
        let cap: usize = args[3].parse().unwrap();
        let o = viz_storage::SignalMergeOptions { write: viz_storage::SignalWriteOptions { max_row_group_bytes: cap, ..Default::default() }, ..Default::default() };
        let base = NOW.load(Relaxed); PEAK.store(base, Relaxed);
        let out = viz_storage::merge_signal_files_shared(table, &ins, &o).unwrap();
        println!("merge {} inputs: peak {:.2} MB (without the inputs), out {:.2} MB", ins.len(), (PEAK.load(Relaxed) - base) as f64 / 1048576.0, out.bytes.len() as f64 / 1048576.0);
        return;
    }
    let path = std::env::args().nth(1).unwrap();
    let b = bytes::Bytes::from(std::fs::read(&path).unwrap());
    let base = NOW.load(Relaxed); PEAK.store(base, Relaxed);
    let r = SerializedFileReader::new(b.clone()).unwrap();
    println!("open: {:.2} MB", (PEAK.load(Relaxed) - base) as f64 / 1048576.0);
    let base = NOW.load(Relaxed); PEAK.store(base, Relaxed);
    let mut it = RowIter::from_file_into(Box::new(r));
    let first = it.next();
    println!("first row: {:.2} MB", (PEAK.load(Relaxed) - base) as f64 / 1048576.0);
    let mut n = 0; for x in it { x.unwrap(); n += 1; }
    println!("all {} rows: peak {:.2} MB, file {:.2} MB {}", n + first.is_some() as usize, (PEAK.load(Relaxed) - base) as f64 / 1048576.0, b.len() as f64 / 1048576.0, path);
}
#[allow(dead_code)]
fn unused() {}
