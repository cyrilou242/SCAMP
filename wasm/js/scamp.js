// scamp.js — UMD wrapper for SCAMP-wasm.
//
// Hosts the wasm module inside a dedicated Web Worker so the calling
// context (page main thread, or a Node.js main event loop) is never
// blocked. Exposes a small Promise-based API with progress callbacks
// and AbortSignal support.
//
// Loader logic:
//   - `threads: 1`      → single-threaded wasm (scamp-st.*). Works
//                         everywhere; no COOP/COEP needed.
//   - `threads: N > 1`  → multi-threaded wasm (scamp-mt.*). Requires
//                         crossOriginIsolated (COOP + COEP) at runtime.
//   - `threads: 'auto'` → MT if crossOriginIsolated, else ST.
//
// Public API:
//   const scamp = await SCAMP.create({ threads: 'auto', baseUrl: '.' });
//   const result = await scamp.run(argsObj, { onProgress, signal });
//   await scamp.terminate();
//
// argsObj mirrors the C++ side (see wasm/src/bindings.cpp).

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SCAMP = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis
    : typeof self !== 'undefined' ? self
    : typeof window !== 'undefined' ? window
    : this, function () {
  'use strict';

  const IS_NODE =
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null;

  function detectCrossOriginIsolated() {
    if (IS_NODE) return true; // Node has SAB unconditionally.
    return typeof self !== 'undefined' && self.crossOriginIsolated === true;
  }

  function resolveThreads(spec) {
    if (spec === 'auto' || spec === undefined || spec === null) {
      if (!detectCrossOriginIsolated()) return 1;
      const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      return Math.max(1, hc);
    }
    const n = Number(spec);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`SCAMP: invalid threads value: ${spec}`);
    }
    return Math.floor(n);
  }

  function createNodeWorker(scriptPath, payload) {
    // Loaded as CJS in Node; use require to avoid import.meta.
    // eslint-disable-next-line no-undef
    const { Worker } = require('node:worker_threads');
    return new Worker(scriptPath, { workerData: payload });
  }

  function createBrowserWorker(scriptURL) {
    return new Worker(scriptURL, { type: 'classic' });
  }

  class SCAMPClient {
    constructor(worker, threads) {
      this._worker = worker;
      this._threads = threads;
      this._nextId = 1;
      this._pending = new Map(); // id -> {resolve, reject, onProgress}

      const onMessage = (ev) => this._onMessage(ev.data ?? ev);
      if (IS_NODE) {
        worker.on('message', (d) => this._onMessage(d));
        worker.on('error', (err) => this._failAll(err));
        worker.on('exit', (code) => {
          if (code !== 0) this._failAll(new Error(`worker exited: ${code}`));
        });
      } else {
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', (ev) =>
          this._failAll(new Error(ev.message || 'worker error')));
      }
    }

    get threads() { return this._threads; }

    _post(msg, transfer) {
      if (IS_NODE) this._worker.postMessage(msg, transfer);
      else this._worker.postMessage(msg, transfer || []);
    }

    _onMessage(msg) {
      // Ignore anything that doesn't carry our protocol tag; emscripten's
      // Node adapter also posts internal exit/unwind bookkeeping messages
      // through the same MessagePort.
      if (!msg || typeof msg.kind !== 'string' ||
          !['progress', 'result', 'error', 'ready'].includes(msg.kind)) {
        return;
      }
      const p = this._pending.get(msg.id);
      if (!p) return;
      if (msg.kind === 'progress') {
        if (p.onProgress) {
          try { p.onProgress(msg.done, msg.total); } catch (_) {}
        }
        if (p.onSnapshot && msg.snapshot) {
          try { p.onSnapshot(msg.snapshot, msg.done, msg.total); } catch (_) {}
        }
      } else if (msg.kind === 'result') {
        this._pending.delete(msg.id);
        if (p.signal && p.onAbortCleanup) p.signal.removeEventListener('abort', p.onAbortCleanup);
        p.resolve(msg.result);
      } else if (msg.kind === 'error') {
        this._pending.delete(msg.id);
        if (p.signal && p.onAbortCleanup) p.signal.removeEventListener('abort', p.onAbortCleanup);
        p.reject(new Error(msg.message));
      }
    }

    _failAll(err) {
      for (const p of this._pending.values()) p.reject(err);
      this._pending.clear();
    }

    run(args, opts) {
      opts = opts || {};
      const { onProgress, onSnapshot, signal } = opts;
      if (signal && signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      const id = this._nextId++;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, onProgress, onSnapshot, signal };
        if (signal) {
          entry.onAbortCleanup = () => {
            this._post({ kind: 'abort', id });
            // The worker will still send a final 'error' with AbortError
            // once the compute unwinds; the resolver is triggered there.
          };
          signal.addEventListener('abort', entry.onAbortCleanup, { once: true });
        }
        this._pending.set(id, entry);
        // Forward the client-level thread count into the C++ args unless
        // the caller pinned it explicitly. Without this, SCAMP_Operation
        // defaults to a single worker and the MT wasm build spawns 8
        // idle pthreads.
        const cppArgs = Object.assign({}, args);
        if (cppArgs.threads === undefined) cppArgs.threads = this._threads;
        // Zero-copy path is opt-in: `transfer: true` neuters the caller's
        // input buffers, which is fine for one-shot use but breaks any
        // caller that reuses the same input array across .run() calls.
        // Default behaviour is a structured-clone copy.
        const transfer = [];
        if (opts && opts.transfer) {
          if (cppArgs.a && cppArgs.a.buffer instanceof ArrayBuffer)
            transfer.push(cppArgs.a.buffer);
          if (cppArgs.b && cppArgs.b.buffer instanceof ArrayBuffer)
            transfer.push(cppArgs.b.buffer);
        }
        this._post({
          kind: 'run', id, args: cppArgs,
          wantSnapshot: typeof onSnapshot === 'function',
        }, transfer);
      });
    }

    async terminate() {
      if (IS_NODE) await this._worker.terminate();
      else this._worker.terminate();
    }

    // -----------------------------------------------------------------
    // Convenience wrappers mirroring pyscamp's function surface.
    // All accept the same trailing `opts` object as `run()`.
    // -----------------------------------------------------------------

    selfJoin(a, window, opts)          { return this.run({ a, window, profileType: '1NN_INDEX' },       opts); }
    selfJoin1NN(a, window, opts)       { return this.run({ a, window, profileType: '1NN' },              opts); }
    selfJoinSum(a, window, opts = {})  { return this.run({ a, window, profileType: 'SUM_THRESH',      threshold: opts.threshold ?? 0 }, opts); }
    selfJoinMatrix(a, window, opts = {}) {
      return this.run({
        a, window, profileType: 'MATRIX_SUMMARY',
        matrixHeight: opts.matrixHeight ?? 50,
        matrixWidth:  opts.matrixWidth  ?? 50,
      }, opts);
    }

    abJoin(a, b, window, opts)         { return this.run({ a, b, window, profileType: '1NN_INDEX' },     opts); }
    abJoin1NN(a, b, window, opts)      { return this.run({ a, b, window, profileType: '1NN' },            opts); }
    abJoinSum(a, b, window, opts = {}) { return this.run({ a, b, window, profileType: 'SUM_THRESH',    threshold: opts.threshold ?? 0 }, opts); }
    abJoinMatrix(a, b, window, opts = {}) {
      return this.run({
        a, b, window, profileType: 'MATRIX_SUMMARY',
        matrixHeight: opts.matrixHeight ?? 50,
        matrixWidth:  opts.matrixWidth  ?? 50,
      }, opts);
    }
  }

  async function create(opts) {
    opts = opts || {};
    const threads = resolveThreads(opts.threads);
    const baseUrl = opts.baseUrl || './';
    // Normalise trailing slash.
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';

    const explicitlyRequestedMT = opts.threads !== undefined &&
      opts.threads !== null && opts.threads !== 'auto' && Number(opts.threads) > 1;
    if (explicitlyRequestedMT && !detectCrossOriginIsolated() && !IS_NODE) {
      throw new Error(
        'SCAMP: threads > 1 requires a cross-origin-isolated page ' +
        '(serve Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp).');
    }

    const workerScript = base + 'scamp.worker.js';
    const payload = { baseUrl: base, threads };

    let worker;
    if (IS_NODE) {
      // eslint-disable-next-line no-undef
      const path = require('node:path');
      worker = createNodeWorker(path.resolve(base, 'scamp.worker.js'), payload);
    } else {
      worker = createBrowserWorker(workerScript);
      // Node uses workerData; browser Workers get the config via a first message.
      worker.postMessage({ kind: 'init', ...payload });
    }

    // Wait for ready ack.
    await new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        const data = ev.data ?? ev;
        if (data && data.kind === 'ready') {
          if (IS_NODE) worker.off('message', onMsg);
          else worker.removeEventListener('message', onMsg);
          resolve();
        } else if (data && data.kind === 'error') {
          if (IS_NODE) worker.off('message', onMsg);
          else worker.removeEventListener('message', onMsg);
          reject(new Error(data.message));
        }
      };
      if (IS_NODE) worker.on('message', onMsg);
      else worker.addEventListener('message', onMsg);
    });

    return new SCAMPClient(worker, threads);
  }

  return { create };
});
