# Dependency patches for a glue-free WASM module

`viz-promql` parses with `promql-parser`, and two of its dependencies bind to JavaScript
on `wasm32-unknown-unknown`:

| Dependency path | What it links | Why a feature flag cannot remove it |
|---|---|---|
| `promql-parser` → `chrono` (default features, which include `wasmbind`) → `js-sys`, `wasm-bindgen` | JavaScript `Date` for `Utc::now()` and `Local` | A crate cannot turn off the default features of a dependency's dependency, and features are unified, so `parquet`'s `chrono` (no default features) gets them too. |
| `promql-parser` → `lrpar` → `web-time` → `js-sys`, `wasm-bindgen` | `performance.now()` for the error-recovery time budget | `lrpar` depends on `web-time` unconditionally. |

Linked as is, the whole engine has 7 imports (`__wbindgen_placeholder__.*`,
`__wbindgen_externref_xform__.*`) and 1,544 `__wbindgen_describe_*` exports,
and can only be loaded after the `wasm-bindgen` CLI has rewritten it and generated a
JavaScript wrapper.

The engine never reads a clock. So the three crates here replace the bindings, through
`[patch.crates-io]`:

- `web-time`: re-exports `std::time` (one `pub use`). `lrpar` reads the clock only inside
  error recovery, and `promql-parser` builds its parser with `RecoveryKind::None`, which
  returns before that.
- `js-sys`: the five `Date` functions `chrono` 0.4.45 names, each a trap.
- `wasm-bindgen`: `JsValue::from_f64`, the one item `chrono` names.

No third-party source is copied or modified. If an upgrade of `chrono` or `lrpar` uses
something else from these crates, the build fails; it cannot silently bring the imports
back, because the real crates are no longer in the graph.

## Using them

`[patch]` only takes effect in the package being built, so every crate that links
`viz-promql` into a `.wasm` adds:

```toml
[patch.crates-io]
web-time = { path = "../query/patches/web-time" }
js-sys = { path = "../query/patches/js-sys" }
wasm-bindgen = { path = "../query/patches/wasm-bindgen" }
```

`../wasm` does, and `../tools/wasm_check.mjs` proves the result: zero imports,
instantiated with an empty import object, queries run.

Native builds are unaffected with or without the patch: `chrono` and `web-time` only
use these crates on `wasm32`.

## What would make this unnecessary

- `promql-parser` declaring `chrono = { default-features = false, features = ["std"] }`.
- `lrpar` making `web-time` optional, or using it only when recovery is enabled.
