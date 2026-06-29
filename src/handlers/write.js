'use strict';

/**
 * Authenticated writes (PUT/DELETE) for masters. Authorized by either
 * `Authorization: Bearer $UPLOAD_TOKEN` (the Strapi provider) or
 * `X-Cluster-Secret: $CLUSTER_SECRET` (a sibling node replicating). Writes are
 * atomic (temp file + rename) and always purge the master's cached variants so
 * stale resizes never linger.
 *
 *   PUT    /<path>   (body = bytes)   store/replace a master       -> 201 {ok, path}
 *   DELETE /<path>                    remove master + purge cache   -> 204 (idempotent)
 *
 * Clustering: a fresh (non-replicated) write fans the master out to eligible peers
 * for its visibility; a write carrying X-Cluster-Replicated:1 is stored but NOT
 * re-fanned-out (loop prevention). Visibility comes from the X-Visibility header
 * (persisted in a sidecar) or the path (PRIVATE_PATHS). Sidecar files are internal
 * and cannot be written directly.
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
const { HDR_VISIBILITY, HDR_CLUSTER_SECRET, HDR_CLUSTER_REPLICATED, SIDECAR_EXT } = require('../constants');
const { visibilityFor, writeSidecar, removeSidecar } = require('../visibility');

function createWriteHandler({ config, cache, cluster }) {
  return async function handleWrite(req, res, reqRel) {
    const bearerOk = config.uploadToken && req.headers.authorization === `Bearer ${config.uploadToken}`;
    const clusterOk = config.clusterSecret && req.headers[HDR_CLUSTER_SECRET] === config.clusterSecret;
    if (!bearerOk && !clusterOk) return send(res, 401, 'Unauthorized');

    const dest = resolveSafe(config.masterDir, reqRel);
    if (!dest || dest === config.masterDir) return send(res, 403, 'Forbidden');
    // Visibility sidecars are managed internally; never let a client write one.
    if (reqRel.endsWith(SIDECAR_EXT)) return send(res, 403, 'Forbidden');
    const rel = relOf(config.masterDir, dest);

    // A replicated write (from a peer) must not fan out again.
    const replicated = !!req.headers[HDR_CLUSTER_REPLICATED];
    const visibility = visibilityFor(rel, req.headers[HDR_VISIBILITY], config.privatePaths);

    if (req.method === 'DELETE') {
      await fsp.unlink(dest).catch(() => {});
      await removeSidecar(dest);
      await cache.purgeForPath(rel);
      if (cluster && cluster.enabled && !replicated) cluster.replicateDelete(rel, visibility);
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
    // Record an explicit visibility override (sidecar) only when one was sent;
    // path-derived visibility needs no sidecar.
    if (req.headers[HDR_VISIBILITY]) await writeSidecar(dest, visibility);
    // Fan the new master out to eligible peers (unless this very write was a replica).
    if (cluster && cluster.enabled && !replicated) cluster.replicatePut(rel, dest, visibility);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, path: '/' + rel, visibility }));
  };
}

module.exports = { createWriteHandler };
