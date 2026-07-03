// ClickHouse WebAssembly UDF wrapper for SCAMP.
//
// Implements the BUFFERED_V1 ABI (see
// https://clickhouse.com/docs/sql-reference/functions/wasm_udf). Exports:
//   - clickhouse_create_buffer(size)
//   - clickhouse_destroy_buffer(handle)
//   - scamp_selfjoin_1nn(span, n) → buffer of packed floats + ints
//
// Wire format used here: `RowBinary`. For a UDF with signature
//   ARGUMENTS (ts Array(Float64), window UInt32)
//   RETURNS Tuple(Array(Float32), Array(Int32))
// the layout is:
//   input  = varUInt(len) + double[len] + uint32(window)
//   output = varUInt(m)   + float[m]    + varUInt(m) + int32[m]
// where m = len - window + 1.
//
// This wrapper does not attempt to be memory-frugal; ClickHouse's per-UDF
// heap budget (webassembly_udf_max_memory) must be raised well above the
// 128 MB default for any non-trivial time series.
//
// Limitations (see README): the resulting wasm still imports symbols from
// `wasi_snapshot_preview1` when built with Emscripten's STANDALONE_WASM,
// because SCAMP's core uses `std::vector`, exceptions, and iostream. That
// keeps the module from loading directly in ClickHouse's wasmtime host
// today. Two paths forward, both documented in the README:
//   1. Provide the WASI imports via a small host-side shim.
//   2. Extract a libc-free SCAMP kernel.

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <new>
#include <vector>

#include "common/common.h"
#include "common/scamp_args.h"
#include "common/scamp_interface.h"
#include "core/SCAMP.h"

// clang-format off

extern "C" typedef struct {
    uint8_t* data;
    uint32_t size;
} ClickhouseBuffer;

// ---------------------------------------------------------------------
// WASI stubs — satisfies the fd_*/clock_time_get imports Emscripten's
// libc emits from otherwise-dead code paths (iostream, std::chrono).
// SCAMP core does include these headers but its output is guarded by
// silent_mode = true; nothing actually calls these at runtime.
//
// By defining strong C symbols with the WASI-libc naming convention
// (`__wasi_<name>`), wasm-ld resolves the calls internally instead of
// emitting them as `wasi_snapshot_preview1.<name>` imports. Net effect:
// zero unresolved imports — the produced wasm loads in any wasm host,
// including ClickHouse's wasmtime engine without any patch to it.
// ---------------------------------------------------------------------
#include <wasi/api.h>

extern "C" {
__attribute__((used)) __wasi_errno_t __wasi_fd_write(__wasi_fd_t, const __wasi_ciovec_t*, size_t, __wasi_size_t* nwritten)   { if (nwritten) *nwritten = 0; return 0; }
__attribute__((used)) __wasi_errno_t __wasi_fd_read (__wasi_fd_t, const __wasi_iovec_t*,  size_t, __wasi_size_t* nread)      { if (nread) *nread = 0; return 0; }
__attribute__((used)) __wasi_errno_t __wasi_fd_seek (__wasi_fd_t, __wasi_filedelta_t, __wasi_whence_t, __wasi_filesize_t* out) { if (out) *out = 0; return 0; }
__attribute__((used)) __wasi_errno_t __wasi_fd_close(__wasi_fd_t)                                                            { return 0; }
__attribute__((used)) __wasi_errno_t __wasi_clock_time_get(__wasi_clockid_t, __wasi_timestamp_t, __wasi_timestamp_t* out)    { if (out) *out = 0; return 0; }
}

namespace {

// ---------------------------------------------------------------------
// RowBinary codec: minimal subset used by our UDF (no strings, no nested
// tuples, no low-cardinality). ClickHouse's varUInt is LEB128.
// ---------------------------------------------------------------------

class Reader {
    const uint8_t* p_;
    const uint8_t* end_;
    bool err_ = false;
public:
    Reader(const uint8_t* p, size_t n) : p_(p), end_(p + n) {}
    bool ok() const { return !err_; }

    uint64_t varUInt() {
        uint64_t v = 0;
        int shift = 0;
        while (p_ < end_) {
            uint8_t b = *p_++;
            v |= uint64_t(b & 0x7f) << shift;
            if ((b & 0x80) == 0) return v;
            shift += 7;
            if (shift > 63) { err_ = true; return 0; }
        }
        err_ = true;
        return 0;
    }

    template <typename T>
    T fixed() {
        if (p_ + sizeof(T) > end_) { err_ = true; return T{}; }
        T v;
        std::memcpy(&v, p_, sizeof(T));
        p_ += sizeof(T);
        return v;
    }

    template <typename T>
    void readFixedArray(std::vector<T>& out, size_t n) {
        if (p_ + n * sizeof(T) > end_) { err_ = true; return; }
        out.resize(n);
        std::memcpy(out.data(), p_, n * sizeof(T));
        p_ += n * sizeof(T);
    }
};

class Writer {
    std::vector<uint8_t> buf_;
public:
    const std::vector<uint8_t>& data() const { return buf_; }
    std::vector<uint8_t> take() { return std::move(buf_); }

    void varUInt(uint64_t v) {
        while (v >= 0x80) {
            buf_.push_back(uint8_t(v) | 0x80);
            v >>= 7;
        }
        buf_.push_back(uint8_t(v));
    }

    template <typename T>
    void fixed(T v) {
        size_t off = buf_.size();
        buf_.resize(off + sizeof(T));
        std::memcpy(buf_.data() + off, &v, sizeof(T));
    }

