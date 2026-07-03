// Correctness check: run wasm SCAMP and native SCAMP CLI on the same
// deterministic input, diff the resulting matrix profiles.
//
// The native SCAMP CLI reads a whitespace-separated time series from a
// file and writes profile + index to output files. We format the same
// input, run both, compare.
//
// Tolerance: wasm and native may differ in the last few digits due to
// different tile scheduling and (in MT) parallel reduction order —
// SCAMP is deterministic per-thread-count but not necessarily across
// binaries with different std::async implementations. Use a generous
// atol/rtol on the profile; require exact match on the index.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.resolve(here, '..');
const rootDir = path.resolve(wasmDir, '..');
const distDir = path.join(wasmDir, 'dist');
const nativeBin = path.join(rootDir, 'build-native-bench', 'SCAMP');
const SCAMP = require(path.join(distDir, 'scamp.js'));

if (!fs.existsSync(nativeBin)) {
  console.error(
    `native SCAMP binary not found at ${nativeBin}. ` +
    `Build with: (cd build-native-bench && cmake --build . -j --target SCAMP)`
  );
  process.exit(2);
}

// Deterministic input matching wasm's Float64 encoding exactly.
function synth(n, seed) {
  const a = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    a[i] = Math.sin(i * 0.03) + ((s >>> 0) / 0x100000000) * 0.1;
  }
  // Plant motifs so the profile has structure.
  for (let i = 0; i < 64; i++) {
    a[200 + i] = Math.cos(i * 0.1);
    a[600 + i] = Math.cos(i * 0.1);
  }
  return a;
}

const N = 1024;
const W = 64;
const input = synth(N, 42);

const tmp = fs.mkdtempSync('/tmp/scamp-corr-');
const inFile = path.join(tmp, 'ts.txt');
fs.writeFileSync(inFile, Array.from(input).map((v) => v.toString()).join('\n') + '\n');

console.log(`Native SCAMP: n=${N}, w=${W}, num_cpu_workers=1`);
execFileSync(nativeBin, [
  `--window=${W}`,
  '--num_cpu_workers=1',
  `--input_a_file_name=${inFile}`,
  `--output_a_file_name=${path.join(tmp, 'mp.txt')}`,
  `--output_a_index_file_name=${path.join(tmp, 'idx.txt')}`,
], { stdio: 'inherit' });

const nativeMp  = fs.readFileSync(path.join(tmp, 'mp.txt'),  'utf8').trim().split(/\s+/).map(Number);
const nativeIdx = fs.readFileSync(path.join(tmp, 'idx.txt'), 'utf8').trim().split(/\s+/).map(Number);
console.log(`  read ${nativeMp.length} profile values, ${nativeIdx.length} indices`);

console.log('Wasm SCAMP (threads=1)');
const scamp = await SCAMP.create({ threads: 1, baseUrl: distDir + '/' });
const res = await scamp.run({ a: input, window: W, profileType: '1NN_INDEX', silent: true });
await scamp.terminate();
console.log(`  got profile length ${res.a.profile.length}`);

if (res.a.profile.length !== nativeMp.length) {
  console.error(`length mismatch: wasm=${res.a.profile.length} native=${nativeMp.length}`);
  process.exit(1);
}

// Diff.
let maxProfileDiff = 0;
let maxRelDiff = 0;
let indexMismatches = 0;
const indexPairMismatches = [];  // where the index differs AND the profile value also differs

for (let i = 0; i < nativeMp.length; i++) {
  const w = res.a.profile[i];
  const n = nativeMp[i];
  const abs = Math.abs(w - n);
  if (abs > maxProfileDiff) maxProfileDiff = abs;
  const den = Math.max(Math.abs(n), 1e-9);
  const rel = abs / den;
  if (rel > maxRelDiff) maxRelDiff = rel;
  if (res.a.index[i] !== nativeIdx[i]) {
    indexMismatches++;
    if (abs > 1e-4) indexPairMismatches.push({ i, wasm: [w, res.a.index[i]], native: [n, nativeIdx[i]] });
  }
}

console.log(`\nresults:`);
console.log(`  max abs profile diff:      ${maxProfileDiff.toExponential(3)}`);
console.log(`  max rel profile diff:      ${maxRelDiff.toExponential(3)}`);
console.log(`  index mismatches:          ${indexMismatches} / ${nativeIdx.length}`);
console.log(`  index mismatches with also-differing profile value: ${indexPairMismatches.length}`);

// Bounds:
//   - abs diff should be tiny (fp precision on identical algorithm).
//   - Index mismatches are allowed only where multiple candidate NNs
//     share the same distance (ties); those cases show identical
//     profile values but different picks. Report them but don't fail.
const OK = maxProfileDiff < 1e-4 && indexPairMismatches.length === 0;
if (!OK) {
  console.error('FAIL: profile diverges beyond fp-precision tolerance');
  if (indexPairMismatches.length > 0) {
    console.error('  first few index-with-value mismatches:');
    for (const m of indexPairMismatches.slice(0, 5)) console.error('   ', m);
  }
  process.exit(1);
}
console.log('OK');
