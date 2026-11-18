//! Numeric kernels, ported from the behaviour of the Prometheus reference
//! implementation (`promql/functions.go`, `promql/quantile.go`).

/// One evaluation window of a range vector for a single series.
pub(crate) struct Window<'a> {
    pub ts: &'a [i64],
    pub vals: &'a [f64],
    /// Exclusive left edge of the window, ms.
    pub range_start: i64,
    /// Inclusive right edge of the window, ms.
    pub range_end: i64,
    /// Evaluation timestamp of the step, ms.
    pub eval_ts: i64,
}

/// Neumaier-compensated summation step, as Prometheus' `kahanSumInc`.
pub(crate) fn kahan_inc(inc: f64, sum: f64, mut c: f64) -> (f64, f64) {
    let t = sum + inc;
    if t.is_infinite() {
        c = 0.0;
    } else if sum.abs() >= inc.abs() {
        c += (sum - t) + inc;
    } else {
        c += (inc - t) + sum;
    }
    (t, c)
}

/// rate / increase / delta with Prometheus' extrapolation.
pub(crate) fn extrapolated_rate(w: &Window, is_counter: bool, is_rate: bool) -> Option<f64> {
    let n = w.vals.len();
    if n < 2 {
        return None;
    }
    let first_t = w.ts[0];
    let last_t = w.ts[n - 1];
    let mut result = w.vals[n - 1] - w.vals[0];
    if is_counter {
        let mut prev = w.vals[0];
        for &v in &w.vals[1..] {
            if v < prev {
                result += prev;
            }
            prev = v;
        }
    }

    let mut duration_to_start = (first_t - w.range_start) as f64 / 1000.0;
    let mut duration_to_end = (w.range_end - last_t) as f64 / 1000.0;
    let sampled_interval = (last_t - first_t) as f64 / 1000.0;
    let avg_between = sampled_interval / (n - 1) as f64;

    let threshold = avg_between * 1.1;
    if duration_to_start >= threshold {
        duration_to_start = avg_between / 2.0;
    }
    if is_counter {
        // Counters cannot be negative: do not extrapolate below zero.
        let mut duration_to_zero = duration_to_start;
        if result > 0.0 && w.vals[0] >= 0.0 {
            duration_to_zero = sampled_interval * (w.vals[0] / result);
        }
        if duration_to_zero < duration_to_start {
            duration_to_start = duration_to_zero;
        }
    }
    if duration_to_end >= threshold {
        duration_to_end = avg_between / 2.0;
    }

    let mut factor = (sampled_interval + duration_to_start + duration_to_end) / sampled_interval;
    if is_rate {
        factor /= (w.range_end - w.range_start) as f64 / 1000.0;
    }
    Some(result * factor)
}

/// irate / idelta: the last two samples only.
pub(crate) fn instant_value(w: &Window, is_rate: bool) -> Option<f64> {
    let n = w.vals.len();
    if n < 2 {
        return None;
    }
    let (t0, v0) = (w.ts[n - 2], w.vals[n - 2]);
    let (t1, v1) = (w.ts[n - 1], w.vals[n - 1]);
    let sampled = t1 - t0;
    if sampled == 0 {
        return None;
    }
    let mut r = if is_rate && v1 < v0 {
        // Counter reset: the new value is the increase.
        v1
    } else {
        v1 - v0
    };
    if is_rate {
        r /= sampled as f64 / 1000.0;
    }
    Some(r)
}

pub(crate) fn resets(w: &Window) -> f64 {
    let mut n = 0;
    for i in 1..w.vals.len() {
        if w.vals[i] < w.vals[i - 1] {
            n += 1;
        }
    }
    n as f64
}

pub(crate) fn changes(w: &Window) -> f64 {
    let mut n = 0;
    for i in 1..w.vals.len() {
        let (p, c) = (w.vals[i - 1], w.vals[i]);
        if c != p && !(c.is_nan() && p.is_nan()) {
            n += 1;
        }
    }
    n as f64
}

pub(crate) fn avg_over_time(v: &[f64]) -> f64 {
    let mut sum = v[0];
    let mut count = 1.0;
    let (mut mean, mut c) = (0.0, 0.0);
    let mut incremental = false;
    for (i, &f) in v[1..].iter().enumerate() {
        count = (i + 2) as f64;
        if !incremental {
            let (ns, nc) = kahan_inc(f, sum, c);
            if !ns.is_infinite() {
                sum = ns;
                c = nc;
                continue;
            }
            // The running sum would overflow: switch to an incremental mean.
            incremental = true;
            mean = sum / (count - 1.0);
            c /= count - 1.0;
        }
        let q = (count - 1.0) / count;
        let (nm, nc) = kahan_inc(f / count, q * mean, q * c);
        mean = nm;
        c = nc;
    }
    if incremental {
        mean + c
    } else {
        sum / count + c / count
    }
}

