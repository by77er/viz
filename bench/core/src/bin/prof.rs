use bytes::Bytes;
use parquet::column::reader::ColumnReader;
use parquet::file::reader::{FileReader, SerializedFileReader};
use std::time::Instant;
fn main() {
    let f = Bytes::from(std::fs::read("data/rust.parquet").unwrap());
    for col in 0..4 {
        let mut best = f64::MAX;
        for _ in 0..5 {
            let s = Instant::now();
            let r = SerializedFileReader::new(f.clone()).unwrap();
            let mut total = 0usize;
            for g in 0..r.num_row_groups() {
                let rg = r.get_row_group(g).unwrap();
                let n = rg.metadata().num_rows() as usize;
                match rg.get_column_reader(col).unwrap() {
                    ColumnReader::ByteArrayColumnReader(mut c) => { let mut v = Vec::with_capacity(n); while v.len() < n { if c.read_records(n - v.len(), None, None, &mut v).unwrap().0 == 0 { break } } total += v.len(); }
                    ColumnReader::Int64ColumnReader(mut c) => { let mut v = Vec::with_capacity(n); while v.len() < n { if c.read_records(n - v.len(), None, None, &mut v).unwrap().0 == 0 { break } } total += v.len(); }
                    ColumnReader::DoubleColumnReader(mut c) => { let mut v = Vec::with_capacity(n); while v.len() < n { if c.read_records(n - v.len(), None, None, &mut v).unwrap().0 == 0 { break } } total += v.len(); }
                    _ => {}
                }
            }
            assert_eq!(total, 1_920_000);
            best = best.min(s.elapsed().as_secs_f64() * 1e3);
        }
        println!("rust-native col {col} {best:.1} ms");
    }
}
