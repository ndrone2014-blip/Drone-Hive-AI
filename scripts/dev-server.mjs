/**
 * Zero-dependency local server for Drone Hive AI.
 *
 *   npm start            (or: node scripts/dev-server.mjs)
 *   then open http://localhost:8888
 *
 * Serves /public and runs the same /api handlers that Netlify runs as Edge
 * Functions. Reads a .env file in the project root if one exists.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

loadDotEnv(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT) || 8888;
// Only reachable from this computer unless you set HOST=0.0.0.0 on purpose.
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const { handleChatRequest, handleStatusRequest } = await import(pathToFileURL(path.join(ROOT, 'server', 'handlers.js')).href);

// Use the same security headers as Netlify (from netlify.toml), so problems
// like a blocked inline style show up locally too.
const PAGE_HEADERS = (() => {
  try {
    const toml = readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
    const block = toml.split('[[headers]]').find((b) => /for\s*=\s*"\/\*"/.test(b)) || '';
    const out = {};
    for (const m of block.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/gm)) if (m[1] !== 'for') out[m[1].toLowerCase()] = m[2];
    out['content-security-policy'] = (out['content-security-policy'] || '').replace(/;?\s*upgrade-insecure-requests/, '');
    delete out['strict-transport-security'];
    return out;
  } catch {
    return {};
  }
})();

const ROUTES = { '/api/chat': handleChatRequest, '/api/status': handleStatusRequest };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    const handler = ROUTES[url.pathname];
    if (handler) return await runHandler(handler, req, res, url);
    if (url.pathname.startsWith('/api/')) return send(res, 404, 'application/json', JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown API route.' } }));
    return await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'text/plain', 'Internal server error');
    else res.end();
  }
});

async function runHandler(handler, req, res, url) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return send(res, 413, 'application/json', JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Request is too large.' } }));
    }
    chunks.push(c);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    signal: controller.signal,
  });
  const response = await handler(request, { ip: req.socket.remoteAddress });

  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  Readable.fromWeb(response.body)
    .on('error', () => res.end())
    .pipe(res);
}

async function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'text/plain', 'Bad request');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'text/plain', 'Forbidden');

  let target = file;
  try {
    const s = await stat(target);
    if (s.isDirectory()) target = path.join(target, 'index.html');
  } catch {
    // Single-page app fallback (same as the redirect in netlify.toml)
    if (!path.extname(rel)) target = path.join(PUBLIC_DIR, 'index.html');
    else return send(res, 404, 'text/plain', 'Not found');
  }
  const data = await readFile(target);
  res.writeHead(200, {
    ...PAGE_HEADERS,
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(data);
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

server.listen(PORT, HOST, () => {
  console.log(`\n  🐝 Drone Hive AI is running at http://localhost:${PORT}\n`);
  import(pathToFileURL(path.join(ROOT, 'server', 'ai', 'service.js')).href).then(({ getStatus }) => {
    const s = getStatus();
    console.log(s.connected
      ? `  AI provider connected: ${s.activeProvider}`
      : '  No AI provider connected yet (add an API key to .env to enable replies).');
    console.log('  Press Ctrl+C to stop.\n');
  });
});