    template <typename T>
    void writeFixedArray(const T* src, size_t n) {
        size_t off = buf_.size();
        buf_.resize(off + n * sizeof(T));
        std::memcpy(buf_.data() + off, src, n * sizeof(T));
    }
};

// Union that lets us split SCAMP's packed mp_entry (float distance +
// uint32 index) without pulling in the full C++ type from common.h.
union PackedMPEntry {
    float floats[2];
    uint32_t ints[2];
    uint64_t u64;
};

// z-normalised Euclidean distance from Pearson correlation:
//   d = sqrt(2 * m * (1 - r))
float pearsonToEuclidean(float pearson, uint32_t window) {
    float x = 2.0f * float(window) * (1.0f - pearson);
    if (x < 0.0f) x = 0.0f;
    return __builtin_sqrtf(x);
}

}  // namespace

extern "C" {

// Buffer allocator: ClickHouse expects a heap object it can address by
// pointer. We just use `new` — Emscripten's malloc handles the underlying
// wasm memory growth if enabled.
__attribute__((visibility("default")))
ClickhouseBuffer* clickhouse_create_buffer(uint32_t size) {
    auto* buf = new (std::nothrow) ClickhouseBuffer;
    if (!buf) return nullptr;
    if (size == 0) {
        buf->data = nullptr;
        buf->size = 0;
        return buf;
    }
    buf->data = new (std::nothrow) uint8_t[size];
    if (!buf->data) {
        delete buf;
        return nullptr;
    }
    buf->size = size;
    return buf;
}

__attribute__((visibility("default")))
void clickhouse_destroy_buffer(ClickhouseBuffer* buf) {
    if (!buf) return;
    delete[] buf->data;
    delete buf;
}

// ---------------------------------------------------------------------
// UDF entry: self-join 1NN + index.
//
// SQL declaration would look like:
//   CREATE FUNCTION scamp_selfjoin_1nn
//     LANGUAGE WASM ABI BUFFERED_V1
//     FROM 'scamp' :: 'scamp_selfjoin_1nn'
//     ARGUMENTS (ts Array(Float64), window UInt32)
//     RETURNS Tuple(Array(Float32), Array(Int32))
//     SETTINGS serialization_format = 'RowBinary', webassembly_udf_enable_fuel = false;
//
// ClickHouse invokes us once per block. `n` is the row count. In practice
// callers will use this via GROUP BY with an aggregate that produces one
// long array per group, so a typical `n` is 1 — but we handle >1 by
// concatenating outputs row-by-row.
// ---------------------------------------------------------------------
__attribute__((visibility("default")))
ClickhouseBuffer* scamp_selfjoin_1nn(ClickhouseBuffer* span, uint32_t n) {
    if (!span || !span->data) return clickhouse_create_buffer(0);

    Reader r(span->data, span->size);
    Writer w;

    for (uint32_t row = 0; row < n && r.ok(); ++row) {
        uint64_t ts_len = r.varUInt();
        std::vector<double> ts;
        r.readFixedArray(ts, size_t(ts_len));
        uint32_t window = r.fixed<uint32_t>();
        if (!r.ok()) break;
        if (window == 0 || ts_len < window) {
            // Degenerate: emit an empty profile pair.
            w.varUInt(0);
            w.varUInt(0);
            continue;
        }

        SCAMP::SCAMPArgs args;
        args.timeseries_a = ts;
        args.timeseries_b = ts;
        args.window = window;
        args.max_tile_size = 128000;
        args.has_b = false;
        args.distributed_start_row = -1;
        args.distributed_start_col = -1;
        args.distance_threshold = 0;
        args.precision_type = SCAMP::PRECISION_DOUBLE;
        args.profile_type = SCAMP::PROFILE_TYPE_1NN_INDEX;
        args.profile_a.type = args.profile_type;
        args.profile_b.type = args.profile_type;
        args.computing_rows = true;
        args.computing_columns = true;
        args.keep_rows_separate = false;
        args.is_aligned = false;
        args.silent_mode = true;
        args.max_matches_per_column = 1;
        args.matrix_height = 0;
        args.matrix_width = 0;

        // Exceptions are disabled in this build (-fno-exceptions), so
        // rely on SCAMP not throwing for valid input. Precondition: we
        // already validated ts_len >= window above.
        SCAMP::do_SCAMP(&args, /*devices=*/std::vector<int>{}, /*threads=*/1);

        const auto& packed = args.profile_a.data[0].uint64_value;
        const size_t m = packed.size();

        // Distances first (as Array(Float32)).
        w.varUInt(m);
        std::vector<float> dists(m);
        std::vector<int32_t> idxs(m);
        for (size_t i = 0; i < m; ++i) {
            PackedMPEntry e;
            e.u64 = packed[i];
            dists[i] = pearsonToEuclidean(e.floats[0], window);
            idxs[i] = int32_t(e.ints[1]);
        }
        w.writeFixedArray(dists.data(), m);

        // Then indices (as Array(Int32)).
        w.varUInt(m);
        w.writeFixedArray(idxs.data(), m);
    }

    if (!r.ok()) {
        // Return an empty buffer on parse failure; ClickHouse will surface
        // this as a decoder error at the format layer.
        return clickhouse_create_buffer(0);
    }

    auto bytes = w.take();
    auto* out = clickhouse_create_buffer(bytes.size());
    if (out && bytes.size() > 0) {
        std::memcpy(out->data, bytes.data(), bytes.size());
    }
    return out;
}

}  // extern "C"
