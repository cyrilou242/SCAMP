#!/usr/bin/env bash
# Installs a pinned emsdk locally under wasm/emsdk/ so wasm builds are
# reproducible and do not depend on any system-wide toolchain. Idempotent:
# re-running just verifies the version and re-activates.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "${HERE}/.emsdk-version" | tr -d '[:space:]')"
EMSDK_DIR="${HERE}/emsdk"

if [[ ! -d "${EMSDK_DIR}" ]]; then
  echo "==> Cloning emsdk into ${EMSDK_DIR}"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "${EMSDK_DIR}"
fi

cd "${EMSDK_DIR}"
echo "==> Installing emsdk ${VERSION}"
./emsdk install "${VERSION}"
./emsdk activate "${VERSION}"

echo
echo "emsdk ${VERSION} ready at ${EMSDK_DIR}"
echo "Source it with:  source ${EMSDK_DIR}/emsdk_env.sh"
