//! The `pattern` parser and the `|>` / `!>` line filters, from the documentation: a
//! pattern is literals and captures (`<name>`, or `<_>` to skip); it is anchored at the
//! start of the line; a capture extends to the next occurrence of the literal after it,
//! or to the end of the line when it is last.

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Lit(String),
    /// `None` for `<_>`.
    Cap(Option<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pattern {
    nodes: Vec<Node>,
}

fn valid_capture_name(s: &str) -> bool {
    let mut it = s.chars();
    matches!(it.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && it.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl Pattern {
    /// Parse a pattern. `need_named`: the parser form requires at least one named capture
    /// (the line filter form does not).
    pub fn parse(s: &str, need_named: bool) -> Result<Pattern, String> {
        let mut nodes: Vec<Node> = Vec::new();
        let mut lit = String::new();
        let mut rest = s;
        while !rest.is_empty() {
            if rest.starts_with('<') {
                if let Some(end) = rest[1..].find('>') {
                    let name = &rest[1..1 + end];
                    if valid_capture_name(name) {
                        if !lit.is_empty() {
                            nodes.push(Node::Lit(std::mem::take(&mut lit)));
                        }
                        nodes.push(Node::Cap(if name == "_" { None } else { Some(name.to_string()) }));
                        rest = &rest[end + 2..];
                        continue;
                    }
                }
            }
            let c = rest.chars().next().unwrap_or(' ');
            lit.push(c);
            rest = &rest[c.len_utf8()..];
        }
        if !lit.is_empty() {
            nodes.push(Node::Lit(lit));
        }
        for w in nodes.windows(2) {
            if matches!(w[0], Node::Cap(_)) && matches!(w[1], Node::Cap(_)) {
                return Err("invalid pattern: consecutive capture".into());
            }
        }
        let mut seen: Vec<&str> = Vec::new();
        for n in &nodes {
            if let Node::Cap(Some(name)) = n {
                if seen.contains(&name.as_str()) {
                    return Err(format!("invalid pattern: duplicate capture {name}"));
                }
                seen.push(name);
            }
        }
        if need_named && seen.is_empty() {
            return Err("invalid pattern: at least one capture must be named".into());
        }
        if nodes.is_empty() {
            return Err("invalid pattern: empty".into());
        }
        Ok(Pattern { nodes })
    }

    /// The `pattern` parser: anchored at the start of the line; a capture whose following
    /// literal is not found takes the rest of the line and matching stops.
    pub fn parse_captures<'l>(&self, line: &'l str) -> Vec<(&str, &'l str)> {
        let mut caps = Vec::new();
        let mut pos = 0usize;
        let mut i = 0;
        while i < self.nodes.len() {
            match &self.nodes[i] {
                Node::Lit(l) => {
                    if !line[pos..].starts_with(l.as_str()) {
                        return caps;
                    }
                    pos += l.len();
                }
                Node::Cap(name) => match self.nodes.get(i + 1) {
                    Some(Node::Lit(l)) => match line[pos..].find(l.as_str()) {
                        Some(off) => {
                            if let Some(n) = name {
                                caps.push((n.as_str(), &line[pos..pos + off]));
                            }
                            pos += off;
                        }
                        None => {
                            if let Some(n) = name {
                                caps.push((n.as_str(), &line[pos..]));
                            }
                            return caps;
                        }
                    },
                    _ => {
                        if let Some(n) = name {
                            caps.push((n.as_str(), &line[pos..]));
                        }
                        pos = line.len();
                    }
                },
            }
            i += 1;
        }
        caps
    }

    /// The `|>` line filter: the first literal may occur anywhere; each capture runs to the
    /// next occurrence of the literal after it; the pattern must consume the whole line
    /// (so a pattern that ends in a literal must end the line).
    pub fn filter_matches(&self, line: &str) -> bool {
        let mut pos = 0usize;
        for (i, n) in self.nodes.iter().enumerate() {
            match n {
                Node::Lit(l) => {
                    if i == 0 {
                        match line.find(l.as_str()) {
                            Some(off) => pos = off + l.len(),
                            None => return false,
                        }
                    } else {
                        if !line[pos..].starts_with(l.as_str()) {
                            return false;
                        }
                        pos += l.len();
                    }
                }
                Node::Cap(_) => match self.nodes.get(i + 1) {
                    Some(Node::Lit(l)) => match line[pos..].find(l.as_str()) {
                        Some(off) => pos += off,
                        None => return false,
                    },
                    _ => pos = line.len(),
                },
            }
        }
        pos == line.len()
    }

    /// The literal parts, for pruning (`|>` lines contain every literal).
    pub fn literals(&self) -> Vec<&str> {
        self.nodes
            .iter()
            .filter_map(|n| match n {
                Node::Lit(l) => Some(l.as_str()),
                _ => None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documented_example() {
        let p = Pattern::parse(r#"<ip> - - <_> "<method> <uri> <_>" <status> <size> <_> "<agent>" <_>"#, true).unwrap();
        let line = r#"0.191.12.2 - - [10/Jun/2021:09:14:29 +0000] "GET /api/plugins/versioncheck HTTP/1.1" 200 2 "-" "Go-http-client/2.0" "13.76.247.102, 34.120.177.193" "TLSv1.2" "US" """#;
        let caps = p.parse_captures(line);
        assert!(p.filter_matches(line));
        assert_eq!(
            caps,
            vec![
                ("ip", "0.191.12.2"),
                ("method", "GET"),
                ("uri", "/api/plugins/versioncheck"),
                ("status", "200"),
                ("size", "2"),
                ("agent", "Go-http-client/2.0")
            ]
        );
    }

    #[test]
    fn invalid_patterns() {
        assert!(Pattern::parse("<a><b>", true).is_err());
        assert!(Pattern::parse("<_> foo", true).is_err());
        assert!(Pattern::parse("<_> foo", false).is_ok());
        assert!(Pattern::parse("<a> <a>", true).is_err());
    }
}
