// Test harness for the ClickHouse-flavoured wasm UDF.
//
// Loads scamp_ch_udf.wasm with a minimal set of stub imports that stand
// in for what ClickHouse's wasmtime host would supply (WASI + emscripten
// bookkeeping). Then it:
//   1. serialises an input in ClickHouse's RowBinary format
//      (Array(Float64) + UInt32 window)
//   2. calls the exported `scamp_selfjoin_1nn` UDF
//   3. deserialises the RowBinary output
//      (Array(Float32) + Array(Int32))
//   4. verifies motif recovery + numeric agreement vs a native SCAMP
//      run on the same input.
//
// This does NOT prove the module works inside ClickHouse — see the
// README for the remaining WASI-imports gap. It does prove the wrapper
// ABI is correct and that SCAMP produces the same output as native.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '..', '..', 'dist', 'scamp_ch_udf.wasm');
const nativeBin = path.resolve(here, '..', '..', '..', 'build-native-bench', 'SCAMP');

if (!fs.existsSync(wasmPath)) {
  console.error(`not built: ${wasmPath} (run wasm/build.sh st)`);
  process.exit(2);
}

// -----------------------------------------------------------------
// Minimal WASI/emscripten stubs.  Enough to instantiate the module.
// -----------------------------------------------------------------
function makeImports(getMemory) {
  return {
    env: {
      // Emscripten notifies the host after wasm memory has grown so JS
      // views can re-attach. We have no cached views, so no-op.
      emscripten_notify_memory_growth: (_index) => {},
    },
    wasi_snapshot_preview1: {
      // These end up called when the module lazily initialises stdio
      // (from libc++ / iostream). We never actually print, but the
      // symbols must resolve. Returning 0 = success.
      clock_time_get: (_id, _prec, _ptr) => 0,
      fd_write:       (_fd, _iovs, _cnt, nwritten_ptr) => {
        // Report zero bytes written; caller falls through.
        new DataView(getMemory().buffer).setUint32(nwritten_ptr, 0, true);
        return 0;
      },
      fd_read:  () => 0,
      fd_seek:  () => 0,
      fd_close: () => 0,
    },
  };
}

// -----------------------------------------------------------------
// RowBinary codec (must match the C++ side in scamp_ch_udf.cpp).
// -----------------------------------------------------------------
function encodeVarUInt(v, out) {
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}
function encodeInput(ts, window) {
  const out = [];
  encodeVarUInt(ts.length, out);
  // Little-endian float64 values.
  const bytes = new Uint8Array(new Float64Array(ts).buffer);
  for (const b of bytes) out.push(b);
  // UInt32 window (little-endian).
  out.push(window & 0xff, (window >>> 8) & 0xff, (window >>> 16) & 0xff, (window >>> 24) & 0xff);
  return new Uint8Array(out);
}

class ROReader {
  constructor(buf) { this.buf = buf; this.p = 0; }
  varUInt() {
    let v = 0, shift = 0;
    while (true) {
      const b = this.buf[this.p++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v >>> 0;
      shift += 7;
    }
  }
  readFloat32Array(n) {
    // Copy into a fresh aligned buffer; the underlying byte range in
    // wasm memory isn't guaranteed to be 4-aligned when accessed via a
    // Uint8Array view slice.
    const aligned = new Uint8Array(n * 4);
    aligned.set(this.buf.subarray(this.p, this.p + n * 4));
    this.p += n * 4;
    return new Float32Array(aligned.buffer);
  }
  readInt32Array(n) {
    const aligned = new Uint8Array(n * 4);
    aligned.set(this.buf.subarray(this.p, this.p + n * 4));
    this.p += n * 4;
    return new Int32Array(aligned.buffer);
  }
}

// -----------------------------------------------------------------
// Test.
// -----------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

function synth(n, motifStarts = []) {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.05) + 0.05 * Math.random();
  for (const s of motifStarts) {
    for (let i = 0; i < 64 && s + i < n; i++) a[s + i] = Math.cos(i * 0.1);
  }
  return a;
}

