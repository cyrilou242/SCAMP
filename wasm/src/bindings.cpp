// wasm/src/bindings.cpp — Emscripten embind entrypoint for SCAMP.
//
// Design notes:
// - We deliberately keep the surface small and self-describing: a single
//   runSCAMP(argsObj, onProgress?) function driven by a JS object mirroring
//   SCAMPArgs, plus abortSCAMP() and the enum tables. Higher-level ergonomic
//   helpers (selfJoin, abJoin, ...) live in js/scamp.js — keeping them in
//   JavaScript avoids a combinatorial explosion of C++ overloads for
//   1NN/SUM/KNN/MATRIX × self/AB.
// - Progress + abort go through a single-op singleton. The worker-hosted
//   architecture (see js/scamp.worker.js) guarantees only one run at a
//   time, which lets us avoid handle plumbing entirely.

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>
#include <emscripten/val.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "common/common.h"
#include "common/profile.h"
#include "common/scamp_args.h"
#include "common/scamp_utils.h"
#include "core/SCAMP.h"

using emscripten::val;

namespace {

// ------------------------------------------------------------------
// Singleton state for the currently-running op. Enables abort() from
// another JS context (in the MT build, the compute runs on a pthread
// while JS remains responsive on the main pthread; in ST, abort is
// only reachable from the progress callback which we invoke between
// tiles). g_active_args lets getSnapshot() reach into the live profile
// mid-computation for the demo's anytime plot.
// ------------------------------------------------------------------
std::mutex g_run_mu;
SCAMP::SCAMP_Operation* g_active_op = nullptr;
SCAMP::SCAMPArgs* g_active_args = nullptr;
bool g_active_pearson = false;

class ActiveOpGuard {
 public:
  ActiveOpGuard(SCAMP::SCAMP_Operation* op, SCAMP::SCAMPArgs* args, bool pearson) {
    std::lock_guard<std::mutex> lk(g_run_mu);
    g_active_op = op;
    g_active_args = args;
    g_active_pearson = pearson;
  }
  ~ActiveOpGuard() {
    std::lock_guard<std::mutex> lk(g_run_mu);
    g_active_op = nullptr;
    g_active_args = nullptr;
  }
  ActiveOpGuard(const ActiveOpGuard&) = delete;
  ActiveOpGuard& operator=(const ActiveOpGuard&) = delete;
};

// ------------------------------------------------------------------
// JS <-> C++ helpers.
// ------------------------------------------------------------------

std::vector<double> jsArrayToDoubleVec(const val& arr) {
  const unsigned n = arr["length"].as<unsigned>();
  std::vector<double> out(n);
  // Fast path: TypedArray copy via emscripten's typed_memory_view.
  val heap = val::module_property("HEAPF64");
  val memory_view =
      val(emscripten::typed_memory_view(n, out.data()));
  memory_view.call<void>("set", arr);
  return out;
}

bool jsHas(const val& obj, const char* key) {
  return obj.hasOwnProperty(key) && !obj[key].isUndefined() &&
         !obj[key].isNull();
}

template <typename T>
T jsGetOr(const val& obj, const char* key, T fallback) {
  if (!jsHas(obj, key)) return fallback;
  return obj[key].as<T>();
}

SCAMP::SCAMPProfileType parseProfileType(const std::string& s) {
  if (s == "1NN_INDEX") return SCAMP::PROFILE_TYPE_1NN_INDEX;
  if (s == "1NN") return SCAMP::PROFILE_TYPE_1NN;
  if (s == "SUM_THRESH") return SCAMP::PROFILE_TYPE_SUM_THRESH;
  if (s == "KNN" || s == "APPROX_ALL_NEIGHBORS")
    return SCAMP::PROFILE_TYPE_APPROX_ALL_NEIGHBORS;
  if (s == "MATRIX_SUMMARY") return SCAMP::PROFILE_TYPE_MATRIX_SUMMARY;
  throw std::invalid_argument("Invalid profile type: " + s);
}

SCAMP::SCAMPPrecisionType parsePrecision(const std::string& s) {
  if (s == "single") return SCAMP::PRECISION_SINGLE;
  if (s == "mixed") return SCAMP::PRECISION_MIXED;
  if (s == "double") return SCAMP::PRECISION_DOUBLE;
  if (s == "ultra") return SCAMP::PRECISION_ULTRA;
  throw std::invalid_argument("Invalid precision: " + s);
}

// Split the packed 1NN+INDEX profile (uint64) into distance + index JS
// TypedArrays. `output_pearson` mirrors pyscamp: when false we convert
// Pearson-correlation back to Euclidean distance using the window.
val split1NNIndex(const std::vector<uint64_t>& packed, bool output_pearson,
                  int window) {
  const size_t n = packed.size();
  std::vector<float> nn(n);
  std::vector<int32_t> idx(n);
  for (size_t i = 0; i < n; ++i) {
    SCAMP::mp_entry e;
    e.ulong = packed[i];
    nn[i] = output_pearson ? CleanupPearson(e.floats[0])
                            : ConvertToEuclidean(e.floats[0], window);
    idx[i] = static_cast<int32_t>(e.ints[1]);
  }
  val out = val::object();
  out.set("profile",
          val(emscripten::typed_memory_view(nn.size(), nn.data()))
              .call<val>("slice"));
  out.set("index",
          val(emscripten::typed_memory_view(idx.size(), idx.data()))
              .call<val>("slice"));
  return out;
}

val split1NN(const std::vector<float>& packed, bool output_pearson,
             int window) {
  const size_t n = packed.size();
  std::vector<float> nn(n);
  for (size_t i = 0; i < n; ++i) {
    nn[i] = output_pearson ? CleanupPearson(packed[i])
                            : ConvertToEuclidean(packed[i], window);
  }
  val out = val::object();
  out.set("profile",
          val(emscripten::typed_memory_view(nn.size(), nn.data()))
              .call<val>("slice"));
  return out;
}

val splitSum(const std::vector<double>& packed) {
  val out = val::object();
  out.set("profile",
          val(emscripten::typed_memory_view(packed.size(), packed.data()))
              .call<val>("slice"));
  return out;
}

val splitKNN(std::vector<std::priority_queue<
                 SCAMP::SCAMPmatch, std::vector<SCAMP::SCAMPmatch>,
                 SCAMP::compareMatch>>& matches,
             bool output_pearson, int window) {
  val arr = val::array();
  size_t k = 0;
  for (auto& pq : matches) {
    std::vector<SCAMP::SCAMPmatch> elems;
    elems.reserve(pq.size());
    while (!pq.empty()) {
      elems.push_back(pq.top());
      pq.pop();
    }
    // pyscamp emits in the order they came out of the priority queue;
    // reverse to yield best-first for JS callers.
    for (auto it = elems.rbegin(); it != elems.rend(); ++it) {
      val m = val::object();
      m.set("row", static_cast<int32_t>(it->row));
      m.set("col", static_cast<int32_t>(it->col));
      m.set("corr", output_pearson ? CleanupPearson(it->corr)
                                    : ConvertToEuclidean(it->corr, window));
      arr.set(k++, m);
    }
  }
  return arr;
}

// MATRIX_SUMMARY output: SCAMP writes a flat float vector of length
// (matrix_height * matrix_width) into profile.data[0].float_value. The
// 2D shape lives in args, not on the profile itself — mirrors pyscamp's
// scamp_matrix() (SCAMP_python.cpp:409-411).
val splitMatrix(const std::vector<float>& flat_raw, int height, int width,
                bool output_pearson, int window) {
  std::vector<float> flat(flat_raw.size());
  for (size_t i = 0; i < flat_raw.size(); ++i) {
    flat[i] = output_pearson ? CleanupPearson(flat_raw[i])
                              : ConvertToEuclidean(flat_raw[i], window);
  }
  val out = val::object();
  out.set("values",
          val(emscripten::typed_memory_view(flat.size(), flat.data()))
              .call<val>("slice"));
  out.set("height", height);
  out.set("width", width);
  return out;
}

SCAMP::SCAMPArgs GetDefaultSCAMPArgs() {
  auto profile_type = SCAMP::PROFILE_TYPE_1NN_INDEX;
  SCAMP::SCAMPArgs args;
  args.has_b = false;
  args.max_tile_size = 128000;
  args.distributed_start_row = -1;
  args.distributed_start_col = -1;
  args.distance_threshold = 0;
  args.precision_type = SCAMP::PRECISION_DOUBLE;
  args.profile_type = profile_type;
  args.computing_rows = true;
  args.computing_columns = true;
  args.keep_rows_separate = false;
  args.is_aligned = false;
  args.silent_mode = true;
  args.max_matches_per_column = 5;
  args.matrix_height = 50;
  args.matrix_width = 50;
  args.profile_a.type = profile_type;
  args.profile_b.type = profile_type;
  return args;
}

}  // namespace

