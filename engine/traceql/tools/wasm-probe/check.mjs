// Loads the probe module with an empty import object, runs queries, and reports size,
// imports, instantiation time and query times; then runs the nesting and regex limits
// (the shapes of tests/common/shapes.rs, which tests/limits.rs runs natively).
// Usage: node [--stack-size=KB] check.mjs path/to/module.wasm
// Exits non-zero if the module has imports or any limit check fails.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const bytes = readFileSync(process.argv[2]);
const mod = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(mod);
let t0 = performance.now();
let inst;
for (let i = 0; i < 200; i++) inst = new WebAssembly.Instance(mod, {});
const instMs = (performance.now() - t0) / 200;
function run(kind, q, n) {
  const { memory, viz_tq_alloc, viz_tq_free, viz_tq_run } = inst.exports;
  const req = new TextEncoder().encode(q + '\0' + n);
  const p = viz_tq_alloc(req.length);
  new Uint8Array(memory.buffer, p, req.length).set(req);
  const out = viz_tq_run(kind, p, req.length);
  const len = new DataView(memory.buffer).getUint32(out, true);
  const text = new TextDecoder().decode(new Uint8Array(memory.buffer, out + 4, len));
  viz_tq_free(p, req.length);
  viz_tq_free(out, len + 4);
  return text;
}
const results = {};
for (const [kind, q] of [[0, '{ resource.service.name = "db" && span.http.status_code >= 500 }'], [0, '{ } >> { status = error } | count() > 2'], [1, '{ } | rate() by (resource.service.name)'], [1, '{ } | quantile_over_time(duration, 0.5, 0.9)'], [0, '{ .a = '], [0, '{ } | compare({ status = error })']]) {
  const t = performance.now();
  const out = run(kind, q, 200);
  results[q] = { ms: +(performance.now() - t).toFixed(2), head: out.slice(0, 80) };
}

const memoryAfterQueries = inst.exports.memory.buffer.byteLength;

