//! Query shapes that repeat one construct `n` times, for the nesting limits
//! (`tests/limits.rs`; `tools/wasm-probe/check.mjs` builds the same strings).
//!
//! Every shape is a valid query over spans that carry the integer attribute `a = 1`, so a
//! query under the limit runs through evaluation, not only the parser.

pub struct Shape {
    pub name: &'static str,
    pub make: fn(usize) -> String,
    /// The largest `n` accepted, which pins how levels are counted (`MAX_DEPTH` is 100). For
    /// example `{ (((.a = 1))) }` uses 3 levels for the pipeline, the spanset expression and
    /// the filter, and 2 per parenthesis, so 48 parentheses fit; `{ .a = 1 && .a = 1 ... }`
    /// builds a tree 3 + n high (the filter, the comparison and its leaf, one per `&&`), so
    /// 97 operators fit.
    pub max: usize,
}

fn rep(s: &str, n: usize) -> String {
    s.repeat(n)
}

/// Shapes whose depth grows with `n` and which must be refused past `max`.
pub const NESTED: &[Shape] = &[
    Shape { name: "field parentheses", make: |n| format!("{{ {}.a = 1{} }}", rep("(", n), rep(")", n)), max: 48 },
    Shape { name: "field !", make: |n| format!("{{ {}(.a = 1) }}", rep("!", n)), max: 95 },
    Shape { name: "field unary minus", make: |n| format!("{{ {}.a != 0 }}", rep("- ", n)), max: 97 },
    Shape { name: "field && chain", make: |n| format!("{{ .a = 1{} }}", rep(" && .a = 1", n)), max: 97 },
    Shape { name: "field || chain", make: |n| format!("{{ .a = 0{} }}", rep(" || .a = 1", n)), max: 97 },
    Shape { name: "field + chain", make: |n| format!("{{ .a{} > 0 }}", rep(" + .a", n)), max: 97 },
    Shape { name: "field * chain", make: |n| format!("{{ .a{} = 1 }}", rep(" * .a", n)), max: 97 },
    Shape { name: "field ^ chain", make: |n| format!("{{ .a{} = 1 }}", rep(" ^ 1", n)), max: 97 },
    Shape { name: "field comparison chain", make: |n| format!("{{ .a = 1{} }}", rep(" = true", n)), max: 97 },
    Shape { name: "spanset parentheses", make: |n| format!("{}{{ .a = 1 }}{}", rep("(", n), rep(")", n)), max: 48 },
    Shape { name: "spanset && chain", make: |n| format!("{{ .a = 1 }}{}", rep(" && { .a = 1 }", n)), max: 97 },
    Shape { name: "spanset || chain", make: |n| format!("{{ .a = 0 }}{}", rep(" || { .a = 1 }", n)), max: 97 },
    Shape { name: "structural >> chain", make: |n| format!("{{ }}{}", rep(" >> { }", n)), max: 98 },
    Shape { name: "nested structural >", make: |n| format!("{}{{ }}{}", rep("{ } > (", n), rep(")", n)), max: 32 },
    Shape { name: "nested pipelines", make: |n| format!("{}{{ }}{}", rep("({ } | ", n), rep(")", n)), max: 49 },
    Shape { name: "metrics unary minus", make: |n| format!("rate() + {}1", rep("- ", n)), max: 98 },
    Shape { name: "metrics + chain", make: |n| format!("rate(){}", rep(" + rate()", n)), max: 99 },
    Shape { name: "metrics parentheses", make: |n| format!("{}{{ }} | rate(){}", rep("(", n), rep(")", n)), max: 49 },
    Shape { name: "metrics threshold", make: |n| format!("{{ }} | rate() > 0{}", rep(" + 0", n)), max: 97 },
    Shape { name: "scalar filter constant", make: |n| format!("{{ }} | count() > 0{}", rep(" + 0", n)), max: 97 },
    Shape { name: "aggregate argument", make: |n| format!("{{ }} | avg(.a{}) > 0", rep(" + .a", n)), max: 96 },
    Shape { name: "by() argument", make: |n| format!("{{ }} | by(.a{})", rep(" + .a", n)), max: 97 },
    Shape { name: "metrics argument", make: |n| format!("{{ }} | sum_over_time(.a{})", rep(" + .a", n)), max: 97 },
    Shape {
        name: "regex in field parentheses",
        // 63 groups and the repetition `.*` inside: REGEX_NEST_LIMIT (64) levels.
        make: |n| format!("{{ {}name =~ \"{}.*{}\"{} }}", rep("(", n), rep("(", 63), rep(")", 63), rep(")", n)),
        max: 48,
    },
    Shape { name: "metrics by() argument", make: |n| format!("{{ }} | rate() by (.a{})", rep(" + .a", n)), max: 97 },
];

/// Shapes that repeat without nesting: long, but never deep, so never refused for depth.
pub const FLAT: &[Shape] = &[
    Shape { name: "pipeline stages", make: |n| format!("{{ }}{}", rep(" | { }", n)), max: usize::MAX },
    Shape { name: "second stages", make: |n| format!("{{ }} | rate(){}", rep(" | topk(1)", n)), max: usize::MAX },
    Shape { name: "metrics by() list", make: |n| format!("{{ }} | rate() by (.a{})", rep(", .a", n)), max: usize::MAX },
    Shape { name: "quantiles", make: |n| format!("{{ }} | quantile_over_time(duration{})", rep(", 0.5", n)), max: usize::MAX },
    Shape {
        name: "hints",
        make: |n| format!("{{ }} with (h0 = 1{})", (1..=n).map(|i| format!(", h{i} = 1")).collect::<String>()),
        max: usize::MAX,
    },
];

/// The largest `n` for which `make(n)` stays within `MAX_QUERY_BYTES` (128 KiB).
pub fn fill(make: fn(usize) -> String, max_bytes: usize) -> usize {
    let (mut lo, mut hi) = (1usize, max_bytes);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if make(mid).len() <= max_bytes {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}
