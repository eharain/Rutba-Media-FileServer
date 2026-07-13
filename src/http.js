'use strict';

/**
 * HTTP response helpers: CORS/common headers, plain-text responses, and the
 * Range-aware file streamer used for both masters and cached variants.
 */

const fs = require('fs');
const crypto = require('crypto');

// Common headers on every response: permissive CORS (tunable), no MIME sniffing.
function setCommon(res, corsOrigin) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// Short plain-text (or empty 204) response.
function send(res, code, msg) {
  if (code === 204) { res.writeHead(204); return res.end(); }
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(msg);
}

// JSON response. `extraHeaders` lets callers add Set-Cookie etc.
function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders || {}) });
  res.end(body);
}

// Read and JSON-parse a request body, capped at `limit` bytes (default 1 MiB) so a
// giant/mislabeled body can't exhaust memory. Resolves {} for an empty body;
// rejects with err.statusCode 413 (too large) or 400 (invalid JSON).
function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { const e = new Error('Payload Too Large'); e.statusCode = 413; req.destroy(); return reject(e); }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { const e = new Error('Invalid JSON'); e.statusCode = 400; reject(e); }
    });
  });
}

// Best-effort client IP (honors a single X-Forwarded-For hop when behind a proxy).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

// Stream a file with immutable caching + HTTP Range support (206 partial content),
// honoring HEAD. Used for video seeking and for serving any on-disk file.
function streamFile(req, res, filePath, type, stat) {
  const total = stat.size;
  const lastMod = stat.mtime.toUTCString();
  // Strong validator that is STABLE across requests. We key it on the file's
  // identity (path) + size rather than mtime, because the LRU cache "touches"
  // (updates mtime of) a variant on every hit — an mtime-based ETag would change
  // each request and never revalidate. Masters are content-hash-named by Strapi
  // and variant cache files are content-addressed, so path+size uniquely and
  // stably identifies the bytes. Survives CDNs that strip Last-Modified, and lets
  // browsers/CDNs revalidate cheaply with a 304 + gives the edge a cache validator.
  const etag = '"' + crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16) + '-' + total.toString(16) + '"';
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Last-Modified': lastMod,
    'ETag': etag,
  };
  // Conditional GET -> 304 Not Modified (no body) when the validator still matches.
  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  const notModified = (inm && inm.split(',').some((t) => { const v = t.trim(); return v === etag || v === 'W/' + etag || v === '*'; }))
    || (!inm && ims && Date.parse(ims) >= Date.parse(lastMod));
  if (notModified) { res.writeHead(304, { 'Cache-Control': base['Cache-Control'], 'ETag': etag, 'Last-Modified': lastMod }); return res.end(); }
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null) {
      if (end === null) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
      start = Math.max(0, total - end); end = total - 1; // suffix range: last N bytes
    } else if (end === null || end >= total) {
      end = total - 1;
    }
    if (start > end || start >= total || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(filePath, { start, end });
    s.on('error', () => res.destroy());
    return s.pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(filePath);
  s.on('error', () => res.destroy());
  s.pipe(res);
}

module.exports = { setCommon, send, sendJson, readJson, clientIp, streamFile };
