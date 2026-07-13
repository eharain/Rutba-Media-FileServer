'use strict';

/**
 * Trash & Recovery. When the DB layer is on, a DELETE moves the master into a
 * trash area (a sibling of masterDir, outside it so trashed bytes are never
 * servable) instead of unlinking it, and marks the `files` row `trashed`. Restore
 * moves the bytes back and re-activates (and re-replicates to cluster peers, since
 * the delete had propagated a delete to them). Purge removes the retained bytes and
 * the row for good; empty-trash purges everything trashed.
 *
 * With no DB, `enabled` is false and callers hard-unlink exactly as before — trash
 * needs the `files` row as its manifest (original path, trashed_at), so it only
 * makes sense alongside the database.
 *
 * The retained file is named by a stable hash of its original path, so restore can
 * find it from the row alone with no extra schema. Renames fall back to copy+unlink
 * across volumes (EXDEV).
 */

const fsp = require('fs/promises');
const path = require('path');
const { pathHash, resolveSafe } = require('./util');
const { writeSidecar } = require('./visibility');

function createTrash({ config, db, cluster, storage = null }) {
  const enabled = !!(db && config.db); // trash is a DB-layer feature
  const trashDir = config.trashDir;

  // Retained path for a master's original relative path (stable, collision-free).
  function trashPathFor(rel) {
    return path.join(trashDir, pathHash(rel) + (path.extname(rel) || '.bin'));
  }

  // Move a file, tolerating cross-volume renames.
  async function moveFile(from, to) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try { await fsp.rename(from, to); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(from, to);
      await fsp.unlink(from).catch(() => {});
    }
  }

  return {
    enabled,
    trashDir,

    // Called from the write handler on DELETE (when enabled). Moves the master out
    // of masterDir into the trash. Returns true if bytes were retained.
    async moveToTrash(masterAbs, rel) {
      if (!enabled) return false;
      try {
        const st = await fsp.stat(masterAbs).catch(() => null);
        if (!st || !st.isFile()) return false;
        await moveFile(masterAbs, trashPathFor(rel));
        return true;
      } catch (e) {
        // Never fail the DELETE because trashing hiccuped — fall back to unlink.
        console.warn(`[media] trash.moveToTrash failed (${e.code || e.message}); unlinking instead`);
        await fsp.unlink(masterAbs).catch(() => {});
        return false;
      }
    },

    // Restore a trashed master back into masterDir and re-activate its row.
    async restore(rel) {
      if (!enabled) throwErr(503, 'trash_disabled', 'Trash is not enabled');
      const row = await db.one(`SELECT id, path, visibility, status FROM files WHERE path = ? LIMIT 1`, [rel]);
      if (!row) throwErr(404, 'not_found', 'No trashed file at that path');
      if (row.status !== 'trashed') throwErr(409, 'not_trashed', 'File is not in the trash');
      const trashAbs = trashPathFor(rel);
      const st = await fsp.stat(trashAbs).catch(() => null);
      if (!st || !st.isFile()) throwErr(410, 'no_retained_copy', 'No retained copy exists to restore');

      // Place the restored master back on a volume (multi-volume aware).
      let dest;
      if (storage) { const place = await storage.placeWrite(rel); if (!place) throwErr(507, 'no_storage', 'No writable storage volume'); dest = place.abs; }
      else dest = resolveSafe(config.masterDir, rel);
      if (!dest) throwErr(400, 'bad_path', 'Invalid path');
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await moveFile(trashAbs, dest);
      await db.query(`UPDATE files SET status='active', trashed_at=NULL WHERE id=?`, [row.id]);

      // Re-establish an explicit private sidecar if needed, then re-replicate the
      // master to eligible peers (the earlier delete removed it from them).
      const visibility = row.visibility === 'private' ? 'private' : 'public';
      if (visibility === 'private') await writeSidecar(dest, 'private').catch(() => {});
      if (cluster && cluster.enabled) cluster.replicatePut(rel, dest, visibility);
      return { ok: true, path: '/' + rel, visibility };
    },

    // Permanently remove a trashed master's bytes and its row.
    async purge(rel) {
      if (!enabled) throwErr(503, 'trash_disabled', 'Trash is not enabled');
      await fsp.unlink(trashPathFor(rel)).catch(() => {});
      await db.query(`DELETE FROM files WHERE path=? AND status='trashed'`, [rel]);
      return { ok: true };
    },

    // Purge every trashed master. Returns how many rows were removed.
    async emptyTrash() {
      if (!enabled) throwErr(503, 'trash_disabled', 'Trash is not enabled');
      const rows = await db.query(`SELECT path FROM files WHERE status='trashed'`);
      for (const r of rows) await fsp.unlink(trashPathFor(r.path)).catch(() => {});
      const res = await db.query(`DELETE FROM files WHERE status='trashed'`);
      return { ok: true, purged: res.affectedRows != null ? res.affectedRows : rows.length };
    },
  };
}

function throwErr(statusCode, error, message) { const e = new Error(message || error); e.statusCode = statusCode; e.error = error; throw e; }

module.exports = { createTrash };
