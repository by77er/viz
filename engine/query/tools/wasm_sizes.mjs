// Attributes the code of an UNSTRIPPED build of the whole-engine module to crates, from
// the wasm name section, and reports the data section. Used for the "what dominates the
// size" table in the README.
//
//   (cd wasm && CARGO_PROFILE_RELEASE_STRIP=false CARGO_TARGET_DIR=$PWD/../target/sizes \
//      cargo build --release --target wasm32-unknown-unknown)
//   node tools/wasm_sizes.mjs target/sizes/wasm32-unknown-unknown/release/viz_whole_engine.wasm
import { readFileSync } from 'node:fs'

const buf = readFileSync(process.argv[2])
let p = 8
const leb = () => {
  let r = 0, s = 0, b
  do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7 } while (b & 0x80)
  return r >>> 0
}
const sizes = [] // code body sizes by defined-function index
const names = new Map()
let imported = 0, dataBytes = 0, codeBytes = 0
const sections = {}
while (p < buf.length) {
  const id = buf[p++]
  const size = leb()
  const end = p + size
  sections[id] = (sections[id] ?? 0) + size
  if (id === 2) {
    const n = leb()
    for (let i = 0; i < n; i++) {
      p += leb(); p += leb() // module, field
      const kind = buf[p++]
      if (kind === 0) { leb(); imported++ } else if (kind === 1) { p++; const f = leb(); leb(); if (f & 1) leb() } else if (kind === 2) { const f = leb(); leb(); if (f & 1) leb() } else { p += 2 }
    }
  } else if (id === 10) {
    codeBytes = size
    const n = leb()
    for (let i = 0; i < n; i++) { const s = leb(); sizes.push(s); p += s }
  } else if (id === 11) {
    dataBytes = size
  } else if (id === 0) {
    const nl = leb()
    const name = buf.subarray(p, p + nl).toString(); p += nl
    if (name === 'name') {
      while (p < end) {
        const sub = buf[p++], ss = leb(), se = p + ss
        if (sub === 1) {
          const n = leb()
          for (let i = 0; i < n; i++) { const idx = leb(); const l = leb(); names.set(idx, buf.subarray(p, p + l).toString()); p += l }
        }
        p = se
      }
    }
  }
  p = end
}
if (names.size === 0) { console.error('no name section: build with CARGO_PROFILE_RELEASE_STRIP=false'); process.exit(1) }

// The crate a function belongs to: the first crate named in its mangled symbol that is
// not core/alloc/std (so a `Vec<parquet::X>` method is parquet's cost).
const std = new Set(['core', 'alloc', 'std', 'hashbrown', 'compiler_builtins', 'dlmalloc', 'std_detect', 'rustc_demangle', 'rustc', 'memchr'])
function crateOf(name) {
  // Rust v0 mangling: a crate root is `C` + optional `s<disambiguator>_` + <len><name>.
  const all = []
  for (const m of name.matchAll(/Cs[0-9a-zA-Z]+_(\d+)/g)) {
    const len = Number(m[1]), at = m.index + m[0].length
    all.push(name.slice(at, at + len).replace(/^_+/, ''))
  }
  if (all.length === 0) return '(other: memcpy, compiler builtins, exports)'
  return all.find((c) => !std.has(c)) ?? all[0]
}
const group = {
  parquet: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)', snap: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)', bytes: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)',
  thrift: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)', half: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)', num_bigint: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)',
  num_integer: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)', num_traits: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)', twox_hash: 'parquet (+ snap, bytes, thrift, half, num, twox_hash)',
  regex: 'regex (regex, regex_automata, regex_syntax, aho_corasick)', regex_automata: 'regex (regex, regex_automata, regex_syntax, aho_corasick)', regex_syntax: 'regex (regex, regex_automata, regex_syntax, aho_corasick)', aho_corasick: 'regex (regex, regex_automata, regex_syntax, aho_corasick)',
  promql_parser: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)', lrpar: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)',
  lrlex: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)', lrtable: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)',
  cfgrammar: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)', bincode: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)',
  vob: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)', sparsevec: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)',
  packedvec: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)', cactus: 'promql-parser + its runtime (lrpar, lrlex, lrtable, cfgrammar, bincode, vob, sparsevec, packedvec, cactus)',
  core: 'Rust std (core, alloc, std, hashbrown, dlmalloc)', alloc: 'Rust std (core, alloc, std, hashbrown, dlmalloc)', std: 'Rust std (core, alloc, std, hashbrown, dlmalloc)', hashbrown: 'Rust std (core, alloc, std, hashbrown, dlmalloc)',
  dlmalloc: 'Rust std (core, alloc, std, hashbrown, dlmalloc)', compiler_builtins: 'Rust std (core, alloc, std, hashbrown, dlmalloc)',
}
const byCrate = new Map()
sizes.forEach((s, i) => {
  const c = crateOf(names.get(imported + i) ?? '')
  const g = group[c] ?? c
  byCrate.set(g, (byCrate.get(g) ?? 0) + s)
})
console.log(`file ${buf.length} bytes: code section ${codeBytes}, data section ${dataBytes}, other sections ${buf.length - codeBytes - dataBytes} (includes the name section of this unstripped build)`)
console.log(`${sizes.length} functions\n\ncode bytes by crate:`)
for (const [c, s] of [...byCrate].sort((a, b) => b[1] - a[1])) {
  if (s < 4096) continue
  console.log(`${String(s).padStart(9)}  ${(100 * s / codeBytes).toFixed(1).padStart(5)}%  ${c}`)
}
