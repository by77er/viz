#!/usr/bin/env python3
"""Test-strength check: apply one semantic change at a time to a COPY of this crate in a
scratch directory (never in place: others commit and snapshot the tree), run the suites,
and report which suite caught each mutant.

Usage: python3 -I tools/mutate.py <scratch-dir>
The scratch directory receives a copy of the crate and its own CARGO_TARGET_DIR; it is
removed at the end. The original sources are never written.
"""
import os, shutil, subprocess, sys

CRATE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MUTANTS = [
    ("missing attribute satisfies !=", "src/value.rs",
     "    if a.is_nil() || b.is_nil() {\n        return false;\n    }",
     "    if a.is_nil() || b.is_nil() {\n        return op == BinOp::Neq;\n    }"),
    ("regex not anchored", "src/parser.rs", 'format!("^(?s:{text})$")', 'format!("(?s:{text})")'),
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
     "            let rhs = self.field_cmp()?;\n            lhs = FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs));\n        }\n        self.depth -= 1;",
     "            let rhs = if op == BinOp::Or { self.field_and_only()? } else { self.field_cmp()? };\n            lhs = FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs));\n        }\n        self.depth -= 1;"),
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
]

SUITES = [
    ("api", ["cargo", "test", "-j", "2", "--test", "api"]),
    ("conformance", ["cargo", "test", "-j", "2", "--test", "conformance"]),
    ("props", ["cargo", "test", "-j", "2", "--test", "props", "--", "--test-threads", "2"]),
]

# Helper used by the "&& binds tighter" mutant: a second precedence level for `&&`.
AND_HELPER = '''
    fn field_and_only(&mut self) -> Result<FieldExpr, Error> {
        let mut lhs = self.field_cmp()?;
        while matches!(self.peek(), Tok::AndAnd) {
            self.next();
            let rhs = self.field_cmp()?;
            lhs = FieldExpr::Binary(BinOp::And, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn field_cmp(&mut self) -> Result<FieldExpr, Error> {'''


def main():
    scratch = os.path.abspath(sys.argv[1])
    copy = os.path.join(scratch, "traceql-mutants")
    if os.path.exists(copy):
        shutil.rmtree(copy)
    shutil.copytree(CRATE, copy, ignore=shutil.ignore_patterns("target", ".work", "godiff"))
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(scratch, "target-mutants"), PROPTEST_CASES="48")
    results = []
    for name, path, old, new in MUTANTS:
        f = os.path.join(copy, path)
        original = open(f).read()
        assert original.count(old) == 1, f"{name}: pattern not found exactly once in {path}"
        mutated = original.replace(old, new)
        if "field_and_only" in new:
            mutated = mutated.replace("\n    fn field_cmp(&mut self) -> Result<FieldExpr, Error> {", AND_HELPER, 1)
        open(f, "w").write(mutated)
        caught = []
        for suite, cmd in SUITES:
            r = subprocess.run(cmd, cwd=copy, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if r.returncode != 0:
                failing = [l.split()[1] for l in r.stdout.splitlines() if l.startswith("test ") and l.rstrip().endswith("FAILED")]
                caught.append(f"{suite} ({', '.join(failing) or 'build failed'})")
        open(f, "w").write(original)
        results.append((name, caught))
        print(f"{name}: {'; '.join(caught) or 'NOT CAUGHT'}", flush=True)
    # The copy is restored after every mutant; confirm it is green, then remove it.
    clean = all(subprocess.run(cmd, cwd=copy, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0 for _, cmd in SUITES)
    print(f"restored copy green: {clean}")
    shutil.rmtree(copy)
    shutil.rmtree(env["CARGO_TARGET_DIR"], ignore_errors=True)
    survivors = [n for n, c in results if not c]
    print(f"{len(results) - len(survivors)} of {len(results)} mutants caught; survivors: {survivors}")


if __name__ == "__main__":
    main()