// ------------------------------------------------------------------
// Entrypoints
// ------------------------------------------------------------------

// runSCAMP(argsObj, onProgress?) — single monomorphic entrypoint.
//
// argsObj fields (all optional except where noted):
//   a: Float64Array | number[]                (REQUIRED)
//   b: Float64Array | number[]                (required for AB-joins)
//   window: number                            (REQUIRED)
//   hasB: boolean                             (default: b is provided)
//   profileType: '1NN_INDEX'|'1NN'|'SUM_THRESH'|'KNN'|'MATRIX_SUMMARY'
//   precision: 'single'|'mixed'|'double'|'ultra'   (default 'double')
//   pearson: boolean                          (default false → Euclidean)
//   threshold: number                         (default 0)
//   threads: number                           (default: hardwareConcurrency)
//   maxTileSize: number
//   computingRows, computingColumns, keepRowsSeparate, isAligned: bool
//   silent: boolean                           (default true)
//   maxMatchesPerColumn: number               (KNN)
//   matrixHeight, matrixWidth: number         (MATRIX_SUMMARY)
val runSCAMP(val argsObj, val onProgress) {
  if (!jsHas(argsObj, "a"))
    throw std::invalid_argument("Missing required arg 'a'");
  if (!jsHas(argsObj, "window"))
    throw std::invalid_argument("Missing required arg 'window'");

  SCAMP::SCAMPArgs args = GetDefaultSCAMPArgs();
  args.timeseries_a = jsArrayToDoubleVec(argsObj["a"]);
  // JS Numbers are float64, so we marshal all integer args as int and
  // widen on our side. This avoids requiring -sWASM_BIGINT / BigInt.
  args.window = static_cast<uint64_t>(argsObj["window"].as<int>());

  bool has_b = jsHas(argsObj, "b");
  if (has_b) {
    args.timeseries_b = jsArrayToDoubleVec(argsObj["b"]);
    args.has_b = true;
    args.computing_rows = jsGetOr<bool>(argsObj, "computingRows", false);
    args.computing_columns = jsGetOr<bool>(argsObj, "computingColumns", true);
  } else {
    args.timeseries_b = args.timeseries_a;
    args.has_b = false;
    args.computing_rows = jsGetOr<bool>(argsObj, "computingRows", true);
    args.computing_columns = jsGetOr<bool>(argsObj, "computingColumns", true);
  }

  if (jsHas(argsObj, "profileType")) {
    args.profile_type =
        parseProfileType(argsObj["profileType"].as<std::string>());
    args.profile_a.type = args.profile_type;
    args.profile_b.type = args.profile_type;
  }
  if (jsHas(argsObj, "precision")) {
    args.precision_type = parsePrecision(argsObj["precision"].as<std::string>());
  }
  bool pearson = jsGetOr<bool>(argsObj, "pearson", false);
  args.distance_threshold = jsGetOr<double>(argsObj, "threshold", 0.0);
  args.max_tile_size =
      static_cast<uint64_t>(jsGetOr<int>(argsObj, "maxTileSize", 128000));
  args.keep_rows_separate =
      jsGetOr<bool>(argsObj, "keepRowsSeparate", false);
  args.is_aligned = jsGetOr<bool>(argsObj, "isAligned", false);
  args.silent_mode = jsGetOr<bool>(argsObj, "silent", true);
  if (jsHas(argsObj, "maxMatchesPerColumn"))
    args.max_matches_per_column =
        static_cast<int64_t>(argsObj["maxMatchesPerColumn"].as<int>());
  if (jsHas(argsObj, "matrixHeight"))
    args.matrix_height =
        static_cast<int64_t>(argsObj["matrixHeight"].as<int>());
  if (jsHas(argsObj, "matrixWidth"))
    args.matrix_width =
        static_cast<int64_t>(argsObj["matrixWidth"].as<int>());

  int num_threads = jsGetOr<int>(argsObj, "threads", 1);
  if (num_threads < 1) num_threads = 1;

  args.validate();
  if (!args.InitProfileMemory())
    throw std::runtime_error("Failed to init profile memory");

  SCAMP::OptionalArgs opt_args(args.distance_threshold);
  const std::vector<int> devices;  // no GPUs in wasm

  SCAMP::SCAMP_Operation op(
      args.timeseries_a.size(), args.timeseries_b.size(), args.window,
      args.max_tile_size, devices, !args.has_b, args.precision_type,
      args.distributed_start_row, args.distributed_start_col, opt_args,
      args.profile_type, &args.profile_a, &args.profile_b,
      args.keep_rows_separate, args.computing_rows, args.computing_columns,
      args.is_aligned, args.silent_mode, num_threads,
      args.max_matches_per_column, args.matrix_height, args.matrix_width);

  ActiveOpGuard guard(&op, &args, pearson);

  // Wire progress. Only supported in the single-threaded wasm build:
  // emscripten::val is bound to the pthread that constructed it, so
  // invoking the JS callback from worker pthreads (as would happen in
  // the MT build under -pthread) either deadlocks the main-pthread
  // proxy or throws. MT callers can instead poll iteration progress via
  // a future getProgress() API (not yet implemented — see wasm/README.md).
#ifndef __EMSCRIPTEN_PTHREADS__
  if (!onProgress.isNull() && !onProgress.isUndefined() &&
      onProgress.typeOf().as<std::string>() == "function") {
    op.set_progress_callback([onProgress](int done, int total) {
      onProgress(done, total);
    });
  }
#else
  (void)onProgress;
#endif

  if (args.has_b) {
    op.do_join(args.timeseries_a, args.timeseries_b);
  } else {
    op.do_join(args.timeseries_a, args.timeseries_a);
  }

  // Package results based on profile type.
  val result = val::object();
  result.set("profileType",
             std::string(SCAMP::GetProfileTypeString(args.profile_type)));
  result.set("window", static_cast<int32_t>(args.window));

  auto pack_side = [&](SCAMP::Profile& p) -> val {
    switch (args.profile_type) {
      case SCAMP::PROFILE_TYPE_1NN_INDEX:
        return split1NNIndex(p.data[0].uint64_value, pearson, args.window);
      case SCAMP::PROFILE_TYPE_1NN:
        return split1NN(p.data[0].float_value, pearson, args.window);
      case SCAMP::PROFILE_TYPE_SUM_THRESH:
        return splitSum(p.data[0].double_value);
      case SCAMP::PROFILE_TYPE_APPROX_ALL_NEIGHBORS:
        return splitKNN(p.data[0].match_value, pearson, args.window);
      case SCAMP::PROFILE_TYPE_MATRIX_SUMMARY:
        return splitMatrix(p.data[0].float_value,
                           static_cast<int>(args.matrix_height),
                           static_cast<int>(args.matrix_width),
                           pearson, args.window);
      default:
        throw std::runtime_error("Unsupported profile type in output packing");
    }
  };

  result.set("a", pack_side(args.profile_a));
  if (args.keep_rows_separate && args.has_b) {
    result.set("b", pack_side(args.profile_b));
  }
  return result;
}

