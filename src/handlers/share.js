'use strict';

/**
 * Public share links under `/_s/<token>` — the controlled-access way to hand a file
 * to someone without exposing the raw master path or the platform credentials.
 * Works even for `private`-visibility masters, and is forward-compatible with a
 * future private read-auth mode (a share is an explicit grant).
 *
 * A share can be password-protected, time-limited (`expires_at`), and/or
 * download-capped (`max_downloads`). `permission = download` forces an attachment
 * download; `view` serves inline. Every serve increments `download_count` and is
 * audited. Gated on `db.enabled`: with the platform layer off, `/_s/*` is 404.
 *
 * The token is looked up (with its file's path/mime) in one query; the file bytes
 * are then streamed with the same Range/ETag-aware streamer used everywhere else.
 */

const fsp = require('fs/promises');
const path = require('path');
const { resolveSafe } = require('../util');
const { streamFile, send } = require('../http');
const { verifyPassword } = require('../auth');
const { MIME } = require('../constants');

const SHARE_RE = /^\/_s\/([A-Za-z0-9_-]{6,64})$/;

function createShareHandler({ config, db, storage = null }) {
  // Returns true if it handled the request (path was under /_s/).
  return async function handleShare(req, res, url) {
    const m = SHARE_RE.exec(url.pathname);
    if (url.pathname === '/_s' || url.pathname === '/_s/') { send(res, 404, 'Not Found'); return true; }
    if (!m) return false;
    if (!db.enabled) { send(res, 404, 'Not Found'); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Method Not Allowed'); return true; }

    const token = m[1];
    const share = await db.one(
      `SELECT s.*, f.path AS file_path, f.name AS file_name, f.mime AS file_mime, f.status AS file_status
       FROM shares s LEFT JOIN files f ON f.id = s.file_id WHERE s.token = ? LIMIT 1`, [token]).catch(() => null);
    if (!share || !share.file_id) { send(res, 404, 'This link is invalid.'); return true; }

    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) { send(res, 410, 'This link has expired.'); return true; }
    if (share.max_downloads != null && share.download_count >= share.max_downloads) { send(res, 410, 'This link has reached its download limit.'); return true; }

    // Password gate (a simple unlock page so a human can enter it in a browser).
    if (share.password_hash) {
      const pw = url.searchParams.get('pw') || '';
      if (!pw || !(await verifyPassword(pw, share.password_hash))) { unlockPage(res, url.pathname, !!pw); return true; }
    }

    if (share.file_status === 'trashed') { send(res, 404, 'This file is no longer available.'); return true; }
    // Locate the master across storage volumes.
    let abs, st;
    if (storage) { const hit = await storage.resolveRead(share.file_path); if (hit) { abs = hit.abs; st = hit.stat; } }
    else { abs = resolveSafe(config.masterDir, share.file_path); st = abs ? await fsp.stat(abs).catch(() => null) : null; }
    if (!abs) { send(res, 404, 'Not Found'); return true; }
    if (!st || !st.isFile()) { send(res, 404, 'This file is no longer available.'); return true; }

    const ext = path.extname(share.file_path).toLowerCase();
    const type = share.file_mime || MIME[ext] || 'application/octet-stream';
    if (share.permission === 'download') {
      const fname = (share.file_name || path.basename(share.file_path)).replace(/["\\\r\n]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    }

    // Count the access. For a capped link, reserve the slot with a single atomic
    // conditional UPDATE and only serve if it succeeds — this closes the race where
    // two concurrent requests could both pass a read-then-serve check and exceed the
    // cap. Uncapped links just increment best-effort (never blocks the serve).
    if (share.max_downloads != null) {
      const upd = await db.query(
        'UPDATE shares SET download_count = download_count + 1 WHERE id = ? AND download_count < max_downloads',
        [share.id]).catch(() => null);
      if (!upd || upd.affectedRows === 0) { send(res, 410, 'This link has reached its download limit.'); return true; }
    } else {
      db.query('UPDATE shares SET download_count = download_count + 1 WHERE id = ?', [share.id]).catch(() => {});
    }
    db.query('INSERT INTO audit_log (user_id, action, target_path, ip) VALUES (?, ?, ?, ?)',
      [null, 'share_access', share.file_path, clientIpOf(req)]).catch(() => {});

    streamFile(req, res, abs, type, st);
    return true;
  };
}

function clientIpOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

// Minimal, self-contained unlock page (no external assets).
function unlockPage(res, actionPath, wrong) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Protected file</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1320;color:#e7ebf3}
.c{background:#171c2b;border:1px solid #2a3145;border-radius:12px;padding:28px;width:320px;max-width:92vw}
h1{font-size:18px;margin:0 0 4px}p{color:#8b94a7;margin:0 0 16px}
input,button{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #2a3145;font:inherit;box-sizing:border-box}
input{background:#0f1320;color:#e7ebf3;margin-bottom:12px}button{background:#4d84ff;color:#fff;border:0;cursor:pointer;font-weight:600}
.e{color:#ff6169;font-size:13px;margin-bottom:10px}</style>
<div class="c"><h1>🔒 Protected file</h1><p>Enter the password to access this file.</p>
${wrong ? '<div class="e">Incorrect password. Try again.</div>' : ''}
<form method="GET" action="${actionPath}"><input type="password" name="pw" placeholder="Password" autofocus required>
<button type="submit">Unlock</button></form></div>`;
  res.writeHead(wrong ? 401 : 401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

module.exports = { createShareHandler };
