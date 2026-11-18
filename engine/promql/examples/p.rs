fn main(){ for q in std::env::args().skip(1) { match promql_parser::parser::parse(&q) { Ok(e)=>println!("{q}\n  => {e:?}\n"), Err(e)=>println!("{q}\n  ERR {e}\n") } } }
