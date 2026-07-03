// scamp.worker.js — Web/Node worker hosting the wasm SCAMP module.
//
// Owns exactly one wasm instance (either scamp-st or scamp-mt depending
// on the requested thread count) and services run/abort messages from
// scamp.js. Progress callbacks are posted back as messages; aborts flip
// the C++ atomic via abortSCAMP().

'use strict';

const IS_NODE =
  typeof process !== 'undefined' &&
  process.versions != null &&
  process.versions.node != null;

let Module = null;
let baseUrl = './';
let threads = 1;

async function loadWasm() {
  const modName = threads > 1 ? 'scamp-mt' : 'scamp-st';
  const jsFile = baseUrl + modName + '.js';
  let factory;
  if (IS_NODE) {
    // Emscripten's -sMODULARIZE output is CJS by default; use require.
    const nodePath = require('node:path');
    const abs = nodePath.isAbsolute(jsFile) ? jsFile : nodePath.resolve(jsFile);
    factory = require(abs);
    if (factory && factory.default) factory = factory.default;
  } else {
    // Classic worker: importScripts sets globalThis[createSCAMPModule].
    self.importScripts(jsFile);
    factory = globalThis.createSCAMPModule;
  }
  Module = await factory({
    locateFile: (path) => baseUrl + path,
    // Keep the runtime alive after main() returns so embind functions
    // stay callable (required in the MT / PROXY_TO_PTHREAD build).
    noExitRuntime: true,
    // Absorb emscripten's exit/unwind bookkeeping. `onExit` is only
    // triggered when EXIT_RUNTIME is set, which we disable via link
    // flags; the handler is a safety net.
    onExit: () => {},
    // Suppress emscripten's default stdout piping; we're silent by default.
    print: () => {},
    printErr: (m) => (IS_NODE ? process.stderr.write(m + '\n') : console.warn(m)),
  });
}

function post(msg, transfer) {
  if (IS_NODE) {
    require('node:worker_threads').parentPort.postMessage(msg, transfer);
  } else {
    self.postMessage(msg, transfer || []);
  }
}

async function handleRun(id, args) {
  try {
    // Coerce plain arrays into Float64Array for the fast path in bindings.
    if (Array.isArray(args.a)) args.a = new Float64Array(args.a);
    if (Array.isArray(args.b)) args.b = new Float64Array(args.b);

    const onProgress = (done, total) => post({ kind: 'progress', id, done, total });
    const result = Module.runSCAMP(args, onProgress);
    post({ kind: 'result', id, result });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // Filter Emscripten's PROXY_TO_PTHREAD bookkeeping so it doesn't
    // surface as a run failure.
    if (/^(unwind|Program terminated with exit\(0\))$/.test(msg)) return;
    post({ kind: 'error', id, message: msg });
  }
}

function handleAbort(_id) {
  if (Module && Module.abortSCAMP) Module.abortSCAMP();
}

async function main() {
  // Boot config: browser posts an init message; Node uses workerData.
  let cfg;
  if (IS_NODE) {
    const { workerData, parentPort } = require('node:worker_threads');
    cfg = workerData;
    baseUrl = cfg.baseUrl;
    threads = cfg.threads;
    parentPort.on('message', dispatch);
  } else {
    cfg = await new Promise((resolve) => {
      self.addEventListener('message', function once(ev) {
        if (ev.data && ev.data.kind === 'init') {
          self.removeEventListener('message', once);
          resolve(ev.data);
        }
      });
    });
    baseUrl = cfg.baseUrl;
    threads = cfg.threads;
    self.addEventListener('message', (ev) => dispatch(ev.data));
  }

  try {
    await loadWasm();
    post({ kind: 'ready' });
  } catch (err) {
    post({ kind: 'error', message: 'wasm init: ' + (err && err.message ? err.message : err) });
  }
}

function dispatch(msg) {
  if (!msg) return;
  if (msg.kind === 'run') handleRun(msg.id, msg.args);
  else if (msg.kind === 'abort') handleAbort(msg.id);
}

main();
