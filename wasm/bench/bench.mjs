// Runs the same 4 self-join profile types SCAMP's upstream CI benchmarks,
// using the wasm-st build. Compatible with Node and Bun.
//
// Env vars:
//   SCAMP_BENCH_N       input length (default 32768, matches CI)
//   SCAMP_BENCH_W       window       (default 100,   matches CI)
//   SCAMP_BENCH_TILE    max tile size(default 131072,matches CI)
//   SCAMP_BENCH_ITERS   iterations   (default 5)
//   SCAMP_BENCH_DIST    absolute path to wasm dist/ directory
//   SCAMP_BENCH_THREADS 1 (default) — matches CI single-thread config
//   SCAMP_BENCH_JSON    if set, dump JSON on stdout at the end
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const IS_BUN = typeof globalThis.Bun !== 'undefined';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.SCAMP_BENCH_DIST || path.resolve(here, '..', 'dist');
const require = createRequire(import.meta.url);
const SCAMP = require(path.join(distDir, 'scamp.js'));

const N       = Number(process.env.SCAMP_BENCH_N     || 32768);
const W       = Number(process.env.SCAMP_BENCH_W     || 100);
const TILE    = Number(process.env.SCAMP_BENCH_TILE  || (1 << 17));
const ITERS   = Number(process.env.SCAMP_BENCH_ITERS || 5);
const THREADS = Number(process.env.SCAMP_BENCH_THREADS || 1);

// Deterministic LCG so successive invocations use identical inputs.
function makeInput(n) {
  const a = new Float64Array(n);
  let s = 0x243f6a88;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    a[i] = ((s >>> 0) / 0x100000000);
  }
  return a;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

const BENCHES = [
  { key: 'BM_1NN_INDEX_SELF_JOIN', profileType: '1NN_INDEX' },
  { key: 'BM_1NN_SELF_JOIN',       profileType: '1NN' },
  { key: 'BM_SUM_SELF_JOIN',       profileType: 'SUM_THRESH' },
  { key: 'BM_MATRIX_SELF_JOIN',    profileType: 'MATRIX_SUMMARY',
    extra: { matrixHeight: 100, matrixWidth: 100 } },
];

// CI baseline (i7-8700K, clang++ AVX2 native, single thread), for reference.
const CI = {
  BM_1NN_INDEX_SELF_JOIN: 0.5547,
  BM_1NN_SELF_JOIN:       0.2363,
  BM_SUM_SELF_JOIN:       0.3196,
  BM_MATRIX_SELF_JOIN:    1.0954,
};

function fmt(s) { return s.toFixed(3).padStart(7); }

async function run() {
  const runtime = IS_BUN ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
  process.stdout.write(`runtime: ${runtime} | N=${N}, W=${W}, tile=${TILE}, threads=${THREADS}, iters=${ITERS}\n`);
  process.stdout.write(`booting wasm...\n`);
  const scamp = await SCAMP.create({ threads: THREADS, baseUrl: distDir + '/' });

  const results = {};
  for (const b of BENCHES) {
    const args = {
      window: W, maxTileSize: TILE, precision: 'double',
      profileType: b.profileType, silent: true, threads: THREADS,
      ...(b.extra || {}),
    };
    const times = [];
    for (let i = 0; i < ITERS; i++) {
      const a = makeInput(N);
      const t0 = performance.now();
      await scamp.run({ a, ...args });
      times.push((performance.now() - t0) / 1000);
    }
    results[b.key] = { median: median(times), min: Math.min(...times), max: Math.max(...times), times };
    process.stdout.write(`  ${b.key.padEnd(24)} median=${fmt(results[b.key].median)}s  min=${fmt(results[b.key].min)}s  max=${fmt(results[b.key].max)}s\n`);
  }
  await scamp.terminate();

  process.stdout.write('\n');
  process.stdout.write('Benchmark                 median(s)   vs CI-x86-AVX2\n');
  process.stdout.write('---------------------------------------------------\n');
  for (const b of BENCHES) {
    const r = results[b.key].median;
    const ratio = r / CI[b.key];
    process.stdout.write(`${b.key.padEnd(25)} ${fmt(r)}     ${ratio.toFixed(2)}\u00d7\n`);
  }

  if (process.env.SCAMP_BENCH_JSON) {
    process.stdout.write('\n' + JSON.stringify({ runtime, N, W, THREADS, ITERS, results, ci: CI }, null, 2) + '\n');
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
