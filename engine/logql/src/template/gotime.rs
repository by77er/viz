//! Go's reference-time layouts (`2006-01-02T15:04:05Z07:00`), as the `time` package
//! documents them, for the `date`, `toDate` and `toDateInZone` template functions. The
//! engine has no clock and no time-zone database: every time is UTC (`Local` is UTC).

const NS: i128 = 1_000_000_000;
const DAY: i128 = 86_400 * NS;

const MONTHS: [&str; 12] =
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// Days since 1970-01-01 to (year, month 1..=12, day 1..=31).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

struct Parts {
    year: i64,
    month: u32,
    day: u32,
    yday: u32,
    wday: usize,
    hour: u32,
    min: u32,
    sec: u32,
    nanos: u32,
}

fn parts(t: i128) -> Parts {
    let days = t.div_euclid(DAY) as i64;
    let rem = t.rem_euclid(DAY);
    let (year, month, day) = civil_from_days(days);
    let secs = (rem / NS) as u32;
    let yday = (days - days_from_civil(year, 1, 1)) as u32 + 1;
    Parts {
        year,
        month,
        day,
        yday,
        wday: (days + 4).rem_euclid(7) as usize,
        hour: secs / 3600,
        min: secs / 60 % 60,
        sec: secs % 60,
        nanos: (rem % NS) as u32,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Chunk {
    LongMonth,
    Month,
    NumMonth,
    ZeroMonth,
    LongWeekDay,
    WeekDay,
    Day,
    UnderDay,
    ZeroDay,
    UnderYearDay,
    ZeroYearDay,
    Hour,
    Hour12,
    ZeroHour12,
    Minute,
    ZeroMinute,
    Second,
    ZeroSecond,
    LongYear,
    Year,
    PM,
    Pm,
    TzName,
    /// `Z0700` style (`iso` true prints `Z` for UTC), with the number of offset parts.
    Tz { iso: bool, colon: bool, secs: bool, hours_only: bool },
    /// Fractional seconds: number of digits, trailing zeros trimmed (`.999`) or not (`.000`).
    Frac { digits: usize, trim: bool, sep: char },
}

/// Split a layout into literal text and chunks, as Go's documentation describes the
/// reference time's components.
fn chunks(layout: &str) -> Vec<Result<Chunk, String>> {
    let mut out: Vec<Result<Chunk, String>> = Vec::new();
    let mut lit = String::new();
    let mut i = 0;
    let s = layout;
    let push_lit = |lit: &mut String, out: &mut Vec<Result<Chunk, String>>| {
        if !lit.is_empty() {
            out.push(Err(std::mem::take(lit)));
        }
    };
    while i < s.len() {
        let r = &s[i..];
        let table: &[(&str, Chunk)] = &[
            ("January", Chunk::LongMonth),
            ("Jan", Chunk::Month),
            ("Monday", Chunk::LongWeekDay),
            ("Mon", Chunk::WeekDay),
            ("MST", Chunk::TzName),
            ("2006", Chunk::LongYear),
            ("01", Chunk::ZeroMonth),
            ("02", Chunk::ZeroDay),
            ("03", Chunk::ZeroHour12),
            ("04", Chunk::ZeroMinute),
            ("05", Chunk::ZeroSecond),
            ("06", Chunk::Year),
            ("002", Chunk::ZeroYearDay),
            ("__2", Chunk::UnderYearDay),
            ("_2", Chunk::UnderDay),
            ("15", Chunk::Hour),
            ("PM", Chunk::PM),
            ("pm", Chunk::Pm),
            ("Z07:00:00", Chunk::Tz { iso: true, colon: true, secs: true, hours_only: false }),
            ("Z070000", Chunk::Tz { iso: true, colon: false, secs: true, hours_only: false }),
            ("Z07:00", Chunk::Tz { iso: true, colon: true, secs: false, hours_only: false }),
            ("Z0700", Chunk::Tz { iso: true, colon: false, secs: false, hours_only: false }),
            ("Z07", Chunk::Tz { iso: true, colon: false, secs: false, hours_only: true }),
            ("-07:00:00", Chunk::Tz { iso: false, colon: true, secs: true, hours_only: false }),
            ("-070000", Chunk::Tz { iso: false, colon: false, secs: true, hours_only: false }),
            ("-07:00", Chunk::Tz { iso: false, colon: true, secs: false, hours_only: false }),
            ("-0700", Chunk::Tz { iso: false, colon: false, secs: false, hours_only: false }),
            ("-07", Chunk::Tz { iso: false, colon: false, secs: false, hours_only: true }),
        ];
        let mut matched = None;
        for (tok, c) in table {
            if r.starts_with(tok) {
                // `Jan`/`Mon` must not be followed by a lower-case letter (`Janet`).
                if matches!(c, Chunk::Month | Chunk::WeekDay) && r[tok.len()..].starts_with(|ch: char| ch.is_ascii_lowercase()) {
                    continue;
                }
                matched = Some((tok.len(), *c));
                break;
            }
        }
        if matched.is_none() {
            let b = r.as_bytes();
            match b[0] {
                b'1' => matched = Some(if b.get(1) == Some(&b'5') { (2, Chunk::Hour) } else { (1, Chunk::NumMonth) }),
                b'2' => matched = Some((1, Chunk::Day)),
                b'3' => matched = Some((1, Chunk::Hour12)),
                b'4' => matched = Some((1, Chunk::Minute)),
                b'5' => matched = Some((1, Chunk::Second)),
                b'.' | b',' if b.len() > 1 && (b[1] == b'0' || b[1] == b'9') => {
                    let d = b[1];
                    let n = b[1..].iter().take_while(|x| **x == d).count();
                    // Only when not followed by another digit.
                    if !b.get(1 + n).is_some_and(|x| x.is_ascii_digit()) {
                        matched = Some((1 + n, Chunk::Frac { digits: n, trim: d == b'9', sep: b[0] as char }));
                    }
                }
                _ => {}
            }
        }
        match matched {
            Some((len, c)) => {
                push_lit(&mut lit, &mut out);
                out.push(Ok(c));
                i += len;
            }
            None => {
                let ch = r.chars().next().unwrap_or(' ');
                lit.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    push_lit(&mut lit, &mut out);
    out
}

/// `t.Format(layout)` for a UTC time.
pub fn format(t: i128, layout: &str) -> String {
    let p = parts(t);
    let mut out = String::new();
    for c in chunks(layout) {
        let c = match c {
            Err(lit) => {
                out.push_str(&lit);
                continue;
            }
            Ok(c) => c,
        };
        let h12 = if p.hour % 12 == 0 { 12 } else { p.hour % 12 };
        match c {
            Chunk::LongMonth => out.push_str(MONTHS[p.month as usize - 1]),
            Chunk::Month => out.push_str(&MONTHS[p.month as usize - 1][..3]),
            Chunk::NumMonth => out.push_str(&p.month.to_string()),
            Chunk::ZeroMonth => out.push_str(&format!("{:02}", p.month)),
            Chunk::LongWeekDay => out.push_str(DAYS[p.wday]),
            Chunk::WeekDay => out.push_str(&DAYS[p.wday][..3]),
            Chunk::Day => out.push_str(&p.day.to_string()),
            Chunk::UnderDay => out.push_str(&format!("{:>2}", p.day)),
            Chunk::ZeroDay => out.push_str(&format!("{:02}", p.day)),
            Chunk::UnderYearDay => out.push_str(&format!("{:>3}", p.yday)),
            Chunk::ZeroYearDay => out.push_str(&format!("{:03}", p.yday)),
            Chunk::Hour => out.push_str(&format!("{:02}", p.hour)),
            Chunk::Hour12 => out.push_str(&h12.to_string()),
            Chunk::ZeroHour12 => out.push_str(&format!("{h12:02}")),
            Chunk::Minute => out.push_str(&p.min.to_string()),
            Chunk::ZeroMinute => out.push_str(&format!("{:02}", p.min)),
            Chunk::Second => out.push_str(&p.sec.to_string()),
            Chunk::ZeroSecond => out.push_str(&format!("{:02}", p.sec)),
            Chunk::LongYear => out.push_str(&format!("{:04}", p.year)),
            Chunk::Year => out.push_str(&format!("{:02}", p.year.rem_euclid(100))),
            Chunk::PM => out.push_str(if p.hour >= 12 { "PM" } else { "AM" }),
            Chunk::Pm => out.push_str(if p.hour >= 12 { "pm" } else { "am" }),
            Chunk::TzName => out.push_str("UTC"),
            Chunk::Tz { iso, colon, secs, hours_only } => {
                if iso {
                    out.push('Z');
                } else if hours_only {
                    out.push_str("+00");
                } else {
                    out.push_str(if colon { "+00:00" } else { "+0000" });
                    if secs {
                        out.push_str(if colon { ":00" } else { "00" });
                    }
                }
            }
            Chunk::Frac { digits, trim, sep } => {
                let f = format!("{:09}", p.nanos);
                let mut d = f[..digits.min(9)].to_string();
                if trim {
                    d = d.trim_end_matches('0').to_string();
                    if !d.is_empty() {
                        out.push(sep);
                        out.push_str(&d);
                    }
                } else {
                    out.push(sep);
                    out.push_str(&d);
                }
            }
        }
    }
    out
}

/// `t.String()`: `2006-01-02 15:04:05.999999999 -0700 MST`.
pub fn time_string(t: i128) -> String {
    format(t, "2006-01-02 15:04:05.999999999 -0700 MST")
}

/// `time.Parse(layout, value)` (UTC). Returns nanoseconds since the epoch.
pub fn parse(layout: &str, value: &str) -> Result<i128, String> {
    let err = || format!("parsing time {value:?} as {layout:?}: cannot parse");
    let mut v = value;
    let (mut year, mut month, mut day, mut hour, mut min, mut sec, mut nanos) = (1i64, 1u32, 1u32, 0u32, 0u32, 0u32, 0u32);
    let mut pm: Option<bool> = None;
    let mut offset_secs: i64 = 0;
    let mut yday: Option<u32> = None;
    let take_num = |v: &mut &str, min_d: usize, max_d: usize| -> Option<u32> {
        let n = v.bytes().take(max_d).take_while(|b| b.is_ascii_digit()).count();
        if n < min_d {
            return None;
        }
        let r = v[..n].parse().ok();
        *v = &v[n..];
        r
    };
    for c in chunks(layout) {
        match c {
            Err(lit) => {
                v = v.strip_prefix(lit.as_str()).ok_or_else(err)?;
            }
            Ok(c) => match c {
                Chunk::LongYear => {
                    year = take_num(&mut v, 4, 4).ok_or_else(err)? as i64;
                }
                Chunk::Year => {
                    let y = take_num(&mut v, 2, 2).ok_or_else(err)? as i64;
                    year = if y >= 69 { 1900 + y } else { 2000 + y };
                }
                Chunk::LongMonth | Chunk::Month => {
                    let idx = MONTHS
                        .iter()
                        .position(|m| {
                            let name = if c == Chunk::Month { &m[..3] } else { m };
                            v.len() >= name.len() && v[..name.len()].eq_ignore_ascii_case(name)
                        })
                        .ok_or_else(err)?;
                    let len = if c == Chunk::Month { 3 } else { MONTHS[idx].len() };
                    v = &v[len..];
                    month = idx as u32 + 1;
                }
                Chunk::NumMonth | Chunk::ZeroMonth => {
                    month = take_num(&mut v, if c == Chunk::ZeroMonth { 2 } else { 1 }, 2).ok_or_else(err)?;
                    if !(1..=12).contains(&month) {
                        return Err(format!("parsing time {value:?}: month out of range"));
                    }
                }
                Chunk::LongWeekDay | Chunk::WeekDay => {
                    let idx = DAYS
                        .iter()
                        .position(|d| {
                            let name = if c == Chunk::WeekDay { &d[..3] } else { d };
                            v.len() >= name.len() && v[..name.len()].eq_ignore_ascii_case(name)
                        })
                        .ok_or_else(err)?;
                    let len = if c == Chunk::WeekDay { 3 } else { DAYS[idx].len() };
                    v = &v[len..];
                }
                Chunk::Day | Chunk::UnderDay | Chunk::ZeroDay => {
                    if c == Chunk::UnderDay {
                        v = v.strip_prefix(' ').unwrap_or(v);
                    }
                    day = take_num(&mut v, if c == Chunk::ZeroDay { 2 } else { 1 }, 2).ok_or_else(err)?;
                }
                Chunk::UnderYearDay | Chunk::ZeroYearDay => {
                    v = v.trim_start_matches(' ');
                    yday = Some(take_num(&mut v, 3, 3).ok_or_else(err)?);
                }
                Chunk::Hour => hour = take_num(&mut v, 2, 2).ok_or_else(err)?,
                Chunk::Hour12 | Chunk::ZeroHour12 => {
                    hour = take_num(&mut v, if c == Chunk::ZeroHour12 { 2 } else { 1 }, 2).ok_or_else(err)?;
                }
                Chunk::Minute | Chunk::ZeroMinute => {
                    min = take_num(&mut v, if c == Chunk::ZeroMinute { 2 } else { 1 }, 2).ok_or_else(err)?;
                }
                Chunk::Second | Chunk::ZeroSecond => {
                    sec = take_num(&mut v, if c == Chunk::ZeroSecond { 2 } else { 1 }, 2).ok_or_else(err)?;
                    // A fraction may follow a seconds field even if the layout has none.
                    if v.starts_with(['.', ',']) && v[1..].starts_with(|ch: char| ch.is_ascii_digit()) {
                        let n = v[1..].bytes().take_while(|b| b.is_ascii_digit()).count();
                        nanos = frac_nanos(&v[1..1 + n]);
                        v = &v[1 + n..];
                    }
                }
                Chunk::PM | Chunk::Pm => {
                    let w = v.get(..2).ok_or_else(err)?;
                    pm = Some(match w.to_ascii_uppercase().as_str() {
                        "PM" => true,
                        "AM" => false,
                        _ => return Err(err()),
                    });
                    v = &v[2..];
                }
                Chunk::TzName => {
                    let n = v.bytes().take_while(|b| b.is_ascii_uppercase()).count();
                    let name = &v[..n];
                    if name != "UTC" && name != "GMT" && name != "Z" {
                        return Err(format!("time zone {name:?} is not supported (only UTC)"));
                    }
                    v = &v[n..];
                }
                Chunk::Tz { iso, colon, secs, hours_only } => {
                    if iso && v.starts_with('Z') {
                        v = &v[1..];
                        continue;
                    }
                    let sign = match v.as_bytes().first() {
                        Some(b'+') => 1,
                        Some(b'-') => -1,
                        _ => return Err(err()),
                    };
                    v = &v[1..];
                    let h = take_num(&mut v, 2, 2).ok_or_else(err)? as i64;
                    let mut m = 0i64;
                    let mut s = 0i64;
                    if !hours_only {
                        if colon {
                            v = v.strip_prefix(':').ok_or_else(err)?;
                        }
                        m = take_num(&mut v, 2, 2).ok_or_else(err)? as i64;
                        if secs {
                            if colon {
                                v = v.strip_prefix(':').ok_or_else(err)?;
                            }
                            s = take_num(&mut v, 2, 2).ok_or_else(err)? as i64;
                        }
                    }
                    offset_secs = sign * (h * 3600 + m * 60 + s);
                }
                Chunk::Frac { digits, trim, sep } => {
                    if trim {
                        if v.starts_with(sep) {
                            let n = v[1..].bytes().take_while(|b| b.is_ascii_digit()).count();
                            nanos = frac_nanos(&v[1..1 + n]);
                            v = &v[1 + n..];
                        }
                    } else {
                        v = v.strip_prefix(sep).ok_or_else(err)?;
                        let d = v.get(..digits).ok_or_else(err)?;
                        if !d.bytes().all(|b| b.is_ascii_digit()) {
                            return Err(err());
                        }
                        nanos = frac_nanos(d);
                        v = &v[digits..];
                    }
                }
            },
        }
    }
    if !v.is_empty() {
        return Err(format!("parsing time {value:?} as {layout:?}: extra text: {v:?}"));
    }
    if let Some(pm) = pm {
        if hour > 12 {
            return Err(err());
        }
        if pm && hour < 12 {
            hour += 12;
        } else if !pm && hour == 12 {
            hour = 0;
        }
    }
    if hour > 23 || min > 59 || sec > 59 {
        return Err(format!("parsing time {value:?}: value out of range"));
    }
    let days = match yday {
        Some(yd) => days_from_civil(year, 1, 1) + yd as i64 - 1,
        None => {
            let dim = days_in_month(year, month);
            if day < 1 || day > dim {
                return Err(format!("parsing time {value:?}: day out of range"));
            }
            days_from_civil(year, month, day)
        }
    };
    let secs = days as i128 * 86_400 + (hour * 3600 + min * 60 + sec) as i128 - offset_secs as i128;
    Ok(secs * NS + nanos as i128)
}

fn frac_nanos(d: &str) -> u32 {
    let mut s = d.chars().take(9).collect::<String>();
    while s.len() < 9 {
        s.push('0');
    }
    s.parse().unwrap_or(0)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_reference_layouts() {
        let t = 1_636_934_400_123_456_789i128; // 2021-11-15T00:00:00.123456789Z (a Monday)
        assert_eq!(format(t, "2006-01-02"), "2021-11-15");
        assert_eq!(format(t, "2006-01-02T15:04:05.00Z07:00"), "2021-11-15T00:00:00.12Z");
        assert_eq!(format(t, "Mon Jan _2 3:04PM"), "Mon Nov 15 12:00AM");
        assert_eq!(time_string(t), "2021-11-15 00:00:00.123456789 +0000 UTC");
        assert_eq!(time_string(1_636_934_400_000_000_000), "2021-11-15 00:00:00 +0000 UTC");
    }

    #[test]
    fn parses_reference_layouts() {
        assert_eq!(parse("2006-01-02", "2021-11-02").unwrap(), 1_635_811_200 * NS);
        assert_eq!(parse("2006-01-02T15:04:05.999999999Z07:00", "2021-11-02T01:02:03.5+01:00").unwrap(), (1_635_811_200 + 3723 - 3600) * NS + 500_000_000);
        assert!(parse("2006-01-02", "2021-13-02").is_err());
        assert!(parse("2006-01-02", "2021-11-02x").is_err());
    }
}