void abortSCAMP() {
  std::lock_guard<std::mutex> lk(g_run_mu);
  if (g_active_op != nullptr) {
    g_active_op->request_abort();
  }
}

// Snapshot of the currently-running op's profile_a. Intended to be
// called from JS inside a progress callback (ST build only; in MT the
// main pthread is blocked so the JS callback path deadlocks — see
// scamp_wasm's progress-callback limitation in wasm/README.md).
//
// Returns null when no op is running or the profile type doesn't
// support cheap mid-run snapshots (KNN in particular is a per-column
// priority queue; not worth exposing).
val getSnapshot() {
  std::lock_guard<std::mutex> lk(g_run_mu);
  if (g_active_op == nullptr || g_active_args == nullptr) return val::null();
  auto& args = *g_active_args;
  auto& p = args.profile_a;
  const int window = static_cast<int>(args.window);
  switch (args.profile_type) {
    case SCAMP::PROFILE_TYPE_1NN_INDEX:
      return split1NNIndex(p.data[0].uint64_value, g_active_pearson, window);
    case SCAMP::PROFILE_TYPE_1NN:
      return split1NN(p.data[0].float_value, g_active_pearson, window);
    case SCAMP::PROFILE_TYPE_SUM_THRESH:
      return splitSum(p.data[0].double_value);
    case SCAMP::PROFILE_TYPE_MATRIX_SUMMARY:
      return splitMatrix(p.data[0].float_value,
                         static_cast<int>(args.matrix_height),
                         static_cast<int>(args.matrix_width),
                         g_active_pearson, window);
    default:
      return val::null();
  }
}

EMSCRIPTEN_BINDINGS(scamp) {
  emscripten::function("runSCAMP", &runSCAMP);
  emscripten::function("abortSCAMP", &abortSCAMP);
  emscripten::function("getSnapshot", &getSnapshot);
}

// Required by Emscripten's -sPROXY_TO_PTHREAD in the MT build (link
// pulls in crt1_proxy_main which expects a `main` symbol). We disable
// the auto-invocation via -sINVOKE_RUN=0 so this stub never runs — the
// runtime stays alive and embind exports remain callable indefinitely.
int main() { return 0; }
