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
    // Required in the MT build: Emscripten needs to know the URL of its
    // own glue JS so it can spawn pthread Web Workers as `new Worker(url)`.
    // When loaded via importScripts() inside a Worker, its self-discovery
    // (`_scriptName`) yields undefined, and pthread bootstrap silently
    // fetches `/undefined` in a hot loop.
    mainScriptUrlOrBlob: jsFile,
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

async function handleRun(id, args, wantSnapshot) {
  try {
    // Coerce plain arrays into Float64Array for the fast path in bindings.
    if (Array.isArray(args.a)) args.a = new Float64Array(args.a);
    if (Array.isArray(args.b)) args.b = new Float64Array(args.b);

    // If the client asked for live snapshots we call Module.getSnapshot()
    // from inside the progress callback. Only meaningful in the ST build
    // (in MT the compute pthread and JS thread interleave in a way that
    // makes emscripten::val calls from workers fail; documented in README).
    const onProgress = (done, total) => {
      const msg = { kind: 'progress', id, done, total };
      if (wantSnapshot) {
        const snap = Module.getSnapshot();
        if (snap != null) msg.snapshot = snap;
      }
      post(msg);
    };
    const result = Module.runSCAMP(args, onProgress);
    post({ kind: 'result', id, result });
  } catch (err) {
    let msg;
    if (err && err.message) {
      msg = err.message;
    } else if (typeof err === 'number' && Module && Module.getExceptionMessage) {
      // Emscripten passes C++ exceptions to JS as a pointer (number);
      // decode into [name, message] via the runtime helper.
      try {
        const info = Module.getExceptionMessage(err);
        msg = Array.isArray(info) ? info.filter(Boolean).join(': ') : String(info);
      } catch (_) {
        msg = 'wasm exception (ptr=' + err + ')';
      }
    } else {
      msg = String(err);
    }
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
  if (msg.kind === 'run') handleRun(msg.id, msg.args, msg.wantSnapshot);
  else if (msg.kind === 'abort') handleAbort(msg.id);
}

main();
