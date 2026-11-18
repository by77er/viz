# viz-engine-wasm

The engine for WebAssembly: a Rust `cdylib` that wraps `viz-storage` behind a plain C ABI,
and a TypeScript binding (`js/`) that implements the storage half of `contracts/engine.ts`.

| Path | Contents |
|---|---|
| `src/lib.rs` | The C ABI: `viz_alloc`, `viz_free`, `viz_encode_segment`, `viz_select`, `viz_merge_files`, `viz_free_file`, `viz_abi_version` (2). The calling convention and both wire layouts are documented at the top of the file. |
| `js/index.ts` | `createEngine(module)`: `encodeSegment`, `select`, `mergeFiles`; `queryRange`, `queryInstant`, `selectors` throw "not built yet" |
| `js/worker.ts` | A minimal Worker that imports the `.wasm` as a module (proof that it loads in workerd) |
| `js/viz_engine.wasm` | Build output of `./build.sh`. Ignored by git: **build it before running any test in `engine/wasm`, `flush/` or `stack/`.** |
| `tests/abi.rs` | The C ABI called natively with real pointers |
| `test/` | The binding, tested inside workerd; `test/vzb1.ts` is an independent `VZB1` encoder used by these tests and by `flush/` and `stack/` |
| `tools/measure.mjs` | Size, instantiate time, time and memory, in Node |
| `tools/measure_merge.mjs` | Peak memory and time of `mergeFiles` for flush-shaped inputs, in Node |

```
./build.sh                 # release, fat LTO, +simd128,+bulk-memory → js/viz_engine.wasm
CARGO_TARGET_DIR=$PWD/target cargo test      # 4 native ABI tests
npm install && npm test    # 14 tests in workerd
npx tsc --noEmit
node tools/measure.mjs     # Node figures
npx vitest run test/measure.test.ts --reporter=verbose    # workerd figures (printed as MEASURE …)
```

## What is implemented

- **`encodeSegment(batches)`** → `EncodedFile[]` exactly as the contract shapes it. `bytes`
  is a copy that does not alias WASM memory.
- **`select(input, matchers, minTs, maxTs)`** → `SeriesData[]`, `ts` and `values` as
  `Float64Array`s with their own buffers.
- **`mergeFiles(table, files)`** → one `EncodedFile` (`contracts/engine.ts`): compaction of
  the files of one table and one tenant-day; the later file wins a duplicate key. Built to
  hold as little as possible: the inputs are read in place from the request buffer (no
  copy inside the module), the writer's buffer is pre-sized to the inputs' total, and the
  finished file is handed to JavaScript where it lies (`file_ptr`, released with
  `viz_free_file`) instead of being copied into a result buffer. Linear memory peaks at
  about inputs + output + 4 MB per input: 39 MB for 4 files of 7.7 MB, **70 MB for 8 files
  of 15.4 MB**, 150 MB for 2 files of 67 MB (Node 22, incompressible values;
  `tools/measure_merge.mjs`). Before those three changes: 67, 113 and 404 MB.
- **The contract's number rules.**
  - Times in: `select` refuses a fractional, `NaN` or non-number bound with a `RangeError`
    rather than rounding it. `±Infinity` are accepted as open bounds. Integers cross as `i64`.
  - Times out: the Rust side writes each `ts` as an `f64` (exact: batch decoding bounds
    timestamps to 0..253,402,300,799,999, far below 2^53), and the binding copies the bytes.
  - Values: copied byte for byte from WASM memory into the `Float64Array`'s buffer
    (`Uint8Array.set`). No element is read as a number on the way. The Rust side writes
    `to_bits()`. Tested by inspecting bytes: a staleness marker comes back as
    `02 00 00 00 00 00 f0 7f` from lake, from tail and from both, as do a second signalling
    NaN, a negative NaN with a payload, `0x7fffffffffffffff` and `-0`.
- **Errors are values.** A malformed batch, a bad regular expression or a corrupt file comes
  back as an `EngineError` with the engine's message (`batch 1: bad magic…`), and the same
  instance stays usable. Every byte of a request is bounds-checked in Rust before use.
- **Traps do not poison later calls.** Anything that is not an `EngineError` (a trap, out of
  memory) makes the binding drop the instance; the next call instantiates a new one.
  `reset()` does the same on purpose, to give memory back.
- **Label objects are safe.** Labels are defined with `Object.defineProperty`, so a label
  named `__proto__` is an ordinary own property.
- **Loads in workerd** as an imported module (`import wasm from './viz_engine.wasm'`),
  instantiated synchronously and lazily. The module has **no imports**.

### Plain C ABI, not wasm-bindgen

Chosen: a C ABI with length-prefixed buffers. Reasons:

1. The whole surface is two functions that take byte buffers and return byte buffers.
   wasm-bindgen's value is glue for rich types; here it would generate glue for
   `&[u8]`/`Vec<u8>` and still need a hand-written layer to honour the number rules
   (a `Vec<f64>` returned through wasm-bindgen becomes a `Float64Array` by a typed copy,
   which is fine, but `EncodedFile[]` and `SeriesData[]` would cross as many small JS
   objects or need `serde`).
