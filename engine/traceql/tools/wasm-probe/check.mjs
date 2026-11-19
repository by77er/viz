// Loads the probe module with an empty import object, runs queries, and reports size,
// imports, instantiation time and query times. Usage: node check.mjs path/to/module.wasm
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const bytes = readFileSync(process.argv[2]);
const mod = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(mod);
let t0 = performance.now();
let inst;
for (let i = 0; i < 200; i++) inst = new WebAssembly.Instance(mod, {});
const instMs = (performance.now() - t0) / 200;
const { memory, viz_tq_alloc, viz_tq_run } = inst.exports;
function run(kind, q, n) {
  const req = new TextEncoder().encode(q + '\0' + n);
  const p = viz_tq_alloc(req.length);
  new Uint8Array(memory.buffer, p, req.length).set(req);
  const out = viz_tq_run(kind, p, req.length);
  const len = new DataView(memory.buffer).getUint32(out, true);
  return new TextDecoder().decode(new Uint8Array(memory.buffer, out + 4, len));
}
const results = {};
for (const [kind, q] of [[0, '{ resource.service.name = "db" && span.http.status_code >= 500 }'], [0, '{ } >> { status = error } | count() > 2'], [1, '{ } | rate() by (resource.service.name)'], [1, '{ } | quantile_over_time(duration, 0.5, 0.9)'], [0, '{ .a = '], [0, '{ } | compare({ status = error })']]) {
  const t = performance.now();
  const out = run(kind, q, 200);
  results[q] = { ms: +(performance.now() - t).toFixed(2), head: out.slice(0, 80) };
}
console.log(JSON.stringify({ bytes: bytes.length, gzip9: gzipSync(bytes, { level: 9 }).length, imports: imports.length, exports: WebAssembly.Module.exports(mod).map(e => e.name), instantiateMs: +instMs.toFixed(3), memoryBytes: memory.buffer.byteLength, results }, null, 1));
if (imports.length !== 0) process.exit(1);
