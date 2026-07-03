#!/usr/bin/env bash
# Builds the single-threaded and multi-threaded WebAssembly variants of
# SCAMP and stages the artifacts under wasm/dist/ next to the hand-written
# JS glue and demo.
#
# Usage: wasm/build.sh [st|mt|both]   (default: both)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
EMSDK_DIR="${HERE}/emsdk"
DIST_DIR="${HERE}/dist"
MODE="${1:-both}"

if [[ ! -d "${EMSDK_DIR}" ]]; then
  echo "emsdk not found. Run wasm/setup.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1091
source "${EMSDK_DIR}/emsdk_env.sh"

build_variant() {
  local variant="$1"       # st | mt
  local threads_flag       # ON | OFF
  local build_dir="${HERE}/build-${variant}"
  case "${variant}" in
    st) threads_flag=OFF ;;
    mt) threads_flag=ON ;;
    *) echo "unknown variant ${variant}" >&2; exit 2 ;;
  esac

  echo
  echo "===================================================="
  echo "  Building SCAMP wasm (${variant})"
  echo "===================================================="

  rm -rf "${build_dir}"
  mkdir -p "${build_dir}"

  ( cd "${build_dir}" && emcmake cmake "${ROOT}" \
      -DCMAKE_BUILD_TYPE=Release \
      -DSCAMP_BUILD_WASM=ON \
      -DSCAMP_WASM_THREADS="${threads_flag}" \
      -DFORCE_NO_CUDA=ON \
      -DBUILD_CLIENT_SERVER=OFF \
      -DBUILD_PYTHON_MODULE=OFF \
      -DBUILD_BENCHMARKS=OFF \
      -DBUILD_SCAMP_TESTS=OFF \
      -DSCAMP_ENABLE_BINARY_DISTRIBUTION=OFF )

  cmake --build "${build_dir}" -j

  mkdir -p "${DIST_DIR}"
  cp "${build_dir}/wasm/scamp-${variant}.js"   "${DIST_DIR}/"
  cp "${build_dir}/wasm/scamp-${variant}.wasm" "${DIST_DIR}/"
  if [[ "${variant}" == "mt" ]]; then
    # Emscripten emits an auxiliary worker JS in MT mode.
    if [[ -f "${build_dir}/wasm/scamp-mt.worker.js" ]]; then
      cp "${build_dir}/wasm/scamp-mt.worker.js" "${DIST_DIR}/"
    fi
  fi
  # The ClickHouse UDF variant is a byproduct of the ST configure.
  if [[ "${variant}" == "st" && -f "${build_dir}/wasm/clickhouse/scamp_ch_udf.wasm" ]]; then
    cp "${build_dir}/wasm/clickhouse/scamp_ch_udf.wasm" "${DIST_DIR}/"
  fi
}

case "${MODE}" in
  st)   build_variant st ;;
  mt)   build_variant mt ;;
  both) build_variant st; build_variant mt ;;
  *) echo "usage: $0 [st|mt|both]" >&2; exit 2 ;;
esac

# Stage the hand-written JS glue + typings alongside the wasm artifacts.
cp "${HERE}/js/scamp.js"        "${DIST_DIR}/"
cp "${HERE}/js/scamp.worker.js" "${DIST_DIR}/"
cp "${HERE}/js/scamp.d.ts"      "${DIST_DIR}/"

# Mark dist/ as CommonJS so Node's require(esm) auto-detection doesn't
# mis-classify our UMD wrapper (which relies on `module.exports`) as ESM.
cat > "${DIST_DIR}/package.json" <<'JSON'
{
  "type": "commonjs"
}
JSON

echo
echo "Artifacts in: ${DIST_DIR}"
ls -lh "${DIST_DIR}"
