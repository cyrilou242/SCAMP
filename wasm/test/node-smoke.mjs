// Smoke tests: self-join + AB-join + all four profile types.
// Run: node wasm/test/node-smoke.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SCAMP = require(path.join(distDir, 'scamp.js'));

function synth(n, motifStarts = []) {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.05) + 0.05 * Math.random();
  for (const s of motifStarts) {
    for (let i = 0; i < 64 && s + i < n; i++) a[s + i] = Math.cos(i * 0.1);
  }
  return a;
}

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

async function main() {
  const scamp = await SCAMP.create({ threads: 1, baseUrl: distDir + '/' });

  // ---- 1) self-join 1NN_INDEX (planted motif) ------------------------
  {
    const a = synth(2048, [500, 1500]);
    const res = await scamp.run(
      { a, window: 64, profileType: '1NN_INDEX', silent: true },
      { onProgress: (d, t) => process.stdout.write(`\rself-1NN_INDEX ${d}/${t}   `) }
    );
    console.log();
    assert(res.a.profile.length === 2048 - 64 + 1, 'self 1NN_INDEX length');
    // Planted motif: index[500] should point near 1500 and vice versa.
    assert(Math.abs(res.a.index[500]  - 1500) <= 128, `motif recovery @500 -> ${res.a.index[500]}`);
    assert(Math.abs(res.a.index[1500] - 500)  <= 128, `motif recovery @1500 -> ${res.a.index[1500]}`);
    console.log('  self 1NN_INDEX OK');
  }

  // ---- 2) self-join, all four profile types ---------------------------
  const a2 = synth(1024, [200, 700]);
  for (const [pt, extra] of [
    ['1NN', {}],
    ['SUM_THRESH', { threshold: 0.7 }],
    // KNN is GPU-only in upstream SCAMP ("CPU Support ... does not support
    // KNN joins yet"). Skipped here; would throw SCAMP_FUNCTIONALITY_UNIMPLEMENTED.
    ['MATRIX_SUMMARY', { matrixHeight: 20, matrixWidth: 20 }],
  ]) {
    const res = await scamp.run({ a: a2, window: 64, profileType: pt, silent: true, ...extra });
    assert(res.profileType && res.a, `self ${pt}: has result shape`);
    if (pt === 'MATRIX_SUMMARY') {
      assert(res.a.values && res.a.height === 20 && res.a.width === 20, 'matrix dims');
    } else {
      assert(res.a.profile && res.a.profile.length > 0, `${pt} has profile`);
    }
    console.log(`  self ${pt} OK`);
  }

  // ---- 3) AB-join 1NN_INDEX -----------------------------------------
  {
    // A has motifs at 100 and 800; B has an occurrence at 400.
    // AB-join(A -> B) profile[i] should be low near A's motif starts,
    // and index[100] and index[800] should both point near 400 in B.
    const A = synth(1024, [100, 800]);
    const B = synth(1024, [400]);
    const res = await scamp.run(
      { a: A, b: B, window: 64, profileType: '1NN_INDEX', silent: true },
      { onProgress: (d, t) => process.stdout.write(`\rAB-1NN_INDEX ${d}/${t}   `) }
    );
    console.log();
    assert(res.a.profile.length === 1024 - 64 + 1, 'AB-join length');
    assert(Math.abs(res.a.index[100] - 400) <= 128,
      `AB motif recovery A@100 -> B@${res.a.index[100]} (expected ≈ 400)`);
    assert(Math.abs(res.a.index[800] - 400) <= 128,
      `AB motif recovery A@800 -> B@${res.a.index[800]} (expected ≈ 400)`);
    console.log('  AB-join 1NN_INDEX OK');
  }

  // ---- 4) MT smoke (only if crossOriginIsolated / Node) ---------------
  try {
    const mt = await SCAMP.create({ threads: 2, baseUrl: distDir + '/' });
    const a = synth(2048, [500, 1500]);
    const res = await mt.run({ a, window: 64, profileType: '1NN_INDEX', silent: true });
    assert(Math.abs(res.a.index[500] - 1500) <= 128, 'MT motif recovery');
    console.log('  MT self 1NN_INDEX OK');
    await mt.terminate();
  } catch (e) {
    console.log('  MT: skipped (' + (e.message || e) + ')');
  }

  await scamp.terminate();
  console.log('all smoke tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
