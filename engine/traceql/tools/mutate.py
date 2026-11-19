#!/usr/bin/env python3
"""Test-strength check: apply one semantic change at a time to a COPY of this crate in a
scratch directory (never in place: others commit and snapshot the tree), run the suites,
and report which suite caught each mutant.

Usage: python3 -I tools/mutate.py <scratch-dir> [--only N,M,...]
The scratch directory receives a copy of the crate, a copy of the shared regex crate
(engine/goregex, a path dependency, so `../goregex` resolves to the copy) and its own
CARGO_TARGET_DIR; all are removed at the end. The original sources are never written.
Mutants of the regex crate are also run against its own tests (suite `goregex`).
"""
import os, shutil, subprocess, sys

CRATE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MUTANTS = [
    ("missing attribute satisfies !=", "src/value.rs",
     "    if a.is_nil() || b.is_nil() {\n        return false;\n    }",
     "    if a.is_nil() || b.is_nil() {\n        return op == BinOp::Neq;\n    }"),
    ("regex not anchored", "src/parser.rs", "viz_goregex::Wrap::Anchored", "viz_goregex::Wrap::DotNl"),
    ("unconnected spans take part in structural operators", "src/eval.rs",
     "let r: Vec<usize> = r.iter().copied().filter(|&i| connected[i]).collect();",
     "let r: Vec<usize> = r.iter().copied().filter(|&i| connected[i] || true).collect();"),
    ("child relation reversed", "src/eval.rs",
     "SpansetOp::Child | SpansetOp::NotChild | SpansetOp::UnionChild => parents[b] == Some(a),",
     "SpansetOp::Child | SpansetOp::NotChild | SpansetOp::UnionChild => parents[a] == Some(b),"),
    ("structural operators bind looser than && and ||", "src/parser.rs",
     "Tok::Desc => (3, Some(Ok(SpansetOp::Descendant))),",
     "Tok::Desc => (1, Some(Ok(SpansetOp::Descendant))),"),
    ("&& binds tighter than || inside filters", "src/parser.rs",
     "            let (rhs, hr) = self.field_cmp()?;",
     "            let (rhs, hr) = if op == BinOp::Or { self.field_and_only()? } else { self.field_cmp()? };"),
    ("metrics bucket by floor instead of ceil", "src/metrics.rs",
     "let k = ts.div_ceil(self.step_nano) - self.base() - 1;",
     "let k = (ts / self.step_nano).saturating_sub(self.base());"),
    ("span starting exactly at start is counted", "src/metrics.rs",
     "if ts <= self.start_unix_nano || ts > self.end_unix_nano || self.step_nano == 0 {",
     "if ts < self.start_unix_nano || ts > self.end_unix_nano || self.step_nano == 0 {"),
    ("quantile interpolates from half the bucket bound", "src/metrics.rs",
     "let lower = prev.unwrap_or(upper - 1.0);", "let lower = upper - 1.0 + 0.0 * prev.unwrap_or(0.0);"),
    ("rate does not divide by the step", "src/metrics.rs",
     "x as f64 / step_s } else", "x as f64 } else"),
    ("nil group values kept as labels", "src/metrics.rs",
     ".filter(|(_, v)| !matches!(v, Val::Nil | Val::Arr(_)))", ".filter(|(_, v)| !matches!(v, Val::Arr(_)))"),
    ("aggregate over no values passes !=", "src/eval.rs",
     "if !v.is_nil() && compare(&v, *op, &lit) {", "if (v.is_nil() && *op == BinOp::Neq) || compare(&v, *op, &lit) {"),
    ("spansets left in evaluation order", "src/lib.rs",
     "    spansets.sort_by(|a: &SpansetResult, b: &SpansetResult| {",
     "    spansets.sort_by(|a: &SpansetResult, b: &SpansetResult| { if true { return std::cmp::Ordering::Equal; }"),
    ("negated structural operator prunes traces without left-hand matches", "src/plan.rs",
     "                | SpansetOp::NotSibling => tb,", "                | SpansetOp::NotSibling => Pred::and(ta, tb),"),
    ("trace id printed with leading zeros", "src/lib.rs",
     "trace_id: hex_trimmed(&t.trace_id),", "trace_id: hex(&t.trace_id),"),
    ("unscoped attribute looks at the resource first", "src/eval.rs",
     "Scope::None => attr(&span.attrs, name).or_else(|| attr(&span.resource, name)),",
     "Scope::None => attr(&span.resource, name).or_else(|| attr(&span.attrs, name)),"),
    # Nesting and regex limits (tests/limits.rs).
    ("tree height not bounded (chains build trees of any height)", "src/parser.rs",
     "        if h > MAX_DEPTH {", "        if h > usize::MAX - 1 {"),
    ("tree height bound off by one", "src/parser.rs",
     "        if h > MAX_DEPTH {", "        if h > MAX_DEPTH + 1 {"),
    ("parser recursion not bounded", "src/parser.rs",
     "        if self.depth > MAX_DEPTH {", "        if self.depth > usize::MAX - 1 {"),
    ("unary minus before a spanset or number recurses uncounted", "src/parser.rs",
     "                self.enter()?;\n                let (n, hn) = self.atom()?;\n                self.leave();",
     "                let (n, hn) = self.atom()?;"),
    ("field parentheses count one level, not two", "src/parser.rs",
     "            self.enter()?;\n            let (e, h) = self.field_or()?;\n            self.leave();",
     "            let (e, h) = self.field_or()?;"),
    ("regex nesting at the regex crate's default (250)", "src/parser.rs",
     "nest: REGEX_NEST_LIMIT + 2 }", "nest: 250 }"),
    ("regex size at the regex crate's default (10 MiB)", "src/parser.rs",
     "size: REGEX_SIZE_LIMIT,", "size: 10 << 20,"),
    ("regexes per query not counted", "src/parser.rs",
     "        if self.regexes > MAX_REGEXES {", "        if self.regexes > usize::MAX - 1 {"),
    # The nesting bound (100, D40) and Go's regex dialect (tests/regex_dialect.rs).
    ("nesting limit loosened back to 200", "src/parser.rs",
     "pub const MAX_DEPTH: usize = 100;", "pub const MAX_DEPTH: usize = 200;"),
    ("Unicode classes back on: the pattern is compiled untranslated, as before", "src/parser.rs",
     "viz_goregex::compile(text, viz_goregex::Wrap::Anchored, false, &limits).map_err(",
     'regex::RegexBuilder::new(&format!("^(?s:{text})$")).nest_limit(limits.nest).size_limit(limits.size)'
     '.dfa_size_limit(limits.dfa_size).build().map_err(|e| viz_goregex::Error::Invalid(e.to_string())).map_err('),
    ("Unicode classes back on: \\d \\w \\s passed to Rust as written", "../goregex/src/lib.rs",
     'let text = if e.is_ascii_lowercase() { format!("[{body}]") } else { format!("[^{body}]") };',
     'let text = format!("\\\\{e}"); let _ = body;'),
    ("Unicode word boundary", "../goregex/src/lib.rs", "'b' => \"(?-u:\\\\b)\",", "'b' => \"\\\\b\","),
    ("Go's bound on nested counted repetitions dropped", "../goregex/src/lib.rs",
     "if (min >= 2 || m >= 2) && u64::from(m) * u64::from(a.product) > u64::from(MAX_REPEAT) {",
     "if false && u64::from(m) * u64::from(a.product) > u64::from(MAX_REPEAT) {"),
    ("a `{` that starts no repetition is an error, not a literal", "../goregex/src/lib.rs",
     "self.literal('{' as u32);", "return Err(invalid(\"`{` starts no repetition\"));"),
    ("an unmatched `)` passed through (wrapping then rebalances it)", "../goregex/src/lib.rs",
     'return Err(invalid(format!("unexpected ): `{}`", self.src)));',
     "self.out.push(')'); self.i += 1; return Ok(());"),
    # Mutant 31 is equivalent: the unclosed-`(` check refuses every pattern in which an unmatched
    # `)` could be rebalanced by the wrapper. Both checks off is the real regression.
    ("parentheses not balanced at all (unmatched `)` passed, unclosed `(` allowed)", "../goregex/src/lib.rs",
     ['return Err(invalid(format!("unexpected ): `{}`", self.src)));',
      'if self.frames.len() > 1 {\n            return Err(invalid(format!("missing closing ): `{}`", self.src)));'],
     ["self.out.push(')'); self.i += 1; return Ok(());",
      'if false {\n            return Err(invalid(format!("missing closing ): `{}`", self.src)));']),
    # Group names (Go accepts `[A-Za-z0-9_]+`, a leading digit and a repeat included).
    ("a group name that starts with a digit is refused", "../goregex/src/lib.rs",
     "if k >= self.cs.len() || name.is_empty() || !name.chars()",
     "if k >= self.cs.len() || name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) || !name.chars()"),
    ("group names may hold any Unicode letter or digit", "../goregex/src/lib.rs",
     "!name.chars().all(|c| c == '_' || c.is_ascii_alphanumeric())", "!name.chars().all(|c| c == '_' || c.is_alphanumeric())"),
    ("names kept: a name the regex crate cannot hold goes to it (its refusal, not Unsupported)", "../goregex/src/lib.rs",
     "if name.starts_with(|c: char| c.is_ascii_digit()) || self.seen.contains(&name) {", "if false {"),
    ("names kept: a repeated name goes to the regex crate", "../goregex/src/lib.rs",
     "if name.starts_with(|c: char| c.is_ascii_digit()) || self.seen.contains(&name) {",
     "if name.starts_with(|c: char| c.is_ascii_digit()) {"),
    ("matchers keep names (compile_anchored refuses a name Go accepts)", "../goregex/src/lib.rs",
     "Ok(compile(p, Wrap::Anchored, false, &Limits::default())?)", "Ok(compile(p, Wrap::Anchored, true, &Limits::default())?)"),
    ("`(?<=` and `(?<!` read as Perl syntax, not as a named group (Go's wording)", "../goregex/src/lib.rs",
     "Some('<') if i + 3 < self.cs.len() => self.named(i + 3),",
     "Some('<') if i + 3 < self.cs.len() && !matches!(self.cs.get(i + 3), Some('=' | '!')) => self.named(i + 3),"),
    # Re-wrapping an atom (`a*(?i)*`): the `(?:` is recorded and written once, at the end.
    ("recorded re-wraps never written", "../goregex/src/lib.rs",
     "        if self.opens.is_empty() {\n            return self.out;", "        if true {\n            return self.out;"),
    ("recorded re-wraps written in recording order, not by offset", "../goregex/src/lib.rs",
     "        self.opens.sort_unstable_by_key(|&(at, _)| at);\n", ""),
    ("a second re-wrap at the same offset not counted", "../goregex/src/lib.rs",
     "Some((at, n)) if *at == a.start => *n += 1,", "Some((at, _)) if *at == a.start => {}"),
    ("each re-wrap inserted at the atom's start again (moves the atom's text: quadratic)", "../goregex/src/lib.rs",
     "            match self.opens.last_mut() {\n                Some((at, n)) if *at == a.start => *n += 1,\n"
     "                _ => self.opens.push((a.start, 1)),\n            }\n",
     '            self.out.insert_str(a.start, "(?:");\n'),
]

