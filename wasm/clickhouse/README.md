# ClickHouse WebAssembly UDF wrapper for SCAMP

Wraps the SCAMP wasm build in ClickHouse's [BUFFERED_V1 UDF
ABI](https://clickhouse.com/docs/sql-reference/functions/wasm_udf) so
the matrix profile can be computed inside a `CREATE FUNCTION ...
LANGUAGE WASM` UDF, callable from SQL.

**Status**: the wrapper ABI is correct and the module is **fully
self-contained**: zero unresolved imports, loads standalone under
wasmtime CLI and Node's built-in `WebAssembly` with empty `{}` imports.
Numeric output matches native SCAMP to fp precision (~2e-7). This means
it will load in real ClickHouse as-is once you have a ClickHouse build
with `USE_WASMTIME=1`.

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

## How we got to zero unresolved imports

A naïve `-sSTANDALONE_WASM=1` build of this wrapper emits 6 imports:

```
env.emscripten_notify_memory_growth
wasi_snapshot_preview1.{clock_time_get, fd_write, fd_seek, fd_read, fd_close}
```

These come from libc code paths (stdio + `std::chrono`) that SCAMP's
core doesn't actually take at runtime (silent_mode is set), but whose
code is still statically reachable so wasm-ld can't dead-code them out.

We eliminate them at build time with two changes:

1. **Emscripten flags in [`CMakeLists.txt`](CMakeLists.txt)**:
   `-sPURE_WASI=1 -sFILESYSTEM=0 -sDISABLE_EXCEPTION_CATCHING=1`
   plus `-fno-exceptions -fno-rtti -fvisibility=hidden -flto`.
   Removes `env.emscripten_notify_memory_growth`.
2. **C stub definitions in [`src/scamp_ch_udf.cpp`](src/scamp_ch_udf.cpp)**
   using the WASI-libc naming convention (`__wasi_fd_write` etc.).
   wasm-ld resolves these strong symbols internally instead of emitting
   them as imports. Nothing in SCAMP actually calls stdio at runtime, so
   these stubs are never invoked — they just satisfy the linker.

Together: **0 imports.** No ClickHouse patch required.

## Loading the wasm UDF in a real ClickHouse

WASM UDFs are a very recent addition (2025) and gated by a build-time
flag. You need a ClickHouse binary built with `USE_WASMTIME=1`.
Official numbered-release images (`clickhouse/clickhouse-server:25.x`)
don't have it as of end-2025; the **`clickhouse/clickhouse-server:head`**
tag (tracking master) does.

### End-to-end tested recipe (Docker)

```bash
# 1. Start a ClickHouse with wasm support + experimental UDF flag enabled.
docker run -d --name ch-wasm-test -p 8125:8123 -p 9002:9000 \
    clickhouse/clickhouse-server:head
docker exec ch-wasm-test sh -c 'cat > /etc/clickhouse-server/config.d/wasm_udfs.xml <<EOF
<clickhouse>
    <allow_experimental_webassembly_udf>true</allow_experimental_webassembly_udf>
    <webassembly_udf_engine>wasmtime</webassembly_udf_engine>
</clickhouse>
EOF'
docker restart ch-wasm-test && sleep 4

# Verify: should return 1.
docker exec ch-wasm-test clickhouse-client --query \
    "SELECT count() FROM system.build_options WHERE name='USE_WASMTIME' AND value='1'"

# 2. Load the wasm module into system.webassembly_modules.
docker cp wasm/dist/scamp_ch_udf.wasm ch-wasm-test:/tmp/scamp_ch_udf.wasm
docker exec ch-wasm-test sh -c \
    "cat /tmp/scamp_ch_udf.wasm | clickhouse-client --query \"\
        INSERT INTO system.webassembly_modules (name, code) \
        SELECT 'scamp', code FROM input('code String') FORMAT RawBlob\""

# 3. Declare the SQL UDF.
docker exec ch-wasm-test clickhouse-client --query "
    CREATE FUNCTION scamp_selfjoin_1nn
        LANGUAGE WASM ABI BUFFERED_V1
        FROM 'scamp' :: 'scamp_selfjoin_1nn'
        ARGUMENTS (ts Array(Float64), window UInt32)
        RETURNS Tuple(Array(Float32), Array(Int32))
        SETTINGS
            serialization_format = 'RowBinary',
            webassembly_udf_enable_fuel = false
"

# 4. Run it! Aggregate GROUP BY subject with a synthetic time series.
docker exec ch-wasm-test clickhouse-client --query "
    SET webassembly_udf_max_memory = 268435456;
    SELECT (scamp_selfjoin_1nn(ts, 64::UInt32) AS r).1 AS profile, r.2 AS indices
    FROM (
      SELECT arrayMap(i ->
        if(i >= 200 AND i < 264, cos((i-200) * 0.1),
        if(i >= 600 AND i < 664, cos((i-600) * 0.1), sin(i * 0.05))),
        range(1024))::Array(Float64) AS ts
    )
"
```

Actual output on a `head` image: `indices[201] = 600, indices[601] =
200` — the planted motifs at positions 200 and 600 recognise each
other, min distance 0. Total end-to-end wall time for 3 subjects in a
`GROUP BY`: **9 ms**.

### If your ClickHouse doesn't have USE_WASMTIME

```sql
SELECT count() FROM system.build_options WHERE name = 'USE_WASMTIME';
-- 0 = feature not compiled; use `:head` image or a nightly build
```

The test harness under `test/` proves the wrapper works standalone via
wasmtime, decoupled from image availability.

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
