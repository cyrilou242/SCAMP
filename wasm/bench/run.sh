#!/usr/bin/env bash
# One-shot comparative benchmark: native (if available), then wasm-st via Node
# and via Bun (if available). All use the same input parameters as the SCAMP
# upstream CI benchmark: n=32768, w=100, tile=1<<17, single thread, double.
#
# Usage: wasm/bench/run.sh [iters]     (default: 5)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
ITERS="${1:-5}"

export SCAMP_BENCH_ITERS="${ITERS}"

hr() { printf -- '=%.0s' {1..70}; printf '\n'; }

# ---------------- native ----------------
hr; echo "[1/3] native (this machine)"; hr
NATIVE_BIN="${ROOT}/build-native-bench/src/benchmark/scamp_cpu_benchmarks"
if [[ ! -x "${NATIVE_BIN}" ]]; then
  echo "Building native benchmark (once)..."
  mkdir -p "${ROOT}/build-native-bench"
  ( cd "${ROOT}/build-native-bench" && cmake "${ROOT}" \
      -DCMAKE_BUILD_TYPE=Release \
      -DFORCE_NO_CUDA=ON \
      -DBUILD_CLIENT_SERVER=OFF \
      -DBUILD_PYTHON_MODULE=OFF \
      -DBUILD_BENCHMARKS=ON > /tmp/scamp-native-cmake.log 2>&1 )
  cmake --build "${ROOT}/build-native-bench" -j --target scamp_cpu_benchmarks \
      > /tmp/scamp-native-build.log 2>&1
fi
"${NATIVE_BIN}" --benchmark_min_time="${ITERS}x" 2>/dev/null | \
  awk '/BM_/ {printf "  %-25s median=%7s s  iters=%s\n", $1, $2, $NF}'

# ---------------- wasm via Node ----------------
hr; echo "[2/3] wasm-st in Node.js"; hr
if [[ ! -f "${ROOT}/wasm/dist/scamp-st.wasm" ]]; then
  echo "wasm dist/ missing. Run wasm/build.sh st (or both) first." >&2
  exit 1
fi
node "${HERE}/bench.mjs"

# ---------------- wasm via Bun ----------------
hr; echo "[3/3] wasm-st in Bun"; hr
BUN_BIN="$(command -v bun || true)"
if [[ -z "${BUN_BIN}" && -x "${HOME}/.bun/bin/bun" ]]; then
  BUN_BIN="${HOME}/.bun/bin/bun"
fi
if [[ -z "${BUN_BIN}" ]]; then
  echo "bun not installed (try: curl -fsSL https://bun.sh/install | bash)"
else
  "${BUN_BIN}" "${HERE}/bench.mjs"
fi

hr; echo "done."; hr
