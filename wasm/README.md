# SCAMP-wasm

WebAssembly build of [SCAMP](../README.md) — GPU/CPU matrix profile —
producing single-threaded and multi-threaded browser + Node bundles from
the same C++ core.

## Quick start

```bash
cd wasm
./setup.sh                # installs a pinned emsdk under wasm/emsdk/
./build.sh both           # builds ST + MT into wasm/dist/
npm test                  # Node smoke test
```

Open the demo:

```bash
npm run serve:demo        # http://localhost:8080/demo/
```

## Using it

Drop `dist/scamp.js` (and its sibling `dist/scamp-*.js`, `dist/*.wasm`,
`dist/scamp.worker.js`) onto a static host and:

```html
<script src="/path/to/scamp.js"></script>
<script type="module">
  const scamp = await SCAMP.create({
    threads: 'auto',        // 'auto' | 1 | N
    baseUrl: '/path/to/',   // where the sibling .js/.wasm live
  });

  const a = new Float64Array(4096);
  // ... fill a ...

  const abortCtrl = new AbortController();
  const result = await scamp.run(
    { a, window: 128, profileType: '1NN_INDEX', precision: 'double' },
    {
      onProgress: (done, total) => console.log(`${done}/${total}`),
      signal: abortCtrl.signal,
    }
  );
  // result.a.profile: Float32Array, result.a.index: Int32Array
</script>
```

The wasm module is hosted inside a dedicated Web Worker (owned by the
library) so `scamp.run(...)` never blocks the calling thread, regardless
of whether the ST or MT build is in use.

## Threading modes

| `threads` value | Build used | Requirements |
|---|---|---|
| `1` (default when not isolated) | `scamp-st.wasm` | none — works anywhere including GitHub Pages, iframes |
| `N > 1` | `scamp-mt.wasm` | page must be [cross-origin isolated](https://web.dev/coop-coep/) — COOP + COEP headers |
| `'auto'` | MT if isolated, else ST | picks best available at load time |

To enable the multi-threaded build you must serve:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Any cross-origin subresources on the same page must send
`Cross-Origin-Resource-Policy: cross-origin` (or CORS), or you can use
`Cross-Origin-Embedder-Policy: credentialless` as a softer alternative.

If you request `threads > 1` on a non-isolated page, `SCAMP.create()`
throws immediately with a message pointing to this section.

## API surface

Mirrors [pyscamp](../src/python). All profile types are exposed:

| `profileType` | Result shape |
|---|---|
| `'1NN_INDEX'` (default) | `{ profile: Float32Array, index: Int32Array }` |
| `'1NN'` | `{ profile: Float32Array }` |
| `'SUM_THRESH'` | `{ profile: Float64Array }` |
| `'KNN'` | `Array<{ row, col, corr }>` (set `maxMatchesPerColumn`, `threshold`) |
| `'MATRIX_SUMMARY'` | `{ values: Float32Array, height, width }` (set `matrixHeight`, `matrixWidth`) |

See [`js/scamp.d.ts`](js/scamp.d.ts) for the full TypeScript types and
[`src/bindings.cpp`](src/bindings.cpp) for the exact args→C++ mapping.

## Layout

```
wasm/
├── .emsdk-version          pinned emsdk (used by setup.sh)
├── setup.sh                installs emsdk locally under wasm/emsdk/
├── build.sh                builds ST + MT into dist/
├── CMakeLists.txt          Emscripten target; wired in from root CMake via -DSCAMP_BUILD_WASM=ON
├── src/bindings.cpp        embind entrypoint (runSCAMP, abortSCAMP)
├── js/
│   ├── scamp.js            UMD main-thread wrapper (spawns the worker)
│   ├── scamp.worker.js     Worker that hosts the wasm module
│   └── scamp.d.ts          TypeScript declarations
├── demo/index.html         drop-in <script src> demo
├── test/node-smoke.mjs     Node smoke test
└── dist/                   build output (gitignored)
```

## What's excluded from the wasm build

The `SCAMP_BUILD_WASM=ON` CMake option skips:
- CUDA (GPU kernels): not applicable to wasm.
- gRPC + distributed client/server (`src/distributed`).
- pybind11 Python module (`src/python`).
- gflags-based CLI (`src/main.cpp`).
- AVX/AVX2 CPU kernels (x86-only; the wasm-friendly `baseline` kernel is used).
- `SCAMP_ENABLE_BINARY_DISTRIBUTION`, benchmarks, C++ tests.

Only the core libraries (`common`, `profile`, `scamp_args`, `scamp_op`,
`tile`, `qt_helper`, `cpu_stats`, `cpu_kernels/baseline`) are linked.

## Known limitations (v0.1)

- **Progress callbacks fire only in the single-threaded build.**
  Emscripten's `emscripten::val` cannot safely be invoked from a worker
  pthread while the main pthread is blocked on `future.get()`. The MT
  build silently no-ops the `onProgress` hook. Tracked as follow-up:
  expose a `getProgress()` reading a shared atomic counter that the
  outer page can poll directly via `HEAP32`.
- **`AbortSignal` in the MT build** relies on JS message delivery to the
  inner worker between tile boundaries; because the worker's initial
  thread also services the compute proxy, cancellation latency is at
  the granularity of one tile (typically << 1s).
- **No wasm SIMD yet.** Only the scalar `baseline` CPU kernel is
  compiled. A `-msimd128` dispatch is the obvious next optimisation.

## Perf notes

- ST wasm ≈ 1.5–3× slower than native single-threaded CPU baseline.
- MT wasm scales close to linearly with `threads` on tile-heavy inputs.
- Future work: wasm SIMD128 dispatch (`-msimd128`) alongside the
  scalar `baseline` kernel for another 2–4× on the inner loops.
