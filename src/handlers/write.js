'use strict';

/**
 * Authenticated writes (PUT/DELETE) for masters. Requires
 * `Authorization: Bearer $UPLOAD_TOKEN`. Writes are atomic (temp file + rename)
 * and always purge the master's cached variants so stale resizes never linger.
 *
 *   PUT    /<path>   (body = bytes)   store/replace a master       -> 201 {ok, path}
 *   DELETE /<path>                    remove master + purge cache   -> 204 (idempotent)
 *
 * PUT bodies over `config.uploadMaxBytes` are rejected with 413 (Strapi-style
 * sizeLimit) — both up-front via Content-Length and mid-stream for chunked/
 * mislabeled bodies. A limit of 0 disables the check.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { resolveSafe, relOf } = require('../util');
const { send } = require('../http');

function createWriteHandler({ config, cache }) {
  return async function handleWrite(req, res, reqRel) {
    if (!config.uploadToken || req.headers.authorization !== `Bearer ${config.uploadToken}`) return send(res, 401, 'Unauthorized');

    const dest = resolveSafe(config.masterDir, reqRel);
    if (!dest || dest === config.masterDir) return send(res, 403, 'Forbidden');
    const rel = relOf(config.masterDir, dest);

    if (req.method === 'DELETE') {
      await fsp.unlink(dest).catch(() => {});
      await cache.purgeForPath(rel);
      return send(res, 204);
    }

    // PUT — enforce the size cap, then stream the body to a temp file and atomically
    // rename it into place; invalidate stale variants.
    const limit = config.uploadMaxBytes;
    const declared = parseInt(req.headers['content-length'], 10);
    if (limit && Number.isFinite(declared) && declared > limit) {
      send(res, 413, 'Payload Too Large');
      req.resume(); // discard the incoming body so the client still reads the 413
      return;
    }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.up.' + process.pid + '.tmp';
    let tooLarge = false;
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        let received = 0;
        if (limit) req.on('data', (chunk) => {
          received += chunk.length;
          if (received > limit) { tooLarge = true; req.unpipe(ws); ws.destroy(); req.destroy(); reject(new Error('payload too large')); }
        });
        req.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        req.pipe(ws);
      });
      await fsp.rename(tmp, dest);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      if (tooLarge) return send(res, 413, 'Payload Too Large');
      return send(res, 500, 'Upload failed');
    }
    await cache.purgeForPath(rel);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, path: '/' + rel }));
  };
}

module.exports = { createWriteHandler };
