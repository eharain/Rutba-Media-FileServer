'use strict';

/**
 * Version control for masters.
 *
 * A `PUT` over an existing master used to destroy the previous bytes outright —
 * `file_versions` was declared and never written to. Now the outgoing copy is moved
 * aside *before* the new one lands, so replacing a file is recoverable in exactly
 * the way deleting one already was.
 *
 * Storage reuses the trash area's discipline: retained bytes live OUTSIDE every
 * served volume (under `<TRASH_DIR>/versions`), named by a stable hash of the
 * master's path plus the version number, so a restore needs nothing but the row.
 * Cross-volume moves fall back to copy+unlink (EXDEV), same as the trash.
 *
 * Retention is capped by count and/or age — an uncapped version store is a disk
 * leak with good intentions. Trimming happens after each new version is recorded, so
 * the cap is enforced continuously rather than by a periodic job that might not run.
 *
 * Gated on the DB layer: with no database there is no `files` row to hang a version
 * off, so `enabled` is false and a PUT behaves exactly as it always did.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathHash, pathKey } = require('./util');
const { MIME } = require('./constants');

function createVersions({ config, db, storage = null }) {
  const dir = config.versionsDir;
  const retainCount = config.versionRetainCount;
  const retainDays = config.versionRetainDays;
  // A retain count of 0 turns the feature off without needing a second flag.
  const enabled = !!(db && config.db && config.versionsEnabled && retainCount > 0);

  const storedName = (rel, versionNo) => `${pathHash(rel)}.${versionNo}${path.extname(rel) || '.bin'}`;
  const storedAbs = (rel, versionNo) => path.join(dir, storedName(rel, versionNo));

  async function moveFile(from, to) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try { await fsp.rename(from, to); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(from, to);
      await fsp.unlink(from).catch(() => {});
    }
  }

  const api = {
    enabled,
    dir,
    retainCount,
    retainDays,

    /**
     * Called from the write path with the master that is ABOUT to be replaced.
     * Moves its bytes into the version store and records the row. Never throws —
     * failing to keep history must not fail the upload.
     *
     * Returns the new version number, or null when nothing was retained.
     */
    async retain(rel, currentAbs, { userId = null } = {}) {
      if (!enabled) return null;
      try {
        const st = await fsp.stat(currentAbs).catch(() => null);
        if (!st || !st.isFile()) return null;

        const file = await db.one('SELECT id, checksum_sha256, mime FROM files WHERE path_hash = ?', [pathKey(rel)]);
        if (!file) return null; // not indexed ⇒ nothing to hang a version off

        const last = await db.one('SELECT MAX(version_no) AS n FROM file_versions WHERE file_id = ?', [file.id]);
        const versionNo = (last && Number(last.n) ? Number(last.n) : 0) + 1;
        const dest = storedAbs(rel, versionNo);
        await moveFile(currentAbs, dest);
        await db.query(
          `INSERT INTO file_versions (file_id, version_no, size_bytes, mime, checksum_sha256, stored_path, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [file.id, versionNo, st.size, file.mime || MIME[path.extname(rel).toLowerCase()] || null,
           file.checksum_sha256 || null, storedName(rel, versionNo), userId]);
        await api.trim(rel, file.id);
        return versionNo;
      } catch (e) {
        console.warn(`[media] versions.retain(${rel}) failed: ${e.code || e.message}`);
        return null;
      }
    },

    /** Enforce the retention policy for one file (by count, then by age). */
    async trim(rel, fileId) {
      const doomed = [];
      // OFFSET cannot be a bound parameter in a prepared statement, so it is spliced
      // in — safe because `retainCount` is an integer clamped at config load, never
      // request input. (Binding it here failed silently and the cap did nothing.)
      const keep = Math.max(0, Math.floor(retainCount));
      const byCount = await db.query(
        `SELECT id, version_no, stored_path FROM file_versions WHERE file_id = ?
          ORDER BY version_no DESC LIMIT 1000 OFFSET ${keep}`, [fileId]).catch(() => []);
      doomed.push(...byCount);
      if (retainDays > 0) {
        const byAge = await db.query(
          `SELECT id, version_no, stored_path FROM file_versions
            WHERE file_id = ? AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [fileId, retainDays]).catch(() => []);
        doomed.push(...byAge);
      }
      const seen = new Set();
      for (const v of doomed) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        await fsp.unlink(path.join(dir, v.stored_path)).catch(() => {});
        await db.query('DELETE FROM file_versions WHERE id = ?', [v.id]).catch(() => {});
      }
      return seen.size;
    },

    /** List a master's retained versions, newest first. */
    async list(rel) {
      if (!db || !db.enabled) return [];
      const rows = await db.query(
        `SELECT v.id, v.version_no, v.size_bytes, v.mime, v.checksum_sha256, v.created_at, v.created_by,
                u.username AS created_by_username
           FROM file_versions v
           JOIN files f ON f.id = v.file_id
           LEFT JOIN users u ON u.id = v.created_by
          WHERE f.path_hash = ? ORDER BY v.version_no DESC`, [pathKey(rel)]).catch(() => []);
      return rows.map((r) => ({ ...r, size_bytes: Number(r.size_bytes) }));
    },

    /** A readable stream of one retained version (for download / preview). */
    async openVersion(rel, versionNo) {
      const row = await db.one(
        `SELECT v.stored_path, v.size_bytes, v.mime FROM file_versions v JOIN files f ON f.id = v.file_id
          WHERE f.path_hash = ? AND v.version_no = ? LIMIT 1`, [pathKey(rel), Number(versionNo)]);
      if (!row) return null;
      const abs = path.join(dir, row.stored_path);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) return null;
      return { abs, stat: st, mime: row.mime || 'application/octet-stream', stream: () => fs.createReadStream(abs) };
    },

    /**
     * Restore a version as the live master. The CURRENT bytes are retained first, so
     * a restore is itself undoable — otherwise "go back one" would destroy whatever
     * it was going back from.
     */
    async restore(rel, versionNo, { userId = null } = {}) {
      if (!enabled) throwErr(503, 'versions_disabled', 'Versioning is not enabled');
      const v = await api.openVersion(rel, versionNo);
      if (!v) throwErr(404, 'no_such_version', 'No retained copy of that version');

      const place = storage ? await storage.placeWrite(rel) : null;
      const dest = place ? place.abs : null;
      if (!dest) throwErr(507, 'no_storage', 'No writable storage volume');

      const current = await storage.resolveRead(rel);
      if (current) await api.retain(rel, current.abs, { userId });

      await fsp.mkdir(path.dirname(dest), { recursive: true });
      // Copy rather than move: the version stays available, so the history is not
      // consumed by reading from it.
      await fsp.copyFile(v.abs, dest);
      const st = await fsp.stat(dest);
      await db.query(
        `UPDATE files SET size_bytes = ?, mtime_ms = ?, status = 'active', trashed_at = NULL,
                volume_id = COALESCE(?, volume_id) WHERE path_hash = ?`,
        [st.size, Math.round(st.mtimeMs), place.volumeId, pathKey(rel)]);
      return { ok: true, path: '/' + rel, restoredVersion: Number(versionNo), size: st.size };
    },

    /** Delete one retained version for good. */
    async purge(rel, versionNo) {
      if (!db || !db.enabled) return false;
      const row = await db.one(
        `SELECT v.id, v.stored_path FROM file_versions v JOIN files f ON f.id = v.file_id
          WHERE f.path_hash = ? AND v.version_no = ? LIMIT 1`, [pathKey(rel), Number(versionNo)]);
      if (!row) return false;
      await fsp.unlink(path.join(dir, row.stored_path)).catch(() => {});
      await db.query('DELETE FROM file_versions WHERE id = ?', [row.id]);
      return true;
    },

    /** Drop every retained version of a master (used when it is purged for good). */
    async purgeAll(rel) {
      if (!db || !db.enabled) return 0;
      const rows = await db.query(
        `SELECT v.id, v.stored_path FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.path_hash = ?`,
        [pathKey(rel)]).catch(() => []);
      for (const r of rows) await fsp.unlink(path.join(dir, r.stored_path)).catch(() => {});
      if (rows.length) await db.query('DELETE FROM file_versions WHERE id IN (?)', [rows.map((r) => r.id)]).catch(() => {});
      return rows.length;
    },
  };

  return api;
}

function throwErr(statusCode, error, message) { const e = new Error(message || error); e.statusCode = statusCode; e.error = error; throw e; }

module.exports = { createVersions };
