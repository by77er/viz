//! `web-time` without the web: the same names, straight from `std::time`.
//!
//! The real crate reads the clock through `js-sys`/`wasm-bindgen` on
//! `wasm32-unknown-unknown`, which gives a module imports that only wasm-bindgen's
//! generated JavaScript can satisfy. `lrpar` uses `web_time::Instant` only to time its
//! error recovery, and `promql-parser` builds its parser with `RecoveryKind::None`, which
//! returns before any clock is read (lrpar 0.14.2 `parser.rs`, the `recoverer.is_none()`
//! branch). So the clock is never called. If it ever were, `std::time::Instant::now()`
//! panics on this target ("time not implemented on this platform"), which under
//! `panic = "abort"` is a trap, not a wrong answer; `tools/wasm_check.mjs` exercises
//! parse errors to show it does not happen.
pub use std::time::{Duration, Instant, SystemTime, SystemTimeError, TryFromFloatSecsError, UNIX_EPOCH};
