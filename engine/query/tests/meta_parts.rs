//! The metadata calls over parts (query/ "label endpoints over leaves"): for random histories
//! placed anywhere between lake and tail, and any number of parts, the parts' listings union
//! to the whole listing and their counts of series listed add up to the whole's. A part never
//! lists a series of another part (the parts are disjoint).
mod common;

use common::*;
use proptest::prelude::*;
use std::collections::BTreeSet;
use viz_query::{Limits, MetaPart, Matcher};

fn m(name: &str, op: viz_query::MatchOp, value: &str) -> Matcher {
    Matcher { name: name.into(), op, value: value.into() }
}

fn sets() -> Vec<Vec<Matcher>> {
    use viz_query::MatchOp::*;
    vec![
        vec![],
        vec![m("__name__", Eq, "n")],
        vec![m("job", Eq, "x")],
        vec![m("__name__", Re, "m|h_bucket"), m("job", Ne, "y")],
        vec![m("inst", Eq, "")],
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(64), failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn parts_union_to_the_whole_and_their_counts_add_up(
        h in history_strategy(),
        layout in layout_strategy(),
        parts in 1u32..9,
        lo in (T0 - 60_000)..(T0 + 600_000),
        span in 0i64..900_000,
    ) {
        let stored = store(&h.encoded(), &layout);
        let input = stored.input();
        let hi = lo + span;
        let big = Limits::default();
        for set in sets() {
            for name in ["job", "inst", "le", "__name__", "nope"] {
                let (whole, ids) = viz_query::label_values_part(&input, name, &set, lo, hi, &big, None).unwrap();
                let n = ids.len();
                prop_assert_eq!(&whole, &viz_query::label_values_with(&input, name, &set, lo, hi, &big).unwrap());
                let mut union = BTreeSet::new();
                let mut sum = 0;
                let mut all_ids = Vec::new();
                for part in 0..parts {
                    let (v, c) = viz_query::label_values_part(&input, name, &set, lo, hi, &big, Some(MetaPart { part, parts })).unwrap();
                    union.extend(v);
                    sum += c.len();
                    all_ids.extend(c);
                }
                prop_assert_eq!(union.into_iter().collect::<Vec<_>>(), whole);
                prop_assert_eq!(sum, n);
                // The ids: one per series listed, the same series as the whole's.
                let (mut a, mut b) = (all_ids, ids);
                a.sort_unstable();
                b.sort_unstable();
                prop_assert_eq!(a, b);
            }
            let (whole, ids) = viz_query::label_names_part(&input, &set, lo, hi, &big, None).unwrap();
            let n = ids.len();
            let mut union = BTreeSet::new();
            let mut sum = 0;
            for part in 0..parts {
                let (v, c) = viz_query::label_names_part(&input, &set, lo, hi, &big, Some(MetaPart { part, parts })).unwrap();
                union.extend(v);
                sum += c.len();
            }
            prop_assert_eq!(union.into_iter().collect::<Vec<_>>(), whole);
            prop_assert_eq!(sum, n);
            if set.is_empty() {
                continue; // `/series` needs a selective set
            }
            // A set that is not selective (`{inst=""}`) is refused, whole and in every part.
            let Ok((whole, ids)) = viz_query::series_part(&input, std::slice::from_ref(&set), lo, hi, &big, None) else {
                for part in 0..parts {
                    let p = Some(MetaPart { part, parts });
                    let refused = viz_query::series_part(&input, std::slice::from_ref(&set), lo, hi, &big, p).is_err();
                    prop_assert!(refused);
                }
                continue;
            };
            prop_assert_eq!(ids.len(), whole.len());
            let mut all = Vec::new();
            for part in 0..parts {
                let (v, c) = viz_query::series_part(&input, std::slice::from_ref(&set), lo, hi, &big, Some(MetaPart { part, parts })).unwrap();
                prop_assert_eq!(c.len(), v.len());
                all.extend(v);
            }
            let before = all.len();
            all.sort();
            all.dedup();
            // Disjoint: no series is listed by two parts.
            prop_assert_eq!(all.len(), before);
            prop_assert_eq!(all, whole);
        }
    }
}

/// A part's own cap: `max_series` bounds each part's count, and the parts' counts are what the
/// coordinator sums against the whole's cap.
#[test]
fn a_part_is_refused_by_its_own_cap_and_counts_only_its_series() {
    let h = History::from_rows(&[
        (&[("__name__", "a"), ("i", "1")], T0, 1.0),
        (&[("__name__", "a"), ("i", "2")], T0, 1.0),
        (&[("__name__", "a"), ("i", "3")], T0, 1.0),
        (&[("__name__", "a"), ("i", "4")], T0, 1.0),
    ]);
    for layout in [Layout::all_lake(1), Layout::all_tail()] {
        let stored = store(&h.encoded(), &layout);
        let input = stored.input();
        let one = Limits { max_series: 1, ..Limits::default() };
        assert!(viz_query::label_values_part(&input, "i", &[], T0, T0, &one, None).is_err());
        let counts: Vec<usize> = (0..8).map(|part| viz_query::label_values_part(&input, "i", &[], T0, T0, &Limits::default(), Some(MetaPart { part, parts: 8 })).unwrap().1.len()).collect();
        assert_eq!(counts.iter().sum::<usize>(), 4);
        // A part with two or more of the four series is refused by a cap of one.
        for (part, c) in counts.iter().enumerate() {
            let r = viz_query::label_values_part(&input, "i", &[], T0, T0, &one, Some(MetaPart { part: part as u32, parts: 8 }));
            assert_eq!(r.is_err(), *c > 1, "part {part} holds {c}");
        }
    }
}
