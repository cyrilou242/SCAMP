// End-to-end test: load scamp_ch_udf.wasm into a real ClickHouse
// container and verify the SQL UDF returns correct results.
//
// Prerequisites: `docker` available on PATH, network access to pull
// `clickhouse/clickhouse-server:head`. First run downloads ~500 MB and
// takes a couple minutes; subsequent runs reuse the local image.
//
// Not part of the default `npm test` because of the docker dependency.
// Run explicitly:
//   node wasm/clickhouse/test/test_clickhouse.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '..', '..', 'dist', 'scamp_ch_udf.wasm');
const CONTAINER = `ch-scamp-e2e-${process.pid}`;
const IMAGE = 'clickhouse/clickhouse-server:head';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
function shSilent(cmd, args) { spawnSync(cmd, args, { stdio: 'ignore' }); }

function chQuery(sql, extra = []) {
  return sh('docker', ['exec', CONTAINER, 'clickhouse-client', '--query', sql, ...extra]).trim();
}

function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + msg);
}

function docker(cmd, args) { return sh('docker', [cmd, ...args]); }

// ---------------- lifecycle -----------------------------------------

function cleanup() { shSilent('docker', ['rm', '-f', CONTAINER]); }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitForReady(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['exec', CONTAINER, 'clickhouse-client', '--query', 'SELECT 1'], { stdio: 'ignore' });
    if (r.status === 0) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('ClickHouse did not become ready in time');
}

// ---------------- test cases ----------------------------------------

async function main() {
  if (!fs.existsSync(wasmPath)) {
    console.error(`wasm not built: ${wasmPath} (run wasm/build.sh st)`);
    process.exit(2);
  }

  console.log(`[1/6] starting ${IMAGE} as ${CONTAINER}`);
  docker('run', ['-d', '--rm', '--name', CONTAINER, IMAGE]);

  console.log('[2/6] injecting experimental-wasm-udf config + restarting');
  sh('docker', ['exec', CONTAINER, 'sh', '-c',
    `cat > /etc/clickhouse-server/config.d/wasm_udfs.xml <<'EOF'
<clickhouse>
    <allow_experimental_webassembly_udf>true</allow_experimental_webassembly_udf>
    <webassembly_udf_engine>wasmtime</webassembly_udf_engine>
</clickhouse>
EOF`]);
  docker('restart', [CONTAINER]);
  await waitForReady();

  const version = chQuery('SELECT version()');
  const useWasmtime = chQuery(
    "SELECT value FROM system.build_options WHERE name = 'USE_WASMTIME'");
  console.log(`      ClickHouse ${version}, USE_WASMTIME=${useWasmtime}`);
  assert(useWasmtime === '1', 'chosen image lacks USE_WASMTIME=1');

  console.log('[3/6] loading scamp_ch_udf.wasm into system.webassembly_modules');
  docker('cp', [wasmPath, `${CONTAINER}:/tmp/scamp_ch_udf.wasm`]);
  sh('docker', ['exec', CONTAINER, 'sh', '-c',
    "cat /tmp/scamp_ch_udf.wasm | clickhouse-client --query " +
    "\"INSERT INTO system.webassembly_modules (name, code) " +
    "SELECT 'scamp', code FROM input('code String') FORMAT RawBlob\""]);
  const modules = chQuery("SELECT count() FROM system.webassembly_modules WHERE name = 'scamp'");
  assert(modules === '1', `expected 1 module, got ${modules}`);

  console.log('[4/6] creating SQL UDF');
  chQuery(`
    CREATE FUNCTION scamp_selfjoin_1nn
        LANGUAGE WASM ABI BUFFERED_V1
        FROM 'scamp' :: 'scamp_selfjoin_1nn'
        ARGUMENTS (ts Array(Float64), window UInt32)
        RETURNS Tuple(Array(Float32), Array(Int32))
        SETTINGS
            serialization_format = 'RowBinary',
            webassembly_udf_enable_fuel = false
  `);
  const fns = chQuery(
    "SELECT count() FROM system.functions WHERE name = 'scamp_selfjoin_1nn'");
  assert(fns === '1', `expected 1 UDF, got ${fns}`);

  console.log('[5/6] running query with planted motif — expect index[201]=600, [601]=200, min=0');
  const q = `
    SET webassembly_udf_max_memory = 268435456;
    WITH scamp_selfjoin_1nn(ts, 64 :: UInt32) AS r
    SELECT length(r.1)             AS n_profile,
           r.2[201]                AS idx_at_200,
           r.2[601]                AS idx_at_600,
           round(arrayReduce('min', r.1), 4) AS min_dist
    FROM (
      SELECT arrayMap(i ->
        if(i >= 200 AND i < 264, cos((i-200) * 0.1),
        if(i >= 600 AND i < 664, cos((i-600) * 0.1),
          sin(i * 0.05))),
        range(1024))::Array(Float64) AS ts
    )
    FORMAT TSV`;
  const [nProfile, idx200, idx600, minDist] = chQuery(q).split('\t');
  console.log(`      n_profile=${nProfile}, idx[200]=${idx200}, idx[600]=${idx600}, min=${minDist}`);
  assert(Number(nProfile) === 1024 - 64 + 1, `profile length mismatch: ${nProfile}`);
  assert(Number(idx200) === 600, `idx[200] should point to 600 (got ${idx200})`);
  assert(Number(idx600) === 200, `idx[600] should point to 200 (got ${idx600})`);
  assert(Math.abs(Number(minDist)) < 1e-3, `min dist should be ~0 (got ${minDist})`);

  console.log('[6/6] running GROUP BY over 3 subjects (parallelism smoke)');
  chQuery(`
    CREATE TABLE t (subject UInt32, t UInt32, v Float64) ENGINE=Memory;
    INSERT INTO t
    SELECT s, i,
        if(i >= 200 AND i < 264, cos((i-200)*0.1),
        if(i >= 600 AND i < 664, cos((i-600)*0.1), sin(i*0.05) + s * 0.001))
    FROM (
      SELECT arrayJoin([1,2,3]) AS s, arrayJoin(range(1024)) AS i
    )
  `, ['--multiquery']);
  const rows = chQuery(`
    SET webassembly_udf_max_memory = 268435456;
    SELECT subject,
           round(arrayReduce('min', (scamp_selfjoin_1nn(ts, 64::UInt32)).1), 4) AS m
    FROM (
      SELECT subject, arrayMap(p -> p.2, arraySort(x -> x.1, groupArray((t, v)))) AS ts
      FROM t GROUP BY subject
    )
    ORDER BY subject FORMAT TSV
  `);
  const lines = rows.split('\n').filter(Boolean);
  assert(lines.length === 3, `expected 3 rows, got ${lines.length}: ${rows}`);
  for (const line of lines) {
    const [subj, m] = line.split('\t');
    assert(Math.abs(Number(m)) < 1e-3, `subject ${subj} min dist should be ~0 (got ${m})`);
  }
  console.log(`      3 subjects processed, all with min_dist ≈ 0`);

  console.log('\nALL CLICKHOUSE E2E TESTS PASSED');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
