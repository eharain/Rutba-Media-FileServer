'use strict';

/**
 * WebDAV (RFC 4918, class 1 + minimal class 2 locking) mounted at `/_dav/`, so the
 * whole master store — spread across storage volumes — is mountable as a network
 * drive (Windows Explorer, macOS Finder, rclone, davfs2). Its own namespace keeps
 * the public media/upload routes untouched; gated on the DB layer (needs accounts)
 * and `config.webdavEnabled` — when off, `/_dav/*` is 404.
 *
 * Auth: HTTP Basic against platform users (use HTTPS). Reads (GET/HEAD/PROPFIND/
 * OPTIONS/LOCK) need `viewer`+, writes (PUT/DELETE/MKCOL/MOVE/COPY/PROPPATCH) need
 * `editor`+. File mutations reuse `masterops` (placement, checksum, indexing,
 * trash, cluster replication), so DAV writes behave like API/console writes.
 *
 * Locking is advisory (in-memory) — enough to satisfy clients that require LOCK
 * before writing; it is not a hard concurrency guarantee.
 */

const path = require('path');
const crypto = require('crypto');
const { streamFile, send } = require('../http');
const { MIME } = require('../constants');
const { hasRole } = require('../auth');

const PREFIX = '/_dav';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'LOCK', 'UNLOCK']);

