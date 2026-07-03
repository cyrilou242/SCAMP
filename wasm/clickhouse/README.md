# ClickHouse WebAssembly UDF wrapper for SCAMP

Wraps the SCAMP wasm build in ClickHouse's [BUFFERED_V1 UDF
ABI](https://clickhouse.com/docs/sql-reference/functions/wasm_udf) so
the matrix profile can be computed inside a `CREATE FUNCTION ...
LANGUAGE WASM` UDF, callable from SQL.

**Status**: the wrapper ABI is correct — the produced wasm module can
be loaded and invoked from any wasmtime-compatible host, and returns
numeric output matching native SCAMP to fp-precision (~2e-7). It does
**not** load in real ClickHouse today because of a WASI-imports gap
described below.

## What's built

- `src/scamp_ch_udf.cpp` — C-ABI wrapper.
- `dist/scamp_ch_udf.wasm` — a ~260 KB standalone wasm module.

Exports (per BUFFERED_V1):

| Symbol | Signature | Purpose |
|---|---|---|
| `clickhouse_create_buffer` | `(size: u32) -> u32` | Allocates a `ClickhouseBuffer { u8* data; u32 size }` and returns its address. |
| `clickhouse_destroy_buffer` | `(handle: u32)` | Frees the buffer + its data. |
| `scamp_selfjoin_1nn` | `(span: u32, n: u32) -> u32` | The actual UDF. `n` is the row count in the input block. |

## Wire format

The wrapper uses ClickHouse's `RowBinary` serialisation format. For the
declared UDF signature

```
ARGUMENTS (ts Array(Float64), window UInt32)
RETURNS Tuple(Array(Float32), Array(Int32))
```

each row is:

- **input**  `varUInt(len) + double[len] + uint32(window)`
- **output** `varUInt(m) + float[m] + varUInt(m) + int32[m]`  where `m = len - window + 1`

Rows are concatenated for `n > 1`. The wrapper doesn't yet batch or
vectorise across rows — each row runs its own SCAMP self-join.

## SQL declaration (target syntax)

```sql
INSERT INTO system.webassembly_modules (name, code)
SELECT 'scamp', code FROM input('code String') FORMAT RawBlob;
-- (with scamp_ch_udf.wasm bytes piped in)

CREATE FUNCTION scamp_selfjoin_1nn
    LANGUAGE WASM ABI BUFFERED_V1
    FROM 'scamp' :: 'scamp_selfjoin_1nn'
    ARGUMENTS (ts Array(Float64), window UInt32)
    RETURNS Tuple(Array(Float32), Array(Int32))
    SETTINGS
        serialization_format = 'RowBinary',
        webassembly_udf_enable_fuel = false;

SET webassembly_udf_max_memory = 268435456;   -- 256 MB, bumped for larger series
```

Then:

```sql
SELECT (scamp_selfjoin_1nn(values, 128 :: UInt32) AS r).1 AS profile,
       r.2 AS indices
FROM (SELECT groupArray(v) AS values FROM my_timeseries WHERE subject = 42);
```

## Building

Built automatically alongside the ST wasm target:

```bash
wasm/setup.sh                # first time only
wasm/build.sh st             # produces wasm/dist/scamp_ch_udf.wasm
```

## Testing

```bash
node wasm/clickhouse/test/test_udf.mjs
```

The test harness:

1. Loads `scamp_ch_udf.wasm` with a minimal stub for the WASI /
   Emscripten imports (see below).
2. Allocates + frees a buffer to exercise the allocator.
3. Encodes a synthetic time series with a planted motif into
   `RowBinary`, calls `scamp_selfjoin_1nn`, decodes the result.
4. Verifies motif recovery (`index[200] ≈ 600`).
5. If `build-native-bench/SCAMP` exists, cross-checks the numeric
   output against a native SCAMP CLI run on the same input.

Latest run: motif recovered exactly, max distance diff vs native
`2.34e-7`, zero index mismatches. 260 KB wasm, 4 ms UDF invocation for
n=1024 / w=64.

## The WASI-imports gap

The wasm module currently imports 6 symbols that ClickHouse's wasmtime
host doesn't provide by default:

```
env.emscripten_notify_memory_growth
wasi_snapshot_preview1.clock_time_get
wasi_snapshot_preview1.fd_write
wasi_snapshot_preview1.fd_seek
wasi_snapshot_preview1.fd_read
wasi_snapshot_preview1.fd_close
```

Root cause: SCAMP's core uses `std::vector`, `std::chrono`, C++
exceptions, and iostream fallbacks in libc++. Emscripten's
`-sSTANDALONE_WASM=1` mode preserves the code path but leaves those
symbols as unresolved imports for the host to satisfy.

ClickHouse's wasm host provides only:

```
clickhouse_server_version
clickhouse_throw
clickhouse_log
clickhouse_random
env.abort            (AssemblyScript compat)
```

Attempting to instantiate the module inside a real ClickHouse instance
would fail with a "missing import" error at `CREATE FUNCTION` time.

### How to close the gap

Three approaches, in decreasing effort:

1. **Provide the WASI imports host-side** — patch ClickHouse's wasmtime
   engine to also link `wasmtime-wasi`. Small (~50 LOC) but requires
   upstream buy-in.
2. **Post-process the wasm** with a WASI-shim tool (e.g. `wasi-shim`
   or the `wasmtime-wasi-preview1-adapter`) that inlines stub
   implementations of the imports. Doable today without ClickHouse
   changes. Grows the binary by ~30 KB.
3. **Extract a libc-free SCAMP kernel** — a fresh `wasm32-unknown-unknown`
   build target that uses raw arrays, no exceptions, no iostream, no
   `std::chrono`. Clean but a real engineering project (~1–2 weeks).

The test harness in `test/test_udf.mjs` shows what approach (1) would
look like at runtime — it provides no-op stubs for those 6 imports
and demonstrates the module works correctly under them.

## Limitations of the current wrapper

- **Single-threaded**. ClickHouse's wasm runtime doesn't support wasm
  pthreads. This is a hard constraint of the host, not the wrapper.
- **Memory-bound by the host budget**. Default `webassembly_udf_max_memory`
  = 128 MB — needs to be raised for series longer than ~5–10k points.
- **Only self-join 1NN_INDEX** is exposed. Other profile types
  (`1NN`, `SUM_THRESH`, `MATRIX_SUMMARY`) and AB-joins are
  straightforward extensions: same wrapper shape, different
  `SCAMPArgs` fields + different output serialisation. Left as
  follow-up.
- **Fuel accounting disabled** in the SQL declaration
  (`webassembly_udf_enable_fuel = false`). SCAMP consumes far more
  wasm instructions than the default 100k budget; enabling fuel would
  require raising the limit dramatically (100M+ for realistic input
  sizes) or disabling it. The recommended production configuration
  is to leave fuel off and rely on `webassembly_udf_max_memory` and
  wall-clock timeouts for containment.

## Layout

```
wasm/clickhouse/
├── CMakeLists.txt              Emscripten build target
├── README.md                   this file
├── src/
│   └── scamp_ch_udf.cpp        C-ABI wrapper (RowBinary codec + SCAMP call)
└── test/
    └── test_udf.mjs            Node harness: instantiate + invoke + verify
```
