'use strict';

/**
 * HTTP response helpers: CORS/common headers, plain-text responses, and the
 * Range-aware file streamer used for both masters and cached variants.
 */

const fs = require('fs');

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

// Stream a file with immutable caching + HTTP Range support (206 partial content),
// honoring HEAD. Used for video seeking and for serving any on-disk file.
function streamFile(req, res, filePath, type, stat) {
  const total = stat.size;
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Last-Modified': stat.mtime.toUTCString(),
  };
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

module.exports = { setCommon, send, streamFile };
