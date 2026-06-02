#!/usr/bin/env node
'use strict';

/**
 * migrate.js — move a Strapi site's media to the masters-only media service.
 *
 * For each row in Strapi's `files` table:
 *   1. Resolve the MASTER bytes from row.url
 *        • remote (http/https, e.g. AWS S3)  → HTTP GET (public)
 *        • local  (/uploads/...)             → read from --uploads-dir
 *   2. PUT the master to the media service at its key (folder preserved).
 *   3. Rewrite row.url → media URL, and row.formats →
 *        • compact: { size: { url:"<master>?w=<width>[&fm=<ext>]", width, height } }
 *        • drop:    null
 *   4. Variant files are never uploaded — the service resizes the master on demand.
 *
 * Provider-agnostic: never parses variant filenames; uses each row's master url +
 * per-format width. Idempotent + resumable (rows whose url already points at the
 * media base are skipped). Supports --dry-run.
 *
 * Usage:
 *   node migrate.js \
 *     --db-client mysql --db-host 127.0.0.1 --db-port 3306 \
 *     --db-name pos_db --db-user pos_user --db-pass '****' \
 *     --media-base https://images.rutba.pk --upload-token '****' \
 *     --uploads-dir /srv/strapi/public \   # only for local-stored media
 *     --formats compact --concurrency 8 [--dry-run] [--limit 50] [--verbose]
 *
 * Deps: mysql2 (and/or pg). Install:  npm install   (in this migrate/ folder)
 */

const fs = require('fs');
const path = require('path');

// ── tiny arg parser ────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; } else { a[key] = next; i++; }
    }
  }
  return a;
}
const args = parseArgs(process.argv);
const env = process.env;
const opt = (k, d) => (args[k] !== undefined ? args[k] : (env[k.replace(/-/g, '_').toUpperCase()] !== undefined ? env[k.replace(/-/g, '_').toUpperCase()] : d));

const CFG = {
  dbClient: opt('db-client', 'mysql'),
  dbHost: opt('db-host', '127.0.0.1'),
  dbPort: parseInt(opt('db-port', opt('db-client', 'mysql') === 'postgres' ? '5432' : '3306'), 10),
  dbName: opt('db-name'),
  dbUser: opt('db-user'),
  dbPass: opt('db-pass', ''),
  table: opt('table', 'files'),
  mediaBase: String(opt('media-base', '')).replace(/\/+$/, ''),
  uploadToken: opt('upload-token', ''),
  uploadsDir: opt('uploads-dir', ''),     // Strapi public dir for local media
  uploadsUrlPrefix: opt('uploads-url-prefix', '/uploads'),
  formats: opt('formats', 'compact'),     // compact | drop
  relative: !!args['relative'],           // write relative (/key) instead of absolute media URLs
  concurrency: parseInt(opt('concurrency', '8'), 10),
  limit: parseInt(opt('limit', '0'), 10),
  dryRun: !!args['dry-run'],
  verbose: !!args['verbose'],
};

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
if (!CFG.dbName || !CFG.dbUser) die('--db-name and --db-user are required');
if (!CFG.mediaBase) die('--media-base is required (e.g. https://images.rutba.pk)');
if (!CFG.uploadToken && !CFG.dryRun) die('--upload-token is required (unless --dry-run)');

// ── DB adapters ────────────────────────────────────────────
async function connectDB() {
  if (CFG.dbClient === 'mysql') {
    let mysql; try { mysql = require('mysql2/promise'); } catch { die('mysql2 not installed — run `npm install` in migrate/'); }
    const conn = await mysql.createConnection({ host: CFG.dbHost, port: CFG.dbPort, user: CFG.dbUser, password: CFG.dbPass, database: CFG.dbName, supportBigNumbers: true });
    return {
      async rows() { const [r] = await conn.query(`SELECT id, url, formats FROM \`${CFG.table}\` ORDER BY id` + (CFG.limit ? ` LIMIT ${CFG.limit}` : '')); return r; },
      async update(id, url, formats) { await conn.query(`UPDATE \`${CFG.table}\` SET url = ?, formats = ? WHERE id = ?`, [url, formats, id]); },
      async end() { await conn.end(); },
    };
  }
  if (CFG.dbClient === 'postgres' || CFG.dbClient === 'pg') {
    let pg; try { pg = require('pg'); } catch { die('pg not installed — run `npm install pg` in migrate/'); }
    const client = new pg.Client({ host: CFG.dbHost, port: CFG.dbPort, user: CFG.dbUser, password: CFG.dbPass, database: CFG.dbName });
    await client.connect();
    return {
      async rows() { const r = await client.query(`SELECT id, url, formats FROM ${CFG.table} ORDER BY id` + (CFG.limit ? ` LIMIT ${CFG.limit}` : '')); return r.rows; },
      async update(id, url, formats) { await client.query(`UPDATE ${CFG.table} SET url = $1, formats = $2 WHERE id = $3`, [url, formats, id]); },
      async end() { await client.end(); },
    };
  }
  die('--db-client must be mysql or postgres');
}

