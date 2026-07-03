# wasm/clickhouse/CMakeLists.txt — build a ClickHouse-loadable wasm UDF
# module wrapping SCAMP.
#
# The module exports the ClickHouse BUFFERED_V1 ABI:
#   - clickhouse_create_buffer(size)
#   - clickhouse_destroy_buffer(handle)
#   - scamp_selfjoin_1nn(span, n)
#
# NOTE: this target uses `-sSTANDALONE_WASM=1` and forbids the JS glue, but
# because SCAMP's core uses std::vector, exceptions, and mutex the resulting
# wasm still imports symbols from `wasi_snapshot_preview1`. Loading it in
# ClickHouse's wasmtime host as-is will fail on missing imports. Two paths
# forward, see wasm/clickhouse/README.md.

if (NOT EMSCRIPTEN)
  message(FATAL_ERROR "wasm/clickhouse can only be configured with Emscripten (use emcmake).")
endif()

add_executable(scamp_ch_udf ${CMAKE_CURRENT_SOURCE_DIR}/src/scamp_ch_udf.cpp)

target_include_directories(scamp_ch_udf PRIVATE ${CMAKE_SOURCE_DIR}/src)

target_link_libraries(scamp_ch_udf PRIVATE
  scamp_interface
  scamp_args
  scamp_op
  common
  profile
)

# Standalone wasm: no JS glue, direct load by wasmtime/browsers.
set(SCAMP_CH_LINK_FLAGS
  "-sSTANDALONE_WASM=1"
  "-sERROR_ON_UNDEFINED_SYMBOLS=0"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sINITIAL_MEMORY=64MB"
  "-sMAXIMUM_MEMORY=1GB"
  "-sSUPPORT_LONGJMP=0"
  "-Wl,--no-entry"
  "-Wl,--export=clickhouse_create_buffer"
  "-Wl,--export=clickhouse_destroy_buffer"
  "-Wl,--export=scamp_selfjoin_1nn"
  "-Wl,--export=__heap_base"
  "-Wl,--export=__data_end"
  "-O3"
)
string(REPLACE ";" " " SCAMP_CH_LINK_FLAGS_STR "${SCAMP_CH_LINK_FLAGS}")

set_target_properties(scamp_ch_udf PROPERTIES
  OUTPUT_NAME "scamp_ch_udf"
  SUFFIX ".wasm"
  LINK_FLAGS "${SCAMP_CH_LINK_FLAGS_STR}"
)
