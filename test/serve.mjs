#!/usr/bin/env node
// test/serve.mjs
// Tiny static file server for local testing. No dependencies.
// Serves the ClaimApp repo root at http://127.0.0.1:8000/
//
// Usage:
//   node test/serve.mjs           # default port 8000
//   node test/serve.mjs 3000      # custom port
//
// Opens index.html at the root path. ES modules load correctly because
// we serve with the right Content-Type headers.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, normalize, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || '8000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    // Prevent path traversal: resolve and verify the result stays under ROOT
    const fsPath = normalize(join(ROOT, urlPath));
    if (!fsPath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('403 Forbidden');
      return;
    }

    // Don't serve gitignored sensitive files even locally
    if (/\/(\.env|\.git\/|CLAUDE\.md|memory\/)/.test(urlPath)) {
      res.writeHead(404);
      res.end('404 Not Found');
      return;
    }

    const s = await stat(fsPath);
    if (s.isDirectory()) {
      res.writeHead(404);
      res.end('404 Not Found');
      return;
    }

    const mime = MIME[extname(fsPath).toLowerCase()] || 'application/octet-stream';
    const body = await readFile(fsPath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404);
    res.end('404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ClaimApp local server running at:`);
  console.log(`  http://127.0.0.1:${PORT}/`);
  console.log(``);
  console.log(`Press Ctrl+C to stop.`);
});