pub(crate) fn sum_over_time(v: &[f64]) -> f64 {
    let (mut sum, mut c) = (0.0, 0.0);
    for &f in v {
        let (s, nc) = kahan_inc(f, sum, c);
        sum = s;
        c = nc;
    }
    if sum.is_infinite() {
        sum
    } else {
        sum + c
    }
}

pub(crate) fn variance_over_time(v: &[f64]) -> f64 {
    let mut count = 0.0;
    let (mut mean, mut c_mean) = (0.0, 0.0);
    let (mut aux, mut c_aux) = (0.0, 0.0);
    for &f in v {
        count += 1.0;
        let delta = f - (mean + c_mean);
        let (m, cm) = kahan_inc(delta / count, mean, c_mean);
        mean = m;
        c_mean = cm;
        let (a, ca) = kahan_inc(delta * (f - (mean + c_mean)), aux, c_aux);
        aux = a;
        c_aux = ca;
    }
    (aux + c_aux) / count
}

/// Returns (value, timestamp) of the extreme sample. `better(candidate, current)`.
pub(crate) fn compare_over_time(w: &Window, better: impl Fn(f64, f64) -> bool) -> (f64, i64) {
    let mut best = w.vals[0];
    let mut best_t = w.ts[0];
    for (i, &f) in w.vals.iter().enumerate() {
        if better(f, best) {
            best = f;
            best_t = w.ts[i];
        }
    }
    (best, best_t)
}

/// Ordering used by Prometheus' value heaps: NaN sorts first.
fn nan_first_cmp(a: &f64, b: &f64) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Equal,
        (true, false) => Less,
        (false, true) => Greater,
        _ => a.partial_cmp(b).unwrap_or(Equal),
    }
}

/// Exact quantile with linear interpolation between ranks (`quantile()` in
/// quantile.go). Sorts `values` in place.
pub(crate) fn quantile(q: f64, values: &mut [f64]) -> f64 {
    if values.is_empty() || q.is_nan() {
        return f64::NAN;
    }
    if q < 0.0 {
        return f64::NEG_INFINITY;
    }
    if q > 1.0 {
        return f64::INFINITY;
    }
    values.sort_by(nan_first_cmp);
    let n = values.len() as f64;
    let rank = q * (n - 1.0);
    let lower = rank.floor().max(0.0);
    let upper = (lower + 1.0).min(n - 1.0);
    let weight = rank - rank.floor();
    values[lower as usize] * (1.0 - weight) + values[upper as usize] * weight
}

pub(crate) fn mad_over_time(v: &[f64]) -> f64 {
    let mut vals = v.to_vec();
    let median = quantile(0.5, &mut vals);
    let mut dev: Vec<f64> = v.iter().map(|f| (f - median).abs()).collect();
    quantile(0.5, &mut dev)
}

/// Least-squares fit; returns (slope per second, intercept at `intercept_time`).
pub(crate) fn linear_regression(ts: &[i64], vals: &[f64], intercept_time: i64) -> (f64, f64) {
    let mut n = 0.0;
    let (mut sum_x, mut c_x) = (0.0, 0.0);
    let (mut sum_y, mut c_y) = (0.0, 0.0);
    let (mut sum_xy, mut c_xy) = (0.0, 0.0);
    let (mut sum_x2, mut c_x2) = (0.0, 0.0);
    let init_y = vals[0];
    let mut const_y = true;
    for i in 0..vals.len() {
        let y = vals[i];
        if const_y && i > 0 && y != init_y {
            const_y = false;
        }
        n += 1.0;
        let x = (ts[i] - intercept_time) as f64 / 1e3;
        (sum_x, c_x) = kahan_inc(x, sum_x, c_x);
        (sum_y, c_y) = kahan_inc(y, sum_y, c_y);
        (sum_xy, c_xy) = kahan_inc(x * y, sum_xy, c_xy);
        (sum_x2, c_x2) = kahan_inc(x * x, sum_x2, c_x2);
    }
    if const_y {
        if init_y.is_infinite() {
            return (f64::NAN, f64::NAN);
        }
        return (0.0, init_y);
    }
    sum_x += c_x;
    sum_y += c_y;
    sum_xy += c_xy;
    sum_x2 += c_x2;

    let cov_xy = sum_xy - sum_x * sum_y / n;
    let var_x = sum_x2 - sum_x * sum_x / n;
    let slope = cov_xy / var_x;
    let intercept = sum_y / n - slope * sum_x / n;
    (slope, intercept)
}