async function main() {
  const wasmBytes = fs.readFileSync(wasmPath);
  let memory;
  const imports = makeImports(() => memory);
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  memory = instance.exports.memory;
  const heap = () => new Uint8Array(memory.buffer);

  const {
    clickhouse_create_buffer,
    clickhouse_destroy_buffer,
    scamp_selfjoin_1nn,
  } = instance.exports;

  assert(typeof clickhouse_create_buffer === 'function', 'create_buffer exported');
  assert(typeof clickhouse_destroy_buffer === 'function', 'destroy_buffer exported');
  assert(typeof scamp_selfjoin_1nn === 'function', 'scamp_selfjoin_1nn exported');
  console.log('  exports OK');

  // Test 1: allocator sanity.
  {
    const h = clickhouse_create_buffer(128);
    assert(h !== 0, 'create_buffer returned non-null');
    // Peek at the returned struct: {u8* data, u32 size}.
    const view = new DataView(memory.buffer, h, 8);
    const data_ptr = view.getUint32(0, true);
    const size = view.getUint32(4, true);
    assert(size === 128, `buffer size == 128 (got ${size})`);
    assert(data_ptr !== 0, 'data ptr non-null');
    clickhouse_destroy_buffer(h);
    console.log('  create/destroy OK');
  }

  // Test 2: end-to-end SCAMP call.
  const N = 1024, W = 64;
  const input = synth(N, [200, 600]);
  const inputBytes = encodeInput(input, W);
  console.log(`  encoded input: n=${N}, window=${W}, bytes=${inputBytes.length}`);

  const inBuf = clickhouse_create_buffer(inputBytes.length);
  const inView = new DataView(memory.buffer, inBuf, 8);
  const inDataPtr = inView.getUint32(0, true);
  heap().set(inputBytes, inDataPtr);

  const t0 = Date.now();
  const outBuf = scamp_selfjoin_1nn(inBuf, 1);
  const dt = Date.now() - t0;
  console.log(`  scamp_selfjoin_1nn returned in ${dt}ms`);
  assert(outBuf !== 0, 'output buffer non-null');

  const outView = new DataView(memory.buffer, outBuf, 8);
  const outDataPtr = outView.getUint32(0, true);
  const outSize = outView.getUint32(4, true);
  console.log(`  output size: ${outSize} bytes`);
  const outBytes = heap().slice(outDataPtr, outDataPtr + outSize);

  const r = new ROReader(outBytes);
  const mDist = r.varUInt();
  const dists = r.readFloat32Array(mDist);
  const mIdx = r.varUInt();
  const idxs = r.readInt32Array(mIdx);

  clickhouse_destroy_buffer(outBuf);
  clickhouse_destroy_buffer(inBuf);

  const expected = N - W + 1;
  assert(mDist === expected, `dist count ${mDist} == ${expected}`);
  assert(mIdx === expected, `idx count ${mIdx} == ${expected}`);
  console.log(`  decoded ${mDist} distances, ${mIdx} indices`);

  // Motif recovery: index[200] should point near 600 and vice versa.
  assert(Math.abs(idxs[200] - 600) <= 128, `motif @200 → ${idxs[200]} (expect ≈600)`);
  assert(Math.abs(idxs[600] - 200) <= 128, `motif @600 → ${idxs[600]} (expect ≈200)`);
  console.log(`  motif recovery: index[200]=${idxs[200]}, index[600]=${idxs[600]} — OK`);

  // Test 3: numeric agreement vs native SCAMP CLI (if available).
  if (fs.existsSync(nativeBin)) {
    const tmp = fs.mkdtempSync('/tmp/scamp-ch-corr-');
    const inFile = path.join(tmp, 'ts.txt');
    fs.writeFileSync(inFile, Array.from(input).map((v) => v.toString()).join('\n') + '\n');
    execFileSync(nativeBin, [
      `--window=${W}`,
      '--num_cpu_workers=1',
      `--input_a_file_name=${inFile}`,
      `--output_a_file_name=${path.join(tmp, 'mp.txt')}`,
      `--output_a_index_file_name=${path.join(tmp, 'idx.txt')}`,
    ], { stdio: 'pipe' });
    const nativeDists = fs.readFileSync(path.join(tmp, 'mp.txt'),  'utf8').trim().split(/\s+/).map(Number);
    const nativeIdx   = fs.readFileSync(path.join(tmp, 'idx.txt'), 'utf8').trim().split(/\s+/).map(Number);
    let maxDiff = 0, idxMismatch = 0;
    for (let i = 0; i < expected; i++) {
      const diff = Math.abs(dists[i] - nativeDists[i]);
      if (diff > maxDiff) maxDiff = diff;
      if (idxs[i] !== nativeIdx[i] && diff > 1e-4) idxMismatch++;
    }
    console.log(`  vs native: max distance diff ${maxDiff.toExponential(3)}, ${idxMismatch} index mismatches with also-differing distance`);
    assert(maxDiff < 1e-4, `native/wasm diverge: ${maxDiff}`);
    assert(idxMismatch === 0, `native/wasm index mismatches: ${idxMismatch}`);
  } else {
    console.log('  (skipped native cross-check: build-native-bench/SCAMP missing)');
  }

  console.log('all UDF tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
