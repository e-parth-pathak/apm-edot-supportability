#!/usr/bin/env node
/**
 * server.js — zero-dependency Node.js static server for the
 * Elastic APM / EDOT / Synthetics compatibility matrix explorer.
 *
 *   node build.js && node server.js
 *   -> http://localhost:3000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root)) return null; // path traversal guard
  return full;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method Not Allowed');
  }

  // Small API surface, handy if you want to consume the data elsewhere.
  if (req.url.split('?')[0] === '/api/data') {
    const p = path.join(ROOT, 'data.json');
    if (!fs.existsSync(p)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'data.json not built. Run: node build.js' }));
    }
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(p));
  }

  const file = safeJoin(ROOT, req.url);
  if (!file) { res.writeHead(400); return res.end('Bad request'); }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found: ' + req.url);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
});

server.listen(PORT, () => {
  console.log(`Compatibility matrix explorer running at http://localhost:${PORT}`);
  if (!fs.existsSync(path.join(ROOT, 'data.json'))) {
    console.log('WARNING: public/data.json is missing. Run "node build.js" first.');
  }
});
