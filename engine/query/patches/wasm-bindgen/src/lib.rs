//! Stand-in for `wasm-bindgen`: the one item `chrono` 0.4.45 names. See `../js-sys`.
//! Nothing here binds to JavaScript, so nothing here adds an import to the module.

/// An opaque JavaScript value. Only ever passed to `js_sys::Date::new`, which traps.
pub struct JsValue(());

impl JsValue {
    pub fn from_f64(_n: f64) -> JsValue {
        JsValue(())
    }
}
