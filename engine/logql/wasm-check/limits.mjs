// node limits.mjs <module.wasm>: pathological nesting through the WASM module. Inputs past
// the limits must return an error object; inputs at the limits must evaluate. A stack
// overflow or panic would trap (RuntimeError) and fail this script.
import { readFileSync } from 'node:fs';
const mod = new WebAssembly.Module(readFileSync(process.argv[2]));
const S = 1000000000n;
const rows = [
  `app=a\t${1700000001n * S}\ta=1 x=2`,
  `app=a\t${1700000002n * S}\t{"a":"1"}`,
  `app=a\t${1700000003n * S}\t${'['.repeat(200000)}`,
  `app=a\t${1700000004n * S}\t${'{"a":'.repeat(100000)}`,
].join('\n');
function query(q) {
  const inst = new WebAssembly.Instance(mod, {}); // a fresh instance per case, as after a trap
  const { memory, viz_logql_alloc, viz_logql_free, viz_logql_query } = inst.exports;
  const req = new TextEncoder().encode(`${q}\n${1700000000n * S} ${1700000010n * S} ${S} 100 0\n${rows}`);
  const p = viz_logql_alloc(req.length);
  new Uint8Array(memory.buffer, p, req.length).set(req);
  const r = viz_logql_query(p, req.length);
  const out = new TextDecoder().decode(new Uint8Array(memory.buffer, Number(r >> 32n), Number(r & 0xffffffffn)));
  viz_logql_free(p, req.length);
  return JSON.parse(out);
}
const D = 20000;
const rep = (s, n) => s.repeat(n);
const CT = 'count_over_time({app="a"}[1m])';
let tall = CT;
for (let i = 0; i < 90; i++) tall = `(${tall}) + 1 + 1 + 1`;
let mixed = CT;
for (let i = 0; i < 48; i++) mixed = `(${mixed}) + 1`;
const lft = (t) => `{app="a"} | logfmt | line_format \`${t}\``;
const tooDeep = {
  'parentheses': `${rep('(', D)}1${rep(')', D)}`,
  'aggregations': `${rep('sum(', D)}${CT}${rep(')', D)}`,
  'operator chain': Array(D).fill('1').join(' + '),
  'power chain': Array(D).fill('2').join(' ^ '),
  'tall tree, shallow recursion': tall,
  'label filter parentheses': `{app="a"} | logfmt | ${rep('(', D)}a="1"${rep(')', D)}`,
  'label filter chain': `{app="a"} | logfmt | ${Array(D).fill('a > 0').join(' and ')}`,
  'template blocks': lft(`${rep('{{if .a}}', D)}x${rep('{{end}}', D)}`),
  'template else-if chain': lft(`{{if .a}}${rep('{{else if .b}}', D)}{{end}}`),
  'template parentheses': lft(`{{ ${rep('(', D)}1${rep(')', D)} }}`),
  'regex nesting': `{app="a"} |~ \`${rep('(', D)}a${rep(')', D)}\``,
  'regex size': '{app="a"} |~ `a{1000}{1000}{1000}`',
};
const atLimit = {
  'parentheses (98)': `${rep('(', 98)}${CT}${rep(')', 98)}`,
  'operator chain (98)': Array(98).fill(CT).join(' + '),
  'aggregations (97)': `${rep('sum(', 97)}${CT}${rep(')', 97)}`,
  'mixed parentheses and operators (48)': mixed,
  'label filter chain (98)': `{app="a"} | logfmt | ${Array(98).fill('a > 0').join(' and ')}`,
  'label filter parentheses (98)': `{app="a"} | logfmt | ${rep('(', 98)}a="1"${rep(')', 98)}`,
  'template blocks (99)': lft(`${rep('{{if .a}}', 99)}y${rep('{{end}}', 99)}`),
  'template parentheses (98)': lft(`{{ ${rep('(print ', 98)}.a${rep(')', 98)} }}`),
  'deep JSON lines, json': '{app="a"} | json',
  'deep JSON lines, json params': '{app="a"} | json x="a.a.a"',
  'deep JSON lines, unpack': '{app="a"} | unpack',
  'deep JSON lines, fromJson': '{app="a"} | line_format "{{ fromJson __line__ }}"',
};
let failed = 0;
for (const [name, q] of Object.entries(tooDeep)) {
  const r = query(q);
  const ok = r.status === 'error';
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', 'refused:', name, '-', (r.error || r.resultType || '').slice(0, 90));
}
for (const [name, q] of Object.entries(atLimit)) {
  const r = query(q);
  const ok = r.status !== 'error' && Array.isArray(r.result);
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', 'evaluated:', name, '-', ok ? `${r.resultType}, ${r.result.length} result(s)` : r.error);
}
console.log(failed ? `${failed} FAILED` : 'all passed', `(${Object.keys(tooDeep).length} refused, ${Object.keys(atLimit).length} evaluated, no trap)`);
process.exit(failed ? 1 : 0);