// ---- limits: same shapes and boundaries as tests/common/shapes.rs (MAX_DEPTH = 200).
const MAX_QUERY_BYTES = 128 * 1024;
const rep = (s, n) => s.repeat(n);
const S = 0, M = 1; // search, metrics
const NESTED = [
  ['field parentheses', S, n => `{ ${rep('(', n)}.a = 1${rep(')', n)} }`],
  ['field !', S, n => `{ ${rep('!', n)}(.a = 1) }`],
  ['field unary minus', S, n => `{ ${rep('- ', n)}.a != 0 }`],
  ['field && chain', S, n => `{ .a = 1${rep(' && .a = 1', n)} }`],
  ['field || chain', S, n => `{ .a = 0${rep(' || .a = 1', n)} }`],
  ['field + chain', S, n => `{ .a${rep(' + .a', n)} > 0 }`],
  ['field * chain', S, n => `{ .a${rep(' * .a', n)} = 1 }`],
  ['field ^ chain', S, n => `{ .a${rep(' ^ 1', n)} = 1 }`],
  ['field comparison chain', S, n => `{ .a = 1${rep(' = true', n)} }`],
  ['spanset parentheses', S, n => `${rep('(', n)}{ .a = 1 }${rep(')', n)}`],
  ['spanset && chain', S, n => `{ .a = 1 }${rep(' && { .a = 1 }', n)}`],
  ['spanset || chain', S, n => `{ .a = 0 }${rep(' || { .a = 1 }', n)}`],
  ['structural >> chain', S, n => `{ }${rep(' >> { }', n)}`],
  ['nested structural >', S, n => `${rep('{ } > (', n)}{ }${rep(')', n)}`],
  ['nested pipelines', S, n => `${rep('({ } | ', n)}{ }${rep(')', n)}`],
  ['metrics unary minus', M, n => `rate() + ${rep('- ', n)}1`],
  ['metrics + chain', M, n => `rate()${rep(' + rate()', n)}`],
  ['metrics parentheses', M, n => `${rep('(', n)}{ } | rate()${rep(')', n)}`],
  ['metrics threshold', M, n => `{ } | rate() > 0${rep(' + 0', n)}`],
  ['scalar filter constant', S, n => `{ } | count() > 0${rep(' + 0', n)}`],
  ['aggregate argument', S, n => `{ } | avg(.a${rep(' + .a', n)}) > 0`],
  ['by() argument', S, n => `{ } | by(.a${rep(' + .a', n)})`],
  ['metrics argument', M, n => `{ } | sum_over_time(.a${rep(' + .a', n)})`],
  ['metrics by() argument', M, n => `{ } | rate() by (.a${rep(' + .a', n)})`],
  ['regex in field parentheses', S, n => `{ ${rep('(', n)}name =~ "${rep('(', 63)}.*${rep(')', 63)}"${rep(')', n)} }`],
];
const FLAT = [
  ['pipeline stages', S, n => `{ }${rep(' | { }', n)}`],
  ['second stages', M, n => `{ } | rate()${rep(' | topk(1)', n)}`],
  ['metrics by() list', M, n => `{ } | rate() by (.a${rep(', .a', n)})`],
  ['quantiles', M, n => `{ } | quantile_over_time(duration${rep(', 0.5', n)})`],
  ['hints', S, n => `{ } with (h0 = 1${Array.from({ length: n }, (_, i) => `, h${i + 1} = 1`).join('')})`],
];
const fill = make => { let lo = 1, hi = MAX_QUERY_BYTES; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (make(mid).length <= MAX_QUERY_BYTES) lo = mid; else hi = mid - 1; } return lo; };
const failures = [];
let traps = 0;
function attempt(kind, q) {
  try { return run(kind, q, 10); } catch (e) { traps++; inst = new WebAssembly.Instance(mod, {}); return `TRAP ${e.constructor.name}: ${e.message}`; }
}
const isErr = out => out.startsWith('{"error"');
const deep = out => out.includes('nested deeper than');
const limits = {};
for (const [name, kind, make] of NESTED) {
  let max = 0;
  for (let n = 1; n <= 202; n++) { if (isErr(attempt(kind, make(n)))) break; max = n; }
  const t = performance.now();
  const at = attempt(kind, make(max));
  const ms = +(performance.now() - t).toFixed(2);
  const past = attempt(kind, make(max + 1));
  const far = attempt(kind, make(fill(make)));
  limits[name] = { max, ms };
  if (max === 0 || isErr(at) || at.startsWith('TRAP')) failures.push(`${name} at ${max}: ${at.slice(0, 120)}`);
  if (!deep(past)) failures.push(`${name} at ${max + 1}: ${past.slice(0, 120)}`);
  if (!deep(far)) failures.push(`${name} filled to 128 KiB: ${far.slice(0, 120)}`);
}
for (const [name, kind, make] of FLAT) {
  const n = Math.min(fill(make), 5000);
  const out = attempt(kind, make(n));
  if (isErr(out) || out.startsWith('TRAP')) failures.push(`${name} x${n}: ${out.slice(0, 120)}`);
}
const nestRe = n => `{ name =~ "${rep('(', n)}x${rep(')', n)}" }`;
const regex = {
  nest64: attempt(S, nestRe(64)), nest65: attempt(S, nestRe(65)), nestFar: attempt(S, nestRe(fill(nestRe))),
  size: attempt(S, '{ name =~ "x{100000}" }'),
  unicode: attempt(S, '{ name =~ "\\\\w{2}|\\\\w{16}" }'),
  count16: attempt(S, `{ ${Array(16).fill('name =~ "op.*"').join(' && ')} }`),
  count17: attempt(S, `{ ${Array(17).fill('name =~ "op.*"').join(' && ')} }`),
};
for (const k of ['nest64', 'unicode', 'count16']) if (isErr(regex[k])) failures.push(`regex ${k} (within the limits): ${regex[k].slice(0, 120)}`);
for (const k of ['nest65', 'nestFar', 'size', 'count17']) if (!isErr(regex[k])) failures.push(`regex ${k}: ${regex[k].slice(0, 120)}`);
// Linear memory never shrinks: these are peaks (a trap replaces the instance).
const memoryAfterLimits = inst.exports.memory.buffer.byteLength;
console.log(JSON.stringify({ bytes: bytes.length, gzip9: gzipSync(bytes, { level: 9 }).length, imports: imports.length, exports: WebAssembly.Module.exports(mod).map(e => e.name), instantiateMs: +instMs.toFixed(3), memoryAfterQueries, memoryAfterLimits, results, limits, traps, failures }, null, 1));
if (imports.length !== 0 || failures.length !== 0) process.exit(1);
