//! Stand-in for `js-sys`, exactly as large as `chrono` 0.4.45 needs it to be.
//!
//! `chrono`'s default feature `wasmbind` makes `Utc::now()` and `Local` ask JavaScript's
//! `Date` on `wasm32-unknown-unknown`. `promql-parser` depends on `chrono` with default
//! features, and a downstream crate cannot switch them off. The viz engine never asks
//! for the time or the local time zone (engine/AGENTS.md: no clock), so these functions
//! are unreachable; they exist so that `chrono` compiles without linking the real
//! `js-sys`, whose bindings give the module imports that need generated JavaScript.
//!
//! Each function traps (a panic, which is an abort in the WASM build) rather than
//! return a made-up time. If a `chrono` upgrade starts using another `js_sys` item, the
//! build fails here, loudly.
use wasm_bindgen::JsValue;

fn no_clock() -> ! {
    panic!("the viz engine has no clock: js_sys::Date is not available")
}

/// JavaScript's `Date`. Cannot be constructed.
pub struct Date(());

impl Date {
    pub fn new_0() -> Date {
        no_clock()
    }
    pub fn new(_millis: &JsValue) -> Date {
        no_clock()
    }
    pub fn new_with_year_month_day_hr_min_sec(_year: u32, _month: i32, _day: i32, _hr: i32, _min: i32, _sec: i32) -> Date {
        no_clock()
    }
    pub fn get_time(&self) -> f64 {
        no_clock()
    }
    pub fn get_timezone_offset(&self) -> f64 {
        no_clock()
    }
}
