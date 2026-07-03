// Smoke test: self-join 1NN on a small synthetic series in Node.
// Run: node wasm/test/node-smoke.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SCAMP = require(path.join(distDir, 'scamp.js'));

function synth(n) {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.05) + 0.05 * Math.random();
  for (let i = 0; i < 64; i++) { a[500 + i] = Math.cos(i * 0.1); a[1500 + i] = Math.cos(i * 0.1); }
  return a;
}

const t0 = Date.now();
const scamp = await SCAMP.create({ threads: 1, baseUrl: distDir + '/' });
console.log(`booted in ${Date.now() - t0}ms, threads=${scamp.threads}`);

const a = synth(2048);
const res = await scamp.run(
  { a, window: 64, profileType: '1NN_INDEX', silent: true },
  { onProgress: (d, t) => process.stdout.write(`\rprogress ${d}/${t}   `) }
);
console.log();
console.log(`profile length: ${res.a.profile.length}`);
console.log(`first 5:  ${Array.from(res.a.profile.slice(0, 5)).map((v) => v.toFixed(3)).join(', ')}`);
console.log(`indices:  ${Array.from(res.a.index.slice(0, 5)).join(', ')}`);

// Sanity: the planted motif at 500 should point near 1500 (and vice versa).
const idx500 = res.a.index[500];
const idx1500 = res.a.index[1500];
console.log(`index[500]=${idx500}, index[1500]=${idx1500}`);
if (Math.abs(idx500 - 1500) > 128 || Math.abs(idx1500 - 500) > 128) {
  console.error('FAIL: planted motif not recovered');
  process.exit(1);
}
console.log('OK');
await scamp.terminate();