pub(crate) fn double_exponential_smoothing(v: &[f64], sf: f64, tf: f64) -> Option<f64> {
    let l = v.len();
    if l < 2 {
        return None;
    }
    let mut s0 = 0.0;
    let mut s1 = v[0];
    let mut b = v[1] - v[0];
    for i in 1..l {
        let x = sf * v[i];
        // Trend value.
        b = if i - 1 == 0 { b } else { tf * (s1 - s0) + (1.0 - tf) * b };
        let y = (1.0 - sf) * (s1 + b);
        s0 = s1;
        s1 = x + y;
    }
    Some(s1)
}

/// Relative float comparison used by Prometheus (`util/almost`).
pub fn almost_equal(a: f64, b: f64, epsilon: f64) -> bool {
    const MIN_NORMAL: f64 = f64::MIN_POSITIVE;
    if a.is_nan() && b.is_nan() {
        return true;
    }
    if a == b {
        return true;
    }
    let abs_sum = a.abs() + b.abs();
    let diff = (a - b).abs();
    if a == 0.0 || b == 0.0 || abs_sum < MIN_NORMAL {
        return diff < epsilon * MIN_NORMAL;
    }
    diff / abs_sum.min(f64::MAX) < epsilon
}

/// Classic-histogram quantile over `(upper_bound, cumulative_count)` buckets.
pub(crate) fn bucket_quantile(q: f64, buckets: &mut Vec<(f64, f64)>) -> f64 {
    if q.is_nan() {
        return f64::NAN;
    }
    if q < 0.0 {
        return f64::NEG_INFINITY;
    }
    if q > 1.0 {
        return f64::INFINITY;
    }
    buckets.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    if buckets.last().map(|b| b.0) != Some(f64::INFINITY) {
        return f64::NAN;
    }

    // Coalesce buckets with equal upper bounds.
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(buckets.len());
    for b in buckets.iter() {
        match merged.last_mut() {
            Some(l) if l.0 == b.0 => l.1 += b.1,
            _ => merged.push(*b),
        }
    }
    // Force monotonicity, ignoring deltas that are float noise.
    let mut prev = merged[0].1;
    for b in merged.iter_mut().skip(1) {
        let curr = b.1;
        if curr == prev {
            continue;
        }
        if almost_equal(prev, curr, 1e-12) || curr < prev {
            b.1 = prev;
            continue;
        }
        prev = curr;
    }

    if merged.len() < 2 {
        return f64::NAN;
    }
    let observations = merged[merged.len() - 1].1;
    if observations == 0.0 {
        return f64::NAN;
    }
    let mut rank = q * observations;
    let last = merged.len() - 1;
    let b = merged[..last].partition_point(|x| x.1 < rank);

    if b == last {
        return merged[last - 1].0;
    }
    if b == 0 && merged[0].0 <= 0.0 {
        return merged[0].0;
    }
    let mut bucket_start = 0.0;
    let bucket_end = merged[b].0;
    let mut count = merged[b].1;
    if b > 0 {
        bucket_start = merged[b - 1].0;
        count -= merged[b - 1].1;
        rank -= merged[b - 1].1;
    }
    bucket_start + (bucket_end - bucket_start) * (rank / count)
}

/// Go's `math.Mod`: result has the sign of `x`. Rust's `%` on floats agrees.
pub(crate) fn go_mod(x: f64, y: f64) -> f64 {
    x % y
}

// ---- calendar helpers (UTC, proleptic Gregorian), for the date functions ----

pub(crate) struct Civil {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// 0 = Sunday.
    pub weekday: u32,
    pub yday: u32,
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub(crate) fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
    }
}

/// Civil date from Unix seconds (Howard Hinnant's algorithm).
pub(crate) fn civil_from_unix(secs: i64) -> Civil {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    let mut yday = d;
    for mm in 1..m {
        yday += days_in_month(year, mm);
    }
    Civil {
        year,
        month: m,
        day: d,
        hour: (rem / 3600) as u32,
        minute: ((rem % 3600) / 60) as u32,
        weekday: (days + 4).rem_euclid(7) as u32,
        yday,
    }
}

/// Natural-order "less than" for `sort_by_label`: digit runs compare numerically.
pub(crate) fn natural_less(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let si = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let da = std::str::from_utf8(&a[si..i]).unwrap_or("").trim_start_matches('0');
            let db = std::str::from_utf8(&b[sj..j]).unwrap_or("").trim_start_matches('0');
            if da.len() != db.len() {
                return da.len() < db.len();
            }
            if da != db {
                return da < db;
            }
            if (i - si) != (j - sj) {
                return (i - si) < (j - sj);
            }
        } else {
            if a[i] != b[j] {
                return a[i] < b[j];
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i) < (b.len() - j)
}
