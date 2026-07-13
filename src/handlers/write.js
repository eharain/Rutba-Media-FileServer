'use strict';

/**
 * Authenticated writes (PUT/DELETE) for masters. Authorized by either
 * `Authorization: Bearer $UPLOAD_TOKEN` (the Strapi provider), the
 * `X-Upload-Token: $UPLOAD_TOKEN` fallback (for front-ends that strip
 * Authorization, e.g. LiteSpeed/Passenger on Hostinger), or
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
const crypto = require('crypto');
const sharp = require('../sharp');
const { resolveSafe, relOf } = require('../util');
const { send, clientIp } = require('../http');
const { hasRole } = require('../auth');
const { normalizeMetadata, normalizeProbe } = require('../metadata');
const { MIME, RASTER, HDR_VISIBILITY, HDR_CLUSTER_SECRET, HDR_CLUSTER_REPLICATED, HDR_UPLOAD_TOKEN, SIDECAR_EXT } = require('../constants');
const { visibilityFor, writeSidecar, removeSidecar } = require('../visibility');

// `index` is the optional best-effort metadata/audit hook (fileindex.js). It is a
// no-op object when the DB layer is off, so the write path is unchanged without a DB.
const NOOP_INDEX = { recordPut() {}, recordDelete() {} };
// `trash` (trash.js) is disabled without a DB, in which case DELETE hard-unlinks
// exactly as before; when enabled a DELETE moves the master to the trash instead.
const NOOP_TRASH = { enabled: false, async moveToTrash() { return false; } };

function createWriteHandler({ config, cache, cluster, storage = null, index = NOOP_INDEX, trash = NOOP_TRASH, auth = null, db = null, ffmpeg = null }) {
  return async function handleWrite(req, res, reqRel) {
    const meta = { ip: clientIp(req), userAgent: req.headers['user-agent'] || '' };
    const bearerOk = config.uploadToken && req.headers.authorization === `Bearer ${config.uploadToken}`;
    // Fallback for front-ends that strip Authorization (LiteSpeed/Passenger): the
    // provider also sends the raw token in X-Upload-Token, which passes through.
    const tokenHdrOk = config.uploadToken && req.headers[HDR_UPLOAD_TOKEN] === config.uploadToken;
    const clusterOk = config.clusterSecret && req.headers[HDR_CLUSTER_SECRET] === config.clusterSecret;
    // Additional path (only when the DB layer is on): a logged-in editor/admin may
    // write with their session/API bearer token, so the web UI works without the
    // shared UPLOAD_TOKEN. The upload is attributed to that user. Purely additive —
    // it never affects the token/cluster paths above.
    let actingUser = null;
    if (!bearerOk && !tokenHdrOk && !clusterOk && auth) {
      const ctx = await auth.authenticate(req).catch(() => null);
      if (ctx && hasRole(ctx, 'editor')) actingUser = ctx.user;
    }
    if (!bearerOk && !tokenHdrOk && !clusterOk && !actingUser) return send(res, 401, 'Unauthorized');
    if (actingUser) meta.userId = actingUser.id;

    // Validate + normalize the rel against the default volume (the URL namespace).
    const dest0 = resolveSafe(config.masterDir, reqRel);
    if (!dest0 || dest0 === config.masterDir) return send(res, 403, 'Forbidden');
    // Visibility sidecars are managed internally; never let a client write one.
    if (reqRel.endsWith(SIDECAR_EXT)) return send(res, 403, 'Forbidden');
    const rel = relOf(config.masterDir, dest0);

    // A replicated write (from a peer) must not fan out again.
    const replicated = !!req.headers[HDR_CLUSTER_REPLICATED];
    const visibility = visibilityFor(rel, req.headers[HDR_VISIBILITY], config.privatePaths);

    if (req.method === 'DELETE') {
      // Find where the master actually lives (any volume); default if not present.
      const found = storage ? await storage.resolveRead(rel) : null;
      const target = found ? found.abs : dest0;
      // With trash on (DB layer), move the master out into the trash so it can be
      // restored; otherwise unlink it. Either way it leaves the served volumes, so
      // GETs 404 and the cluster stays consistent. A replicated delete (from a peer)
      // always hard-unlinks — trash is a primary-node recovery concept.
      if (trash.enabled && !replicated) await trash.moveToTrash(target, rel);
      else await fsp.unlink(target).catch(() => {});
      await removeSidecar(target);
      await cache.purgeForPath(rel);
      if (cluster && cluster.enabled && !replicated) cluster.replicateDelete(rel, visibility);
      index.recordDelete(rel, meta);
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

    // Per-user storage quota. Only session uploads are metered (token/cluster/provider
    // uploads have no owner and are unmetered). Pre-check against the declared length
    // so an over-quota upload is refused before the body is stored; a post-check after
    // the write backstops chunked uploads with no Content-Length.
    let quotaBytes = null, usageExcl = 0;
    if (actingUser && db && db.enabled) {
      const urow = await db.one('SELECT storage_quota_bytes FROM users WHERE id = ?', [actingUser.id]).catch(() => null);
      quotaBytes = urow && urow.storage_quota_bytes != null ? Number(urow.storage_quota_bytes) : null;
      if (quotaBytes != null) {
        const agg = await db.one(
          "SELECT COALESCE(SUM(size_bytes),0) AS s FROM files WHERE owner_user_id = ? AND status='active' AND path <> ?",
          [actingUser.id, rel]).catch(() => null);
        usageExcl = agg ? Number(agg.s) || 0 : 0;
        if (Number.isFinite(declared) && usageExcl + declared > quotaBytes) {
          send(res, 413, 'Storage quota exceeded');
          req.resume();
          return;
        }
      }
    }

    // Choose the destination volume (multi-volume placement). An existing master is
    // replaced in place; otherwise the configured policy picks a writable volume. In
    // a single-volume setup this is always the default (masterDir), so behavior is
    // unchanged.
    let dest = dest0;
    if (storage) {
      const place = await storage.placeWrite(rel, { sizeHint: Number.isFinite(declared) ? declared : 0 });
      if (!place) return send(res, 507, 'Insufficient Storage');
      dest = place.abs;
    }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.up.' + process.pid + '.tmp';
    let tooLarge = false;
    // Hash the body as it streams so we can store a content checksum (powers
    // duplicate detection) without a second read. Cheap next to the disk write.
    const hash = crypto.createHash('sha256');
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        let received = 0;
        req.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          if (limit && received > limit) { tooLarge = true; req.unpipe(ws); ws.destroy(); req.destroy(); reject(new Error('payload too large')); }
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
    const checksum = tooLarge ? null : hash.digest('hex');
    // Stat for the actual size (a stat failure just leaves size 0).
    let size = 0;
    try { size = (await fsp.stat(dest)).size; } catch { /* ignore */ }
    // Quota post-check (backstops chunked uploads with no Content-Length). Roll the
    // just-written master back so it is never served, replicated, or indexed.
    if (quotaBytes != null && usageExcl + size > quotaBytes) {
      await fsp.unlink(dest).catch(() => {});
      return send(res, 413, 'Storage quota exceeded');
    }
    await cache.purgeForPath(rel);
    // Record an explicit visibility override (sidecar) only when one was sent;
    // path-derived visibility needs no sidecar.
    if (req.headers[HDR_VISIBILITY]) await writeSidecar(dest, visibility);
    // Fan the new master out to eligible peers (unless this very write was a replica).
    if (cluster && cluster.enabled && !replicated) cluster.replicatePut(rel, dest, visibility);
    // Capture metadata (best-effort, never fails the PUT): pixel dimensions + EXIF
    // for raster images (sharp), or duration/codecs/dimensions for video & audio
    // (ffprobe).
    const relExt = path.extname(rel).toLowerCase();
    let width = null, height = null, imgMeta = null;
    if (sharp && RASTER.has(relExt)) {
      try { const m = await sharp(dest).metadata(); width = m.width || null; height = m.height || null; imgMeta = normalizeMetadata(m); } catch { /* ignore */ }
    } else if (ffmpeg && ffmpeg.enabled && /^(video|audio)\//.test(MIME[relExt] || '')) {
      try { const pr = await ffmpeg.probe(dest); if (pr) { width = pr.width; height = pr.height; imgMeta = normalizeProbe(pr); } } catch { /* ignore */ }
    }
    // Best-effort metadata index + audit (no-op without a DB).
    index.recordPut(rel, { size, visibility, ownerUserId: actingUser ? actingUser.id : null, checksum, width, height, metadata: imgMeta }, meta);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, path: '/' + rel, visibility }));
  };
}

module.exports = { createWriteHandler };
