# wasm/CMakeLists.txt — Emscripten embind bindings for SCAMP.
#
# Assumes the parent CMakeLists.txt has already added src/common and
# src/core subdirectories (which yield the `common`, `profile`,
# `scamp_args`, `scamp_interface`, `scamp_utils`, `scamp_op`, `tile`,
# `qt_helper`, `cpu_stats`, `cpu_kernels`, `kernel_common` targets),
# and that we are being configured through emcmake.

if (NOT EMSCRIPTEN)
  message(FATAL_ERROR "wasm/ can only be configured with the Emscripten toolchain (use emcmake).")
endif()

# The embind entrypoint. Mirrors the pyscamp interface (self/AB join for
# 1NN+INDEX, SUM_THRESH, KNN, MATRIX_SUMMARY) plus progress + abort.
add_executable(scamp_wasm ${CMAKE_CURRENT_SOURCE_DIR}/src/bindings.cpp)

target_include_directories(scamp_wasm PRIVATE ${CMAKE_SOURCE_DIR}/src)

target_link_libraries(scamp_wasm PRIVATE
  scamp_interface
  scamp_args
  scamp_utils
  scamp_op
  common
  profile
)

# Common Emscripten link flags for both ST and MT builds.
set(SCAMP_WASM_LINK_FLAGS
  "-lembind"
  "-sMODULARIZE=1"
  "-sEXPORT_NAME=createSCAMPModule"
  "-sENVIRONMENT=web,worker,node"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sINITIAL_MEMORY=64MB"
  "-sMAXIMUM_MEMORY=4GB"
  "-sEXPORTED_RUNTIME_METHODS=['HEAPF64','HEAPU8','HEAPU32','HEAP32','getExceptionMessage']"
  "-sEXPORT_EXCEPTION_HANDLING_HELPERS=1"
  "-sDISABLE_EXCEPTION_CATCHING=0"
  "-sSTACK_SIZE=5MB"
  "-O3"
)

if (SCAMP_WASM_THREADS)
  # pthread build. Callers must serve COOP/COEP headers so the page is
  # cross-origin-isolated (else SharedArrayBuffer is unavailable and this
  # build refuses to instantiate).
  #
  # INVOKE_RUN=0 keeps the runtime from calling our (stub) main() at
  # startup — main() only exists to satisfy PROXY_TO_PTHREAD's linker
  # requirement; we drive everything through embind exports.
  list(APPEND SCAMP_WASM_LINK_FLAGS
    "-pthread"
    "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency"
    "-sPROXY_TO_PTHREAD=1"
    "-sEXIT_RUNTIME=0"
    "-sINVOKE_RUN=0"
  )
  target_compile_options(scamp_wasm PRIVATE -pthread)
  set(SCAMP_WASM_SUFFIX "-mt")
else()
  set(SCAMP_WASM_SUFFIX "-st")
endif()

# Turn the list into a single space-separated string for LINK_FLAGS.
string(REPLACE ";" " " SCAMP_WASM_LINK_FLAGS_STR "${SCAMP_WASM_LINK_FLAGS}")

set_target_properties(scamp_wasm PROPERTIES
  OUTPUT_NAME "scamp${SCAMP_WASM_SUFFIX}"
  SUFFIX ".js"
  LINK_FLAGS "${SCAMP_WASM_LINK_FLAGS_STR}"
)

# Also propagate -pthread to the linker line for MT (needed to link
# against pthread-aware libc variants).
if (SCAMP_WASM_THREADS)
  target_link_options(scamp_wasm PRIVATE -pthread)
endif()
