//! UTC day arithmetic without a clock or a date library.

pub const MS_PER_DAY: i64 = 86_400_000;

/// Days since 1970-01-01 (UTC) of a Unix-millisecond timestamp. Floors, so negative
/// timestamps land on the correct earlier day.
#[inline]
pub fn day_number(ts_ms: i64) -> i64 {
    ts_ms.div_euclid(MS_PER_DAY)
}

/// `YYYY-MM-DD` for a day number (proleptic Gregorian calendar). Years outside 0..=9999
/// are written with a sign and as many digits as needed; such days do not sort as strings.
pub fn format_day(day: i64) -> String {
    // Howard Hinnant's civil_from_days.
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    if (0..=9999).contains(&y) {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!("{}{:04}-{m:02}-{d:02}", if y < 0 { '-' } else { '+' }, y.abs())
    }
}

/// `YYYY-MM-DD` of a Unix-millisecond timestamp.
pub fn day_string(ts_ms: i64) -> String {
    format_day(day_number(ts_ms))
}
