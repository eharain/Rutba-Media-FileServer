'use strict';

/**
 * Best-effort metadata index + audit trail for master writes.
 *
 * The filesystem stays the source of truth: every method here is wrapped so a DB
 * error is logged and swallowed, never failing a PUT/DELETE. When `db.enabled` is
 * false the whole object is inert no-ops, so the write path is unchanged without a
 * database.
 *
 * `recordPut` upserts the `files` row (path, size, mime, visibility, optional
 * owner) so listing/search/admin can see it; `recordDelete` soft-trashes it (kept
 * for Trash & Recovery) rather than hard-deleting the row. Both append to
 * `audit_log`.
 */

const path = require('path');
const { MIME } = require('./constants');

function createFileIndex({ db }) {
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

  return {
    // Upsert a master's metadata row after a successful PUT. `metadata` (optional) is
    // the normalized image/EXIF record → stored in file_metadata.
    async recordPut(rel, { size, visibility, ownerUserId, width, height, checksum, metadata } = {}, meta = {}) {
      if (on()) {
        try {
          const ext = path.extname(rel).toLowerCase();
          const name = path.basename(rel);
          const mime = MIME[ext] || null;
          await db.query(
            `INSERT INTO files (path, name, ext, mime, size_bytes, checksum_sha256, width, height, visibility, status, owner_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
             ON DUPLICATE KEY UPDATE
               name=VALUES(name), ext=VALUES(ext), mime=VALUES(mime), size_bytes=VALUES(size_bytes),
               checksum_sha256=COALESCE(VALUES(checksum_sha256), checksum_sha256),
               width=COALESCE(VALUES(width), width), height=COALESCE(VALUES(height), height),
               visibility=VALUES(visibility), status='active',
               owner_user_id=COALESCE(VALUES(owner_user_id), owner_user_id), trashed_at=NULL`,
            [rel, name, ext || null, mime, size || 0, checksum || null, width || null, height || null,
             visibility === 'private' ? 'private' : 'public', ownerUserId || null]);
          if (metadata) await recordMetadata(rel, metadata);
        } catch (e) { warn('recordPut', e); }
      }
      await audit('upload', rel, meta);
    },

    // Soft-trash a master's row after a successful DELETE (kept for recovery).
    async recordDelete(rel, meta = {}) {
      if (on()) {
        try {
          await db.query(
            `UPDATE files SET status='trashed', trashed_at=CURRENT_TIMESTAMP WHERE path=?`, [rel]);
        } catch (e) { warn('recordDelete', e); }
      }
      await audit('delete', rel, meta);
    },

    // Update a file's path in the index (WebDAV MOVE/rename). Best-effort.
    async renamePath(src, dst) {
      if (!on()) return;
      try {
        const ext = path.extname(dst).toLowerCase();
        await db.query('UPDATE files SET path = ?, name = ?, ext = ?, mime = ? WHERE path = ?',
          [dst, path.basename(dst), ext || null, MIME[ext] || null, src]);
      } catch (e) { warn('renamePath', e); }
    },

    audit,
  };

  // Upsert the file_metadata row for a path (resolves file_id from the files row).
  async function recordMetadata(rel, md) {
    const row = await db.one('SELECT id FROM files WHERE path = ?', [rel]);
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