// ── helpers ────────────────────────────────────────────────
function parseFormats(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }
function keyFromUrl(url) {
  if (/^https?:\/\//i.test(url)) { try { return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, ''); } catch { return null; } }
  return url.replace(/^\/+/, ''); // local: /uploads/277/x.jpeg -> uploads/277/x.jpeg
}
function localFileFor(url) {
  // url like /uploads/277/x.jpeg ; uploadsDir maps to uploadsUrlPrefix
  const rel = url.replace(new RegExp('^' + CFG.uploadsUrlPrefix.replace(/[/\\]/g, '\\$&') + '/?'), '');
  return path.join(CFG.uploadsDir, rel);
}
function mediaUrl(key) { return CFG.relative ? '/' + key : CFG.mediaBase + '/' + key; }
function fmtParam(ext) { const e = String(ext || '').replace(/^\./, '').toLowerCase(); if (!e || e === 'jpg' || e === 'jpeg') return ''; return '&fm=' + e; }

async function getMaster(url) {
  if (/^https?:\/\//i.test(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('GET ' + url + ' -> ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  if (!CFG.uploadsDir) throw new Error('local media needs --uploads-dir');
  return fs.promises.readFile(localFileFor(url));
}
async function putMaster(key, buf, mime) {
  // Always PUT to the media service itself, regardless of how URLs are written to the DB.
  const target = CFG.mediaBase + '/' + key;
  const r = await fetch(target, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + CFG.uploadToken, 'Content-Type': mime || 'application/octet-stream' }, body: buf,
  });
  if (!r.ok) throw new Error('PUT ' + key + ' -> ' + r.status);
}
// already-migrated detection (idempotent re-runs)
function isMigrated(row) {
  const url = row.url || '';
  if (url.startsWith(CFG.mediaBase)) return true;                 // absolute mode
  if (CFG.relative && /\?w=/.test(JSON.stringify(row.formats || ''))) return true; // relative mode: formats compacted
  return false;
}

function rewriteFormats(formats, newMasterUrl) {
  if (CFG.formats === 'drop') return null;
  if (!formats || typeof formats !== 'object') return formats || null;
  const out = {};
  for (const [size, f] of Object.entries(formats)) {
    if (!f || typeof f !== 'object') continue;
    const w = f.width; const h = f.height;
    out[size] = { url: `${newMasterUrl}?w=${w || ''}${fmtParam(f.ext)}`, width: w, height: h };
  }
  return out;
}

// ── main ───────────────────────────────────────────────────
(async () => {
  console.log(`[migrate] ${CFG.dryRun ? 'DRY-RUN ' : ''}db=${CFG.dbClient}://${CFG.dbName} table=${CFG.table} -> ${CFG.mediaBase} formats=${CFG.formats}`);
  const db = await connectDB();
  const rows = await db.rows();
  console.log(`[migrate] ${rows.length} rows`);

  let ok = 0, skip = 0, fail = 0, done = 0;
  const queue = rows.slice();
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      done++;
      try {
        const url = row.url || '';
        if (!url) { skip++; continue; }
        if (isMigrated(row)) { skip++; if (CFG.verbose) console.log(`  skip #${row.id} (already migrated)`); continue; }
        const key = keyFromUrl(url);
        if (!key) { fail++; console.warn(`  FAIL #${row.id} bad url ${url}`); continue; }
        const newUrl = mediaUrl(key);
        const newFormats = rewriteFormats(parseFormats(row.formats), newUrl);
        if (CFG.dryRun) {
          if (CFG.verbose) console.log(`  would migrate #${row.id}: ${url} -> ${newUrl} (formats: ${newFormats ? Object.keys(newFormats).length : 0})`);
          ok++; continue;
        }
        const buf = await getMaster(url);
        await putMaster(key, buf);
        await db.update(row.id, newUrl, newFormats == null ? null : JSON.stringify(newFormats));
        ok++;
        if (CFG.verbose || ok % 100 === 0) console.log(`  [${done}/${rows.length}] #${row.id} -> ${newUrl}`);
      } catch (e) { fail++; console.warn(`  FAIL #${row.id}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CFG.concurrency) }, worker));
  await db.end();
  console.log(`[migrate] done. ok=${ok} skipped=${skip} failed=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => die(e.stack || e.message));
