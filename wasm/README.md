# SCAMP-wasm

WebAssembly build of [SCAMP](../README.md) — GPU/CPU matrix profile —
producing single-threaded and multi-threaded browser + Node bundles from
the same C++ core.

- **Node smoke + correctness (vs native SCAMP): green.**
- **wasm CPU perf on M-series Mac (5-iter medians)**: 1NN_INDEX 0.90s,
  1NN 0.36s, SUM 0.37s, MATRIX 1.18s at n=32 768, w=100, single thread.
  All within 1.06–1.41× of native ARM baseline on the same machine.
  See [notes on this](#performance).

## Quick start

```bash
cd wasm
./setup.sh                # installs a pinned emsdk (3.1.74) under wasm/emsdk/
./build.sh both           # builds ST + MT into wasm/dist/
npm test                  # runs smoke + correctness tests (Node)
npm run serve:demo        # http://localhost:8090/demo/  (COOP/COEP headers set)
```

The `serve:demo` script uses a tiny Node HTTP server ([`serve.mjs`](serve.mjs))
that sends the `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy`
headers required for the multi-threaded demo. Any static host works for
the single-threaded build; the MT build requires those headers.

## Using it

Drop `dist/scamp.js` and its siblings (`scamp-*.js`, `*.wasm`,
`scamp.worker.js`) onto a static host and:

```html
<script src="/path/to/scamp.js"></script>
<script type="module">
  const scamp = await SCAMP.create({
    threads: 'auto',        // 'auto' | 1 | N
    baseUrl: '/path/to/',   // where the sibling .js/.wasm live
  });

  const a = new Float64Array(4096);
  // ... fill a ...

  // High-level sugar (matches pyscamp).
  const { a: result } = await scamp.selfJoin(a, 128);
  // result.profile : Float32Array
  // result.index   : Int32Array

  // Or full control:
  const { a: r } = await scamp.run(
    { a, window: 128, profileType: '1NN_INDEX', precision: 'double' },
    {
      onProgress: (done, total) => console.log(`${done}/${total}`),
      onSnapshot: (snap) => plot(snap.profile),   // ST-only, see limitations
      signal: abortCtrl.signal,
    }
  );
</script>
```

The wasm module is hosted inside a dedicated Web Worker (owned by the
library) so `scamp.run(...)` never blocks the calling thread, regardless
of whether the ST or MT build is in use.

### Sugar helpers

Mirror pyscamp's function surface. Every one accepts the same trailing
`opts` object as `run()`:

| JS | Equivalent `run()` args |
|---|---|
| `scamp.selfJoin(a, w)` | `{a, window:w, profileType:'1NN_INDEX'}` |
| `scamp.selfJoin1NN(a, w)` | `{a, window:w, profileType:'1NN'}` |
| `scamp.selfJoinSum(a, w, {threshold})` | `{a, window:w, profileType:'SUM_THRESH'}` |
| `scamp.selfJoinMatrix(a, w, {matrixHeight, matrixWidth})` | `{a, window:w, profileType:'MATRIX_SUMMARY'}` |
| `scamp.abJoin(a, b, w)` | `{a, b, window:w, profileType:'1NN_INDEX'}` |
| `scamp.abJoin1NN(a, b, w)` | `{a, b, window:w, profileType:'1NN'}` |
| `scamp.abJoinSum(a, b, w, {threshold})` | `{a, b, window:w, profileType:'SUM_THRESH'}` |
| `scamp.abJoinMatrix(a, b, w, {matrixHeight, matrixWidth})` | `{a, b, window:w, profileType:'MATRIX_SUMMARY'}` |

See [`js/scamp.d.ts`](js/scamp.d.ts) for the full types.

### Result shapes

| `profileType` | `result.a` shape |
|---|---|
| `'1NN_INDEX'` (default) | `{ profile: Float32Array, index: Int32Array }` |
| `'1NN'` | `{ profile: Float32Array }` |
| `'SUM_THRESH'` | `{ profile: Float64Array }` |
| `'MATRIX_SUMMARY'` | `{ values: Float32Array, height, width }` |

For AB-joins where `keepRowsSeparate: true`, `result.b` is populated
with the row-side reduction. Self-joins and default AB-joins put
everything in `result.a`.

## Threading modes

| `threads` value | Build used | Requirements |
|---|---|---|
| `1` (default when not isolated) | `scamp-st.wasm` | none — works anywhere including GitHub Pages, iframes |
| `N > 1` | `scamp-mt.wasm` | page must be [cross-origin isolated](https://web.dev/coop-coep/) |
| `'auto'` | MT if isolated, else ST | picks best available at load time |

To enable the multi-threaded build you must serve:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Any cross-origin subresources on the same page must send
`Cross-Origin-Resource-Policy: cross-origin` (or CORS), or use
`Cross-Origin-Embedder-Policy: credentialless` for a softer alternative.

Requesting `threads > 1` on a non-isolated page makes `SCAMP.create()`
throw immediately with a message pointing here.

## Known limitations (v0.1)

These are documented rather than fixed. See
[`notes/`](notes/) for design discussions of future work.

### `onProgress` / `onSnapshot` in the MT build

Both hooks are **no-ops in the multi-threaded build**. In MT the compute
runs on a proxied pthread while the JS main thread services messages;
progress callbacks fire from worker pthreads via `emscripten::val`,
which deadlocks the main-pthread proxy in this configuration. The ST
build fires both callbacks between tiles as expected.

Workaround / future fix: expose the profile via a `SharedArrayBuffer`
view and let the page main thread poll on `requestAnimationFrame`. See
[`notes/left-right-matrix-profile.md`](notes/) for the pattern (used
for a different feature but the SAB-view approach is the same).

### `AbortSignal` in the ST build

Aborts are delivered as a message to the inner Web Worker. In ST that
worker's JS thread is **synchronously blocked inside `Module.runSCAMP`**
until the whole run completes, so the abort message queues up and
doesn't reach `abortSCAMP()` until the compute would have finished
anyway. In MT, `PROXY_TO_PTHREAD` puts the compute on a separate
pthread and the worker's initial thread stays free to service abort
messages promptly (latency ≈ 1 tile).

Workaround / future fix: same SAB approach as above — the abort flag
becomes a shared atomic that C++ polls directly, bypassing the JS
message queue.

### First-run cost (JIT warm-up + heap growth)

The first `.run()` after `SCAMP.create()` is noticeably slower than
subsequent calls (typical: 2× warm run for the first iteration). Causes:

- V8 wasm tier-up (Liftoff → TurboFan) hasn't happened yet.
- In MT, each pthread worker still has to instantiate its own copy of
  the wasm module.
- Heap growth from `INITIAL_MEMORY=256MB` to whatever the run needs
  (mitigated but not eliminated by the higher initial value).

Not fixed. A warm-up call inside `SCAMP.create()` (one tiny throwaway
run) would hide this cost but is left as an application-level concern.

### KNN profile type is GPU-only

Upstream SCAMP: *"CPU Support ... does not support KNN joins yet"*.
Wasm is CPU-only, so `profileType: 'KNN'` throws
`SCAMP_FUNCTIONALITY_UNIMPLEMENTED`. Use `SUM_THRESH` or
`MATRIX_SUMMARY` instead for multi-neighbour analyses.

### Wasm heap ceiling

Wasm32 addresses are 32-bit → 4 GB hard limit for any wasm build.
In practice browsers cap tabs at ~2 GB usable. For SCAMP, the O(n²)
*time* cost bites well before the 4 GB memory cost, so this is rarely
the binding constraint. wasm64 exists but is not used here (see
[`notes/`](notes/) for a broader discussion).

## Performance

We ship a multi-runtime benchmark script that runs the same 4 profile
types SCAMP's upstream CI benchmarks on native + Node + Bun:

```bash
wasm/bench/run.sh 5       # 5 iterations (default)
```

Numbers from an M-series Mac (n=32768, w=100, threads=1, double
precision, medians of 5 iters):

| Benchmark | native ARM | Node wasm | Bun wasm | (CI x86 AVX2) |
|---|---|---|---|---|
| 1NN_INDEX | 0.834 s | 0.897 s (1.08×) | 0.943 s (1.13×) | 0.555 s |
| 1NN | 0.249 s | 0.352 s (1.41×) | 0.321 s (1.29×) | 0.236 s |
| SUM_THRESH | 0.371 s | 0.363 s (0.98×) | 0.386 s (1.04×) | 0.320 s |
| MATRIX | 2.29 s | 1.176 s (0.51×) | 1.868 s (0.82×) | 1.095 s |

`(1.x×)` = wasm-runtime slower than native on the same machine.

Two phases of wasm SIMD got us here:

1. **Phase 1** (`-msimd128 -msse4.2`): triggers Eigen's SSE2 path
   (Packet2d) via Emscripten's `<xmmintrin.h>` etc. shim. 1.4–2.4×
   speedup over scalar wasm.
2. **Phase 2** (`-mavx`): triggers Eigen's AVX path (Packet4d, lowered
   to pairs of 128-bit wasm SIMD ops). Marginal on V8 (~3%), meaningful
   on JSC (~14% on MATRIX).

Phase 3 (hand-written wasm SIMD kernel or `-mrelaxed-simd` for FMA)
is not pursued — the remaining gap to native is bounded by wasm's
lack of true 256-bit / AVX2 support, which no source-level trick can
close.

## What's excluded from the wasm build

`-DSCAMP_BUILD_WASM=ON` skips:
- CUDA (GPU kernels).
- gRPC + distributed client/server (`src/distributed`).
- pybind11 Python module (`src/python`).
- gflags-based CLI (`src/main.cpp`).
- Native x86 AVX/AVX2 kernel dispatch (uses `baseline` kernel with wasm SIMD flags instead).
- Benchmarks and C++ tests.

Only these libraries end up in the wasm binary: `common`, `profile`,
`scamp_args`, `scamp_op`, `tile`, `qt_helper`, `cpu_stats`,
`cpu_kernels/baseline`.

## Layout

```
wasm/
├── .emsdk-version              pinned emsdk (used by setup.sh)
├── setup.sh                    installs emsdk locally under wasm/emsdk/
├── build.sh                    builds ST + MT into dist/
├── serve.mjs                   local static server with COOP/COEP headers
├── CMakeLists.txt              Emscripten target; wired via -DSCAMP_BUILD_WASM=ON
├── src/bindings.cpp            embind entrypoint (runSCAMP, abortSCAMP, getSnapshot)
├── js/
│   ├── scamp.js                UMD wrapper (spawns the worker, sugar helpers)
│   ├── scamp.worker.js         Worker that hosts the wasm module
│   └── scamp.d.ts              TypeScript declarations
├── demo/
│   ├── index.html              self-join demo with live snapshot plot (ST)
│   └── benchmark.html          CPU benchmark UI (4 profile types)
├── bench/
│   ├── run.sh                  multi-runtime bench (native + Node + Bun)
│   └── bench.mjs               wasm-only benchmark driver
├── test/
│   ├── node-smoke.mjs          self + AB-join + all profile types
│   └── correctness.mjs         diff wasm vs native SCAMP CLI output
├── notes/                      design/future-work docs
└── dist/                       build output
```

## ClickHouse UDF variant

Built alongside `dist/scamp-st.wasm` as `dist/scamp_ch_udf.wasm` —
a **fully self-contained** wasm module (zero unresolved imports) exposing
SCAMP self-join through ClickHouse's
[BUFFERED_V1 wasm UDF ABI](https://clickhouse.com/docs/sql-reference/functions/wasm_udf).
**Verified end-to-end** inside `clickhouse/clickhouse-server:head`
(v26.7): motif recovery matches native SCAMP, 9 ms for 3 parallel
self-joins via `GROUP BY subject`. No ClickHouse patching required.
See [`clickhouse/README.md`](clickhouse/README.md) for the full recipe,
wire format, and how the WASI stubs eliminate unresolved imports at
build time.

## Notes / future work

- [`notes/left-right-matrix-profile.md`](notes/left-right-matrix-profile.md)
  — SCAMP support for left/right (causal) matrix profiles, with an
  aside on rolling-window variants.
- [`notes/algorithms-momp-madrid.md`](notes/algorithms-momp-madrid.md)
  — What MOMP and MADRID are, why MOMP would unlock ~100× larger
  datasets on top of SCAMP-wasm.
- [`notes/momp-on-scamp-wasm.md`](notes/momp-on-scamp-wasm.md)
  — Concrete pitch for MOMP-on-scamp-wasm as the next high-leverage
  feature.
- [`notes/publishing-infra.md`](notes/publishing-infra.md)
  — CI, npm publish, repository extraction: deferred items.
