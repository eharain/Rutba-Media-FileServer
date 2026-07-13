'use strict';

/**
 * Shared master mutations over the storage volumes, used by the WebDAV handler (and
 * available to any non-HTTP caller). Mirrors the write handler's semantics — atomic
 * writes, checksum + metadata indexing, trash-aware delete, cache purge, cluster
 * replication — but as plain functions on a `rel`, decoupled from request/response.
 *
 * writeStream : stream bytes into a placed master (create/replace) + index it.
 * deleteMaster: trash-aware delete of a single master.
 * move / copy : file or recursive-directory move/copy across volumes.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { normalizeMetadata, normalizeProbe } = require('./metadata');
const { RASTER, MIME } = require('./constants');
const { visibilityFor, writeSidecar, removeSidecar } = require('./visibility');

function createMasterOps({ config, storage, cache, cluster, index, trash, sharp, ffmpeg }) {
  const visOf = (rel) => visibilityFor(rel, undefined, config.privatePaths);

  // Stream `readable` into the master at `rel` (placed per policy), atomically, then
  // index it (checksum + dimensions/EXIF or ffprobe). Returns { size, checksum }.
  async function writeStream(rel, readable, { actingUser = null, sizeHint = 0, meta = {} } = {}) {
    const place = await storage.placeWrite(rel, { sizeHint });
    if (!place) { const e = new Error('Insufficient Storage'); e.statusCode = 507; throw e; }
    const dest = place.abs;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.up.' + process.pid + '.tmp';
    const hash = crypto.createHash('sha256');
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        readable.on('data', (c) => hash.update(c));
        readable.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        readable.pipe(ws);
      });
      await fsp.rename(tmp, dest);
    } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }

    const checksum = hash.digest('hex');
    let size = 0; try { size = (await fsp.stat(dest)).size; } catch { /* ignore */ }
    const visibility = visOf(rel);
    await cache.purgeForPath(rel);
    if (cluster && cluster.enabled) cluster.replicatePut(rel, dest, visibility);

    const ext = path.extname(rel).toLowerCase();
    let width = null, height = null, mdata = null;
    if (sharp && RASTER.has(ext)) {
      try { const m = await sharp(dest).metadata(); width = m.width || null; height = m.height || null; mdata = normalizeMetadata(m); } catch { /* ignore */ }
    } else if (ffmpeg && ffmpeg.enabled && /^(video|audio)\//.test(MIME[ext] || '')) {
      try { const pr = await ffmpeg.probe(dest); if (pr) { width = pr.width; height = pr.height; mdata = normalizeProbe(pr); } } catch { /* ignore */ }
    }
    index.recordPut(rel, { size, visibility, ownerUserId: actingUser ? actingUser.id : null, checksum, width, height, metadata: mdata }, meta);
    return { size, checksum };
  }

  // Trash-aware delete of a single master.
  async function deleteMaster(rel, { meta = {} } = {}) {
    const found = await storage.resolveRead(rel);
    const target = found ? found.abs : storage.defaultAbs(rel);
    if (trash && trash.enabled) await trash.moveToTrash(target, rel);
    else await fsp.unlink(target).catch(() => {});
    await removeSidecar(target);
    await cache.purgeForPath(rel);
    if (cluster && cluster.enabled) cluster.replicateDelete(rel, visOf(rel));
    index.recordDelete(rel, meta);
  }

  // Move or copy a file across volumes: rename when possible, else copy (+unlink for
  // move); keeps the index path in sync.
  async function fileMoveCopy(srcAbs, srcRel, dstRel, move, actingUser) {
    if (move) {
      const place = await storage.placeWrite(dstRel);
      if (!place) { const e = new Error('Insufficient Storage'); e.statusCode = 507; throw e; }
      await fsp.mkdir(path.dirname(place.abs), { recursive: true });
      try { await fsp.rename(srcAbs, place.abs); }
      catch (e) { if (e.code !== 'EXDEV') throw e; await fsp.copyFile(srcAbs, place.abs); await fsp.unlink(srcAbs).catch(() => {}); }
      await index.renamePath(srcRel, dstRel);
      await cache.purgeForPath(srcRel); await cache.purgeForPath(dstRel);
      if (cluster && cluster.enabled) { cluster.replicatePut(dstRel, place.abs, visOf(dstRel)); cluster.replicateDelete(srcRel, visOf(srcRel)); }
    } else {
      await writeStream(dstRel, fs.createReadStream(srcAbs), { actingUser });
    }
  }

  // Move or copy a rel (file or directory, recursive). Overwrites the destination.
  async function moveCopy(srcRel, dstRel, { move = false, actingUser = null } = {}) {
    const s = await storage.statPath(srcRel);
    if (!s) { const e = new Error('Not Found'); e.statusCode = 404; throw e; }
    if (s.type === 'file') { await fileMoveCopy(s.abs, srcRel, dstRel, move, actingUser); return; }
    // Directory: recreate at destination and recurse over children.
    await storage.mkcol(dstRel);
    for (const child of await storage.listDir(srcRel)) {
      const dstChild = dstRel === '' ? child.name : dstRel + '/' + child.name;
      await moveCopy(child.rel, dstChild, { move, actingUser });
    }
    if (move) await storage.removeDir(srcRel);
  }

  return { writeStream, deleteMaster, moveCopy };
}

module.exports = { createMasterOps };
