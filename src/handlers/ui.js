'use strict';

/**
 * Static file server for the web console under `/_ui/`. Serves the self-contained
 * SPA in `web/` (no build step, no framework, no external assets). Gated on
 * `db.enabled`: with the platform layer off the console has nothing to talk to, so
 * `/_ui/*` returns 404 and the server presents only its media/`/_health` surface —
 * exactly as before this feature existed.
 *
 * Routing within the mount:
 *   /_ui            → 301 /_ui/
 *   /_ui/           → index.html
 *   /_ui/<asset>    → the file, if it exists
 *   /_ui/<route>    → index.html fallback for client-side routes (extension-less only)
 *
 * Path traversal is blocked with the same `resolveSafe` used for masters.
 */

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { resolveSafe, relOf } = require('../util');
const { send } = require('../http');

const WEB_DIR = path.join(__dirname, '..', '..', 'web');

const WEB_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function createUiHandler({ db }) {
  async function serveFile(req, res, abs, status = 200) {
    const ext = path.extname(abs).toLowerCase();
    const type = WEB_MIME[ext] || 'application/octet-stream';
    // HTML must always re-validate so console updates show immediately; other
    // assets can be cached briefly.
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    const buf = await fsp.readFile(abs);
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': buf.length });
    if (req.method === 'HEAD') return res.end();
    res.end(buf);
  }

  // Returns true if it handled the request (path was under the /_ui mount).
  return async function handleUi(req, res, url) {
    const pathname = url.pathname;
    if (pathname === '/_ui') { res.writeHead(301, { Location: '/_ui/' }); res.end(); return true; }
    if (!pathname.startsWith('/_ui/')) return false;

    // Feature gate: no DB ⇒ console is simply not present.
    if (!db.enabled) { send(res, 404, 'Not Found'); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Method Not Allowed'); return true; }

    let rel = pathname.slice('/_ui/'.length);
    if (rel === '' ) rel = 'index.html';
    const abs = resolveSafe(WEB_DIR, rel);
    if (!abs) { send(res, 403, 'Forbidden'); return true; }

    try {
      const st = await fsp.stat(abs).catch(() => null);
      if (st && st.isFile()) { await serveFile(req, res, abs); return true; }
      // SPA fallback: extension-less client route → index.html (200 so history routing works).
      if (!path.extname(rel)) { await serveFile(req, res, path.join(WEB_DIR, 'index.html')); return true; }
      send(res, 404, 'Not Found');
    } catch (e) {
      send(res, 500, 'Server Error');
    }
    return true;
  };
}

module.exports = { createUiHandler, WEB_DIR };
