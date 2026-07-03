// Minimal static file server that sets the COOP/COEP headers required
// for cross-origin isolation, so the demo can load the multi-threaded
// wasm build (which needs SharedArrayBuffer).
//
// Usage: node serve.mjs [port]   (default 8090)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 8090);
const root = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css':  'text/css; charset=utf-8',
  '.map':  'application/json',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  // Required for cross-origin isolation → SharedArrayBuffer → wasm threads.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const fsPath = path.join(root, urlPath);
  if (!fsPath.startsWith(root)) { res.statusCode = 403; return res.end('forbidden'); }

  fs.stat(fsPath, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; return res.end('not found: ' + urlPath); }
    const ext = path.extname(fsPath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(fsPath).pipe(res);
  });
});

server.listen(port, () => {
  console.log(`SCAMP demo server on http://localhost:${port}/demo/`);
  console.log('COOP + COEP set, so the multi-threaded wasm build is available.');
});