2. No generated JavaScript, no `wasm-bindgen` CLI version to keep in step with the crate,
   no imports for the Worker to satisfy. The same module is callable from any host; the
   native test calls the same functions with pointers.
3. One copy in, one copy out, both explicit in ~200 lines of TypeScript.

It did not "clearly pay for itself", so it was not used. Not measured: the size or speed
of a wasm-bindgen build of the same thing.

## What is not implemented

- **`queryRange`, `queryInstant`, `selectors`.** They throw
  `engine: <name> is not built yet (the PromQL crate is not linked into this module)`.
  `engine/promql` is being built separately and is not linked in.
- **Streaming.** A request holds every input buffer in WASM memory at once, and a result is
  built whole before it is copied out. Fine for a few-MB segment; a large `select` needs
  the planner to bound what it passes in.
- **`wasm-opt`** is not run (`engine/AGENTS.md`: smaller, not faster; and it is not installed here).
- **A committed build.** The `.wasm` is build output. CI must run `./build.sh` first.
- Not measured on Cloudflare. The 128 MB isolate limit is not enforced by local workerd.

## How it was verified

- `cargo test`: **4 passed** (`tests/abi.rs`; two are for `viz_merge_files`: equal to the library for both tables, and every malformed request an error): encode then select through the ABI equals
  `viz-storage` called directly; every proper prefix of a request, trailing bytes, a huge
  count in a tiny request, an unknown matcher op, a bad regex and a bad batch are errors.
- `npm test`: **14 passed** in workerd (`test/engine.test.ts` 9, `test/merge.test.ts` 4, `test/measure.test.ts` 1; the merge tests: a merged pair selects identically to its inputs, the later input wins, errors keep the instance and 200 merges do not grow memory, a measured merge of 8 files):
  module loads as an import and has no imports; file fields per the contract and `PAR1`
  magic; deterministic bytes across instances; tail-only, lake-only and lake + tail give
  the same samples with no double count; matchers and inclusive ranges; tail beats lake;
  NaN payload bytes; the number rules; errors keep the instance (`instances() === 1`);
  `__proto__` label; the three "not built yet" errors; memory growth in the middle of a
  call; `reset()`.
- `npx tsc --noEmit`: clean.
- `wrangler deploy --dry-run` bundles `js/worker.ts` with the module (2,459 KiB, 751 KiB gzip),
  and `stack/` served requests under `wrangler dev` with the module imported.
- Both targets build: host (`cargo test`) and `wasm32-unknown-unknown` (`./build.sh`).

### Measurements (local; this machine, a shared 4-vCPU sandbox with other builds running)

| | |
|---|---|
| `.wasm` size | **2,509,752 bytes** raw; **747,101 bytes** `gzip -9` (Node's zlib level 9 gives 765,155) |
| Instantiate | Node 22: 0.33 ms median of 15 (compile of the bytes 0.8 ms, lazily tiered). workerd: below the 1 ms timer resolution at the median of 20, 9 ms worst (the first) |

Workload: 8 batches of 1,048,552 bytes each (2,000 series, 336,608 rows in total), one
`encodeSegment` call, then `select` of everything from the two files it produced
(312,167 + 41,036 bytes of Parquet). A fresh instance per run, so memory is that call's peak.

| | Node 22 | local workerd (vitest) |
|---|---|---|
| `encodeSegment`, 8 × 1 MiB | 94–134 ms (median of 7: 134) | 106–182 ms (median of 5: 167) |
| peak WASM memory, encode | 26.6 MB | 26.6 MB |
| `select` all 2,000 series, 336,608 samples | 58 ms | 36–99 ms (median of 5: 67) |
| peak WASM memory, select | 23.9 MB | 23.9 MB |
| `select` one metric (100 series, 16,832 samples) | 11.8 ms, 5.3 MB | not run |

These are local numbers, not Cloudflare numbers; the spread is this machine's noise.
The SIMD build was not compared with a non-SIMD build here.

## Known risks

- **Memory is the caller's to bound.** Encode peaks at about 3.2 × the batch bytes
  (26.6 MB for 8.4 MB), select at about 68 × the Parquet bytes when it returns every
  sample (decoded samples are 16 bytes each, and the result is held twice briefly: Rust
  vectors, then the result buffer). Linear memory never shrinks; a long-lived isolate keeps
  its high-water mark until `reset()`.
- **A trap in one request** costs the next request an instantiation (sub-millisecond
  locally) and loses nothing else, but a module bug that traps on some input would trap
  for every retry of that input.
- **`new WebAssembly.Instance` is synchronous.** Allowed in workerd for an imported module
  and fast here; on Cloudflare its cost counts against startup or the first request. Unmeasured.
- **ABI version.** `viz_abi_version()` is checked on instantiation; the binding and the
  module must be built from the same commit.