SUITES = [
    ("api", ["cargo", "test", "-j", "2", "--test", "api"]),
    ("regex_dialect", ["cargo", "test", "-j", "2", "--test", "regex_dialect"]),
    ("conformance", ["cargo", "test", "-j", "2", "--test", "conformance"]),
    ("props", ["cargo", "test", "-j", "2", "--test", "props", "--", "--test-threads", "2"]),
    ("limits", ["cargo", "test", "-j", "2", "--test", "limits", "--", "--test-threads", "2"]),
]

# Helper used by the "&& binds tighter" mutant: a second precedence level for `&&`.
AND_HELPER = '''
    fn field_and_only(&mut self) -> Hp<FieldExpr> {
        let (mut lhs, mut h) = self.field_cmp()?;
        while matches!(self.peek(), Tok::AndAnd) {
            self.next();
            let (rhs, hr) = self.field_cmp()?;
            h = h.max(hr) + 1;
            lhs = FieldExpr::Binary(BinOp::And, Box::new(lhs), Box::new(rhs));
        }
        Ok((lhs, h))
    }

    fn field_cmp(&mut self) -> Hp<FieldExpr> {'''


def main():
    scratch = os.path.abspath(sys.argv[1])
    only = [int(x) for x in sys.argv[sys.argv.index("--only") + 1].split(",")] if "--only" in sys.argv else None
    copy = os.path.join(scratch, "traceql-mutants")
    goregex = os.path.join(scratch, "goregex")
    for d in (copy, goregex):
        if os.path.exists(d):
            shutil.rmtree(d)
    shutil.copytree(CRATE, copy, ignore=shutil.ignore_patterns("target", ".work", "godiff", "__pycache__"))
    shutil.copytree(os.path.join(os.path.dirname(CRATE), "goregex"), goregex, ignore=shutil.ignore_patterns("target", "__pycache__"))
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(scratch, "target-mutants"), PROPTEST_CASES="48")
    goregex_env = dict(env, CARGO_TARGET_DIR=os.path.join(scratch, "target-mutants-goregex"))
    results = []
    for number, (name, path, old, new) in enumerate(MUTANTS, 1):
        if only and number not in only:
            continue
        f = os.path.join(copy, path)
        original = open(f).read()
        mutated = original
        # A mutant is one replacement, or a list of them applied together.
        for o, n in (zip(old, new) if isinstance(old, list) else [(old, new)]):
            assert mutated.count(o) == 1, f"{name}: pattern not found exactly once in {path}"
            mutated = mutated.replace(o, n)
        if "field_and_only" in new:
            mutated = mutated.replace("\n    fn field_cmp(&mut self) -> Hp<FieldExpr> {", AND_HELPER, 1)
        open(f, "w").write(mutated)
        caught = []
        suites = [(s, c, copy, env) for s, c in SUITES]
        if path.startswith("../goregex/"):
            suites.append(("goregex", ["cargo", "test", "-j", "2"], goregex, goregex_env))
        for suite, cmd, cwd, e in suites:
            r = subprocess.run(cmd, cwd=cwd, env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if r.returncode != 0:
                failing = [l.split()[1] for l in r.stdout.splitlines() if l.startswith("test ") and l.rstrip().endswith("FAILED")]
                if not failing and "overflowed its stack" in r.stdout:
                    failing = ["aborted: stack overflow"]
                caught.append(f"{suite} ({', '.join(failing) or 'build failed'})")
        open(f, "w").write(original)
        results.append((name, caught))
        print(f"{number}. {name}: {'; '.join(caught) or 'NOT CAUGHT'}", flush=True)
    # The copies are restored after every mutant; confirm they are green, then remove them.
    clean = all(subprocess.run(cmd, cwd=copy, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0 for _, cmd in SUITES)
    clean = clean and subprocess.run(["cargo", "test", "-j", "2"], cwd=goregex, env=goregex_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    print(f"restored copies green: {clean}")
    for d in (copy, goregex, env["CARGO_TARGET_DIR"], goregex_env["CARGO_TARGET_DIR"]):
        shutil.rmtree(d, ignore_errors=True)
    survivors = [n for n, c in results if not c]
    print(f"{len(results) - len(survivors)} of {len(results)} mutants caught; survivors: {survivors}")


if __name__ == "__main__":
    main()
