'use strict';

/**
 * Best-effort metadata index + audit trail for master writes.
 *
 * The filesystem stays the source of truth: every method here is wrapped so a DB
 * error is logged and swallowed, never failing a PUT/DELETE. When `db.enabled` is
 * false the whole object is inert no-ops, so the write path is unchanged without a
 * database.
 *
 * `recordPut` upserts the `files` row (path, size, mime, visibility, volume, optional
 * owner) so listing/search/admin can see it; `recordDelete` soft-trashes it (kept
 * for Trash & Recovery) rather than hard-deleting the row. Both append to
 * `audit_log`.
 *
 * Rows are keyed by `path_hash` (sha256 of the full path). The old prefix-based
 * unique key meant two paths sharing 255 characters were the same row, and this
 * upsert then overwrote the other file's metadata with no error at all.
 *
 * `recordDiscovered` is the entry point for masters that arrive WITHOUT an HTTP
 * write — a filesystem scan, an origin pull-through, a cluster peer pull. Those are
 * exactly the paths that used to leave a served file invisible to the whole platform.
 */

const path = require('path');
const { MIME } = require('./constants');
const { pathKey } = require('./util');

function createFileIndex({ db, jobs = null }) {
  const on = () => db && db.enabled;

  async function audit(action, targetPath, meta) {
    if (!on()) return;
    try {
      await db.query(
        'INSERT INTO audit_log (user_id, action, target_path, ip, user_agent, meta) VALUES (?, ?, ?, ?, ?, ?)',
        [meta.userId || null, action, targetPath || null, meta.ip || null,
         (meta.userAgent || '').slice(0, 255) || null, meta.extra ? JSON.stringify(meta.extra) : null]);
    } catch (e) { warn('audit', e); }
  }

  // The one upsert every write path funnels through.
  async function upsert(rel, { size, visibility, ownerUserId, width, height, checksum, volumeId, mtimeMs, scanId } = {}) {
    const ext = path.extname(rel).toLowerCase();
    const name = path.basename(rel);
    const mime = MIME[ext] || null;
    await db.query(
      `INSERT INTO files (path, path_hash, name, ext, mime, size_bytes, volume_id, mtime_ms, checksum_sha256,
                          width, height, visibility, status, owner_user_id, last_scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON DUPLICATE KEY UPDATE
         path=VALUES(path), name=VALUES(name), ext=VALUES(ext), mime=VALUES(mime), size_bytes=VALUES(size_bytes),
         volume_id=COALESCE(VALUES(volume_id), volume_id), mtime_ms=COALESCE(VALUES(mtime_ms), mtime_ms),
         checksum_sha256=COALESCE(VALUES(checksum_sha256), checksum_sha256),
         width=COALESCE(VALUES(width), width), height=COALESCE(VALUES(height), height),
         visibility=VALUES(visibility), status='active',
         owner_user_id=COALESCE(VALUES(owner_user_id), owner_user_id),
         last_scan_id=COALESCE(VALUES(last_scan_id), last_scan_id), trashed_at=NULL`,
      [rel, pathKey(rel), name, ext || null, mime, size || 0, volumeId || null,
       mtimeMs != null ? Math.round(mtimeMs) : null, checksum || null, width || null, height || null,
       visibility === 'private' ? 'private' : 'public', ownerUserId || null, scanId || null]);
  }

  // Queue a background metadata extraction for a file that has none. Silent no-op
  // when the queue is off, so extraction simply stays inline-only.
  function queueExtract(rel, { priority = 6 } = {}) {
    if (!jobs || !jobs.enabled) return;
    jobs.enqueue('extract', { path: rel }, { dedupeKey: `extract:${pathKey(rel)}`, priority }).catch(() => {});
  }

  const index = {
    // Upsert a master's metadata row after a successful PUT. `metadata` (optional) is
    // the normalized image/EXIF record → stored in file_metadata.
    async recordPut(rel, { size, visibility, ownerUserId, width, height, checksum, metadata, volumeId, mtimeMs } = {}, meta = {}) {
      if (on()) {
        try {
          await upsert(rel, { size, visibility, ownerUserId, width, height, checksum, volumeId, mtimeMs });
          if (metadata) await recordMetadata(rel, metadata);
          // Inline extraction is best-effort and silent on failure; when it produced
          // nothing, hand the file to the queue so it is retried rather than lost.
          else queueExtract(rel);
        } catch (e) { warn('recordPut', e); }
      }
      await audit('upload', rel, meta);
    },

    /**
     * Index a master that appeared without going through the HTTP write path —
     * found by a scan, pulled from an origin, or pulled from a cluster peer. Returns
     * 'created' | 'updated' | 'unchanged' | null (no DB / error) so a scan can report
     * what it actually did.
     */
    async recordDiscovered(rel, { size = 0, visibility = 'public', volumeId = null, mtimeMs = null, scanId = null, source = 'scan' } = {}) {
      if (!on()) return null;
      try {
        const existing = await db.one(
          'SELECT id, size_bytes, mtime_ms, volume_id, status FROM files WHERE path_hash = ? LIMIT 1', [pathKey(rel)]);
        const drifted = !existing || Number(existing.size_bytes) !== Number(size) ||
          Number(existing.mtime_ms || 0) !== Math.round(mtimeMs || 0) || existing.volume_id !== volumeId ||
          existing.status !== 'active';
        if (!drifted) {
          // Still mark it seen by this scan, or the finalize step would call it vanished.
          if (scanId) await db.query('UPDATE files SET last_scan_id = ? WHERE id = ?', [scanId, existing.id]);
          return 'unchanged';
        }
        await upsert(rel, { size, visibility, volumeId, mtimeMs, scanId });
        // Newly-seen bytes have no extracted metadata (and drifted bytes have stale
        // metadata), so hand them to the extractor.
        queueExtract(rel, { priority: source === 'scan' ? 7 : 5 });
        return existing ? 'updated' : 'created';
      } catch (e) { warn('recordDiscovered', e); return null; }
    },

    // Soft-trash a master's row after a successful DELETE (kept for recovery).
    async recordDelete(rel, meta = {}) {
      if (on()) {
        try {
          await db.query(
            `UPDATE files SET status='trashed', trashed_at=CURRENT_TIMESTAMP WHERE path_hash=?`, [pathKey(rel)]);
        } catch (e) { warn('recordDelete', e); }
      }
      await audit('delete', rel, meta);
    },

    // Update a file's path in the index (WebDAV MOVE/rename). Best-effort.
    async renamePath(src, dst) {
      if (!on()) return;
      try {
        const ext = path.extname(dst).toLowerCase();
        await db.query('UPDATE files SET path = ?, path_hash = ?, name = ?, ext = ?, mime = ? WHERE path_hash = ?',
          [dst, pathKey(dst), path.basename(dst), ext || null, MIME[ext] || null, pathKey(src)]);
      } catch (e) { warn('renamePath', e); }
    },

    // Store the output of a background extraction run (see the `extract` job type).
    async recordExtracted(rel, { width = null, height = null, metadata = null } = {}) {
      if (!on()) return false;
      try {
        if (width || height) {
          await db.query(
            'UPDATE files SET width = COALESCE(?, width), height = COALESCE(?, height) WHERE path_hash = ?',
            [width, height, pathKey(rel)]);
        }
        if (metadata) await recordMetadata(rel, metadata);
        return true;
      } catch (e) { warn('recordExtracted', e); return false; }
    },

    // Mark a row whose bytes are no longer on any volume. The row is KEPT — it may
    // carry tags, shares and comments, and the bytes may be on an unmounted volume.
    async markMissing(rel) {
      if (!on()) return;
      try { await db.query("UPDATE files SET status='missing' WHERE path_hash = ? AND status='active'", [pathKey(rel)]); }
      catch (e) { warn('markMissing', e); }
    },

    // Record where a master's bytes now live (placement changes, rebalance).
    async recordVolume(rel, volumeId) {
      if (!on() || !volumeId) return;
      try { await db.query('UPDATE files SET volume_id = ? WHERE path_hash = ?', [volumeId, pathKey(rel)]); }
      catch (e) { warn('recordVolume', e); }
    },

    queueExtract,
    audit,
  };
  return index;

  // Upsert the file_metadata row for a path (resolves file_id from the files row).
  async function recordMetadata(rel, md) {
    const row = await db.one('SELECT id FROM files WHERE path_hash = ?', [pathKey(rel)]);
    if (!row) return;
    await db.query(
      `INSERT INTO file_metadata
         (file_id, format, color_space, width, height, has_alpha, orientation, density,
          camera_make, camera_model, lens, taken_at, iso, exposure, f_number, focal_length, gps_lat, gps_lng, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         format=VALUES(format), color_space=VALUES(color_space), width=VALUES(width), height=VALUES(height),
         has_alpha=VALUES(has_alpha), orientation=VALUES(orientation), density=VALUES(density),
         camera_make=VALUES(camera_make), camera_model=VALUES(camera_model), lens=VALUES(lens),
         taken_at=VALUES(taken_at), iso=VALUES(iso), exposure=VALUES(exposure), f_number=VALUES(f_number),
         focal_length=VALUES(focal_length), gps_lat=VALUES(gps_lat), gps_lng=VALUES(gps_lng), raw=VALUES(raw)`,
      [row.id, md.format, md.color_space, md.width, md.height, md.has_alpha, md.orientation, md.density,
       md.camera_make, md.camera_model, md.lens, md.taken_at, md.iso, md.exposure, md.f_number, md.focal_length,
       md.gps_lat, md.gps_lng, md.raw]);
  }
}

function warn(where, e) { console.warn(`[media] fileindex.${where} failed: ${e.code || e.message}`); }

module.exports = { createFileIndex };
