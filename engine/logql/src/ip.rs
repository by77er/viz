//! `ip("…")` matching, from the "Matching IP addresses" documentation: a single IPv4 or
//! IPv6 address, a range `a-b`, or a CIDR prefix `a/n`. Addresses of different families
//! never match each other.

use std::net::IpAddr;

#[derive(Debug, Clone, PartialEq)]
pub enum IpMatcher {
    Single(IpAddr),
    Range(IpAddr, IpAddr),
    Cidr(IpAddr, u8),
}

fn to_u128(a: &IpAddr) -> (bool, u128) {
    match a {
        IpAddr::V4(v) => (true, u32::from(*v) as u128),
        IpAddr::V6(v) => (false, u128::from(*v)),
    }
}

fn parse_addr(s: &str) -> Option<IpAddr> {
    s.trim().parse::<IpAddr>().ok()
}

impl IpMatcher {
    pub fn parse(p: &str) -> Result<IpMatcher, String> {
        let err = || format!("invalid ip pattern {p:?}");
        if let Some((a, b)) = p.split_once('-') {
            let (a, b) = (parse_addr(a).ok_or_else(err)?, parse_addr(b).ok_or_else(err)?);
            let ((fa, va), (fb, vb)) = (to_u128(&a), to_u128(&b));
            if fa != fb || va > vb {
                return Err(err());
            }
            return Ok(IpMatcher::Range(a, b));
        }
        if let Some((a, n)) = p.split_once('/') {
            let a = parse_addr(a).ok_or_else(err)?;
            let n: u8 = n.trim().parse().map_err(|_| err())?;
            let max = if a.is_ipv4() { 32 } else { 128 };
            if n > max {
                return Err(err());
            }
            return Ok(IpMatcher::Cidr(a, n));
        }
        Ok(IpMatcher::Single(parse_addr(p).ok_or_else(err)?))
    }

    pub fn contains(&self, ip: &IpAddr) -> bool {
        let (f, v) = to_u128(ip);
        match self {
            IpMatcher::Single(a) => a == ip,
            IpMatcher::Range(a, b) => {
                let ((fa, va), (_, vb)) = (to_u128(a), to_u128(b));
                f == fa && va <= v && v <= vb
            }
            IpMatcher::Cidr(a, n) => {
                let (fa, va) = to_u128(a);
                if f != fa {
                    return false;
                }
                let bits: u32 = if fa { 32 } else { 128 };
                let shift = bits - *n as u32;
                if shift >= 128 {
                    return true;
                }
                (va >> shift) == (v >> shift)
            }
        }
    }

    /// Does a label value (one address) match?
    #[cfg(test)]
    pub fn matches_value(&self, s: &str) -> bool {
        parse_addr(s).is_some_and(|a| self.contains(&a))
    }

    /// Does any address in a line match? Candidates are maximal runs of characters that can
    /// form an address (hex digits, `.`, `:`); a run that is not an address as a whole is
    /// also tried with its trailing `.`/`:` removed.
    pub fn matches_line(&self, line: &str) -> bool {
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if !is_ip_char(b[i]) {
                i += 1;
                continue;
            }
            let start = i;
            while i < b.len() && is_ip_char(b[i]) {
                i += 1;
            }
            let mut cand = &line[start..i];
            loop {
                if let Some(a) = parse_addr_strict(cand) {
                    if self.contains(&a) {
                        return true;
                    }
                    break;
                }
                match cand.strip_suffix(['.', ':']) {
                    Some(c) if !c.is_empty() => cand = c,
                    _ => break,
                }
            }
        }
        false
    }
}

fn is_ip_char(c: u8) -> bool {
    c.is_ascii_hexdigit() || c == b'.' || c == b':'
}

fn parse_addr_strict(s: &str) -> Option<IpAddr> {
    if !s.bytes().any(|c| c == b'.' || c == b':') {
        return None;
    }
    s.parse::<IpAddr>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documented_forms() {
        let m = IpMatcher::parse("192.168.4.5/16").unwrap();
        assert!(m.matches_value("192.168.200.1"));
        assert!(!m.matches_value("192.169.0.1"));
        let m = IpMatcher::parse("192.168.4.5-192.168.4.20").unwrap();
        assert!(m.matches_value("192.168.4.20"));
        assert!(!m.matches_value("192.168.4.21"));
        let m = IpMatcher::parse("2001:db8::/32").unwrap();
        assert!(m.matches_value("2001:db8:1::5"));
        assert!(!m.matches_value("10.0.0.1"));
        let m = IpMatcher::parse("3.180.71.3").unwrap();
        assert!(m.matches_line("3.180.71.3 - - [17/May/2015]"));
        assert!(!m.matches_line("93.180.71.3 - - [17/May/2015]"));
        assert!(IpMatcher::parse("1.2.3").is_err());
        assert!(IpMatcher::parse("10.0.0.2-10.0.0.1").is_err());
    }
}