function createWebdavHandler({ config, db, auth, storage, masterops }) {
  const enabled = () => db.enabled && config.webdavEnabled;
  const locks = new Map(); // rel -> { token, owner, expires }

  function challenge(res) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Rutba Media WebDAV"', 'Content-Type': 'text/plain' });
    res.end('Authentication required');
  }

  // Map a request path under /_dav to a clean rel (or null if it escapes the root).
  function relFromPath(pathname) {
    let p = pathname.slice(PREFIX.length);
    try { p = decodeURIComponent(p); } catch { return null; }
    const norm = path.posix.normalize(p).replace(/^\/+/, '').replace(/\/+$/, '');
    if (norm === '' || norm === '.') return '';
    if (norm.startsWith('..')) return null;
    return norm;
  }

  return async function handleDav(req, res, url) {
    if (!enabled()) { send(res, 404, 'Not Found'); return true; }

    // Basic auth.
    const hdr = req.headers['authorization'] || '';
    if (!/^Basic\s+/i.test(hdr)) { challenge(res); return true; }
    let login, password;
    try { const dec = Buffer.from(hdr.replace(/^Basic\s+/i, ''), 'base64').toString('utf8'); const i = dec.indexOf(':'); login = dec.slice(0, i); password = dec.slice(i + 1); } catch { challenge(res); return true; }
    const ctx = await auth.verifyCredentials(login, password).catch(() => null);
    if (!ctx) { challenge(res); return true; }
    if (!READ_METHODS.has(req.method) && !hasRole(ctx, 'editor')) { send(res, 403, 'Forbidden (editor role required)'); return true; }
    if (!hasRole(ctx, 'viewer')) { send(res, 403, 'Forbidden'); return true; }

    const rel = relFromPath(url.pathname);
    if (rel === null) { send(res, 403, 'Forbidden'); return true; }

    try {
      switch (req.method) {
        case 'OPTIONS': return options(res);
        case 'PROPFIND': return await propfind(req, res, url, rel);
        case 'PROPPATCH': return await proppatch(req, res, url, rel);
        case 'GET': case 'HEAD': return await get(req, res, rel);
        case 'PUT': return await put(req, res, rel, ctx);
        case 'DELETE': return await del(req, res, rel, ctx);
        case 'MKCOL': return await mkcol(req, res, rel);
        case 'MOVE': case 'COPY': return await moveCopy(req, res, url, rel, ctx, req.method === 'MOVE');
        case 'LOCK': return await lock(req, res, url, rel, ctx);
        case 'UNLOCK': return unlock(req, res, rel);
        default: send(res, 405, 'Method Not Allowed'); return true;
      }
    } catch (e) {
      if (e.statusCode) send(res, e.statusCode, e.message);
      else { console.warn('[media] webdav error:', e.message); send(res, 500, 'Server Error'); }
      return true;
    }
  };

  function options(res) {
    res.writeHead(200, {
      DAV: '1, 2',
      Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK',
      'MS-Author-Via': 'DAV',
      'Accept-Ranges': 'bytes',
      'Content-Length': '0',
    });
    res.end();
    return true;
  }

  async function get(req, res, rel) {
    const s = await storage.statPath(rel);
    if (!s || s.type !== 'file') { send(res, s && s.type === 'dir' ? 405 : 404, s ? 'Method Not Allowed on a collection' : 'Not Found'); return true; }
    const ext = path.extname(s.abs).toLowerCase();
    streamFile(req, res, s.abs, MIME[ext] || 'application/octet-stream', s.stat);
    return true;
  }

  async function put(req, res, rel, ctx) {
    if (rel === '') { send(res, 405, 'Method Not Allowed'); return true; }
    const s = await storage.statPath(rel);
    if (s && s.type === 'dir') { send(res, 405, 'Cannot PUT onto a collection'); return true; }
    const existed = !!s;
    const sizeHint = parseInt(req.headers['content-length'], 10) || 0;
    await masterops.writeStream(rel, req, { actingUser: ctx.user, sizeHint, meta: { userId: ctx.user.id } });
    send(res, existed ? 204 : 201);
    return true;
  }

  async function del(req, res, rel, ctx) {
    if (rel === '') { send(res, 403, 'Refusing to delete the root'); return true; }
    const handled = await deleteTree(rel, ctx);
    send(res, handled ? 204 : 404, handled ? undefined : 'Not Found');
    return true;
  }

  async function deleteTree(rel, ctx) {
    const s = await storage.statPath(rel);
    if (!s) return false;
    if (s.type === 'file') { await masterops.deleteMaster(rel, { meta: { userId: ctx.user.id } }); return true; }
    for (const child of await storage.listDir(rel)) await deleteTree(child.rel, ctx);
    await storage.removeDir(rel);
    return true;
  }

  async function mkcol(req, res, rel) {
    if (rel === '') { send(res, 405, 'Method Not Allowed'); return true; }
    const s = await storage.statPath(rel);
    if (s) { send(res, 405, 'Already exists'); return true; }
    const parent = path.posix.dirname(rel);
    if (parent !== '.' && parent !== '' ) { const ps = await storage.statPath(parent); if (!ps || ps.type !== 'dir') { send(res, 409, 'Parent not found'); return true; } }
    await storage.mkcol(rel);
    send(res, 201);
    return true;
  }

  async function moveCopy(req, res, url, rel, ctx, move) {
    const destHdr = req.headers['destination'];
    if (!destHdr) { send(res, 400, 'Missing Destination'); return true; }
    let destPath;
    try { destPath = new URL(destHdr, `http://${req.headers.host || 'x'}`).pathname; } catch { send(res, 400, 'Bad Destination'); return true; }
    if (!destPath.startsWith(PREFIX + '/') && destPath !== PREFIX) { send(res, 502, 'Destination outside WebDAV root'); return true; }
    const dstRel = relFromPath(destPath);
    if (dstRel === null || dstRel === '') { send(res, 403, 'Bad Destination'); return true; }
    if (dstRel === rel) { send(res, 403, 'Source and destination are the same'); return true; }

    const overwrite = (req.headers['overwrite'] || 'T').toUpperCase() !== 'F';
    const dstExists = !!(await storage.statPath(dstRel));
    if (dstExists && !overwrite) { send(res, 412, 'Precondition Failed'); return true; }
    if (dstExists) await deleteTree(dstRel, ctx); // replace

    await masterops.moveCopy(rel, dstRel, { move, actingUser: ctx.user });
    send(res, dstExists ? 204 : 201);
    return true;
  }

  // ── PROPFIND ────────────────────────────────────────────────────────────────
  async function propfind(req, res, url, rel) {
    const s = await storage.statPath(rel);
    if (!s) { send(res, 404, 'Not Found'); return true; }
    // Drain any request body (we return a standard prop set regardless of the query).
    await drain(req);
    const depth = (req.headers['depth'] || '1').toLowerCase();
    const selfHref = hrefFor(url.pathname, s.type === 'dir');
    const responses = [entryXml(selfHref, s.type === 'dir', s.stat, rel)];
    if (s.type === 'dir' && depth !== '0') {
      const baseHref = selfHref.endsWith('/') ? selfHref : selfHref + '/';
      for (const child of await storage.listDir(rel)) {
        const href = baseHref + child.name.split('/').map(encodeURIComponent).join('/') + (child.isDir ? '/' : '');
        responses.push(entryXml(href, child.isDir, child.stat, child.rel));
      }
    }
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  function entryXml(href, isDir, stat, rel) {
    const name = rel === '' ? '' : path.posix.basename(rel);
    const props = [`<D:displayname>${xmlEscape(name)}</D:displayname>`];
    if (isDir) props.push('<D:resourcetype><D:collection/></D:resourcetype>');
    else {
      const ext = path.extname(rel).toLowerCase();
      props.push('<D:resourcetype/>');
      props.push(`<D:getcontentlength>${stat ? stat.size : 0}</D:getcontentlength>`);
      props.push(`<D:getcontenttype>${xmlEscape(MIME[ext] || 'application/octet-stream')}</D:getcontenttype>`);
      if (stat) props.push(`<D:getetag>${etagOf(href, stat)}</D:getetag>`);
    }
    if (stat) {
      props.push(`<D:getlastmodified>${new Date(stat.mtime).toUTCString()}</D:getlastmodified>`);
      props.push(`<D:creationdate>${new Date(stat.birthtime && stat.birthtime.getTime() ? stat.birthtime : stat.mtime).toISOString()}</D:creationdate>`);
    }
    props.push('<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>');
    return `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }

  // Accept-and-ignore property updates (e.g. Windows setting Win32 timestamps).
  async function proppatch(req, res, url, rel) {
    const s = await storage.statPath(rel);
    if (!s) { send(res, 404, 'Not Found'); return true; }
    await drain(req);
    const href = hrefFor(url.pathname, s.type === 'dir');
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }

  // ── Minimal (advisory) locking ────────────────────────────────────────────────
  async function lock(req, res, url, rel, ctx) {
    await drain(req);
    const existing = locks.get(rel);
    const token = existing ? existing.token : 'opaquelocktoken:' + crypto.randomUUID();
    locks.set(rel, { token, owner: ctx.user.username, expires: Date.now() + 3600_000 });
    const href = hrefFor(url.pathname, false);
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
      `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth>` +
      `<D:owner>${xmlEscape(ctx.user.username)}</D:owner><D:timeout>Second-3600</D:timeout>` +
      `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
      `<D:lockroot><D:href>${xmlEscape(href)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>`, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }

  function unlock(req, res, rel) {
    locks.delete(rel);
    send(res, 204);
    return true;
  }

  function hrefFor(pathname, isDir) {
    let h = pathname;
    if (isDir && !h.endsWith('/')) h += '/';
    return h;
  }
  function etagOf(href, stat) { return '"' + crypto.createHash('sha1').update(href).digest('hex').slice(0, 12) + '-' + stat.size.toString(16) + '"'; }
}

function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function drain(req) { return new Promise((resolve) => { req.on('data', () => {}); req.on('end', resolve); req.on('error', resolve); if (req.complete) resolve(); }); }

module.exports = { createWebdavHandler, DAV_PREFIX: PREFIX };
