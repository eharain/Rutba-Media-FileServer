'use strict';

/**
 * Multi-volume master storage. Masters can live across several directories/mounts;
 * a relative path (`rel`, the URL key) is volume-independent, and each volume simply
 * holds its own copy of some rels. `default` (config.masterDir) is always the first
 * volume, so a single-volume deployment behaves exactly as before.
 *
 * Reads search every volume (default first) for an existing file. New writes are
 * placed by policy: an existing file is replaced in place; otherwise a target volume
 * is chosen by `route` prefix rules, `fill` (first with room), or `free` (most free
 * space, the default). Read-only volumes are never chosen for writes.
 *
 * Path traversal is blocked per-volume with the same `resolveSafe` used elsewhere.
 */

const fsp = require('fs/promises');
const path = require('path');
const { resolveSafe, relOf } = require('./util');
const { SIDECAR_EXT } = require('./constants');

function createStorage(config) {
  const volumes = config.storageVolumes; // [{id, dir, readOnly}], default first
  const byId = new Map(volumes.map((v) => [v.id, v]));
  const placement = config.storagePlacement;
  const routes = config.storageRoutes;
  const multi = volumes.length > 1;

  // Safe absolute path for `rel` within a specific volume, or null if unsafe.
  function absIn(volume, rel) {
    const abs = resolveSafe(volume.dir, rel);
    if (!abs || abs === volume.dir) return null;
    return abs;
  }

  // Normalize a request path to a clean, volume-independent rel (or null if it
  // escapes). Uses the default volume purely as the namespace anchor.
  function relOf_(reqRel) {
    const abs = resolveSafe(config.masterDir, reqRel);
    if (!abs || abs === config.masterDir) return null;
    return relOf(config.masterDir, abs);
  }

  const statFile = (p) => fsp.stat(p).catch(() => null);

  const storage = {
    volumes,
    multi,
    relOf: relOf_,
    absIn,

    // The default volume's absolute path for a rel (back-compat helper).
    defaultAbs(rel) { return absIn(volumes[0], rel); },

    // Find an existing master across volumes (default first). Returns
    // { abs, stat, volumeId } or null.
    async resolveRead(rel) {
      for (const v of volumes) {
        const abs = absIn(v, rel);
        if (!abs) continue;
        const st = await statFile(abs);
        if (st && st.isFile()) return { abs, stat: st, volumeId: v.id };
      }
      return null;
    },

    // Choose where to WRITE `rel`. If it already exists on a volume, that volume is
    // reused (in-place replace). Otherwise placement policy picks a writable volume.
    // Returns { abs, volumeId } or null if the path is unsafe / no writable volume.
    async placeWrite(rel, { sizeHint = 0 } = {}) {
      const existing = await storage.resolveRead(rel);
      if (existing) {
        const v = byId.get(existing.volumeId);
        if (v && !v.readOnly) return { abs: existing.abs, volumeId: v.id };
        // Existing copy is on a read-only volume — fall through to place a writable one.
      }
      const v = await pickWriteVolume(rel, sizeHint, existing ? existing.volumeId : null);
      if (!v) return null;
      const abs = absIn(v, rel);
      return abs ? { abs, volumeId: v.id } : null;
    },

    // Classify a rel: directory, file, or missing. Searches all volumes; the empty
    // rel (root) is always a directory.
    async statPath(rel) {
      if (rel === '') return { type: 'dir', abs: null };
      for (const v of volumes) {
        const abs = absIn(v, rel);
        if (!abs) continue;
        const st = await statFile(abs);
        if (st) return { type: st.isDirectory() ? 'dir' : 'file', abs, stat: st, volumeId: v.id };
      }
      return null;
    },

    // Absolute directory path for a rel within a volume (root → the volume dir).
    dirAbsIn(volume, relDir) { return relDir === '' ? volume.dir : absIn(volume, relDir); },

    // Union directory listing across all volumes (default first wins on name clash).
    // Hides internal artifacts (.vis sidecars, upload temp files, the trash dir).
    async listDir(relDir) {
      const entries = new Map();
      for (const v of volumes) {
        const dirAbs = storage.dirAbsIn(v, relDir);
        if (!dirAbs) continue;
        let dirents;
        try { dirents = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch { continue; }
        for (const d of dirents) {
          const name = d.name;
          if (entries.has(name)) continue;
          if (name.endsWith(SIDECAR_EXT)) continue;
          if (name.includes('.up.') && name.endsWith('.tmp')) continue;
          if (name.startsWith('.media-trash')) continue;
          const abs = path.join(dirAbs, name);
          let st = null; try { st = await fsp.stat(abs); } catch { continue; }
          entries.set(name, { name, rel: relDir === '' ? name : relDir + '/' + name, isDir: st.isDirectory(), abs, stat: st, volumeId: v.id });
        }
      }
      return [...entries.values()];
    },

    // Create a directory (default volume). Returns the abs path, or null if unsafe.
    async mkcol(relDir) {
      const abs = absIn(volumes[0], relDir);
      if (!abs) return null;
      await fsp.mkdir(abs, { recursive: true });
      return abs;
    },

    // Remove an (ideally empty) directory subtree from every volume.
    async removeDir(relDir) {
      for (const v of volumes) {
        const abs = absIn(v, relDir);
        if (abs) await fsp.rm(abs, { recursive: true, force: true }).catch(() => {});
      }
    },

    // Per-volume disk usage (free/total bytes), for admin/monitoring.
    async usage() {
      const out = [];
      for (const v of volumes) {
        let free = null, total = null;
        try { const s = await fsp.statfs(v.dir); free = s.bavail * s.bsize; total = s.blocks * s.bsize; }
        catch { /* dir may not exist yet */ }
        out.push({ id: v.id, dir: v.dir, readOnly: v.readOnly, freeBytes: free, totalBytes: total });
      }
      return out;
    },
  };

  // Free bytes on a volume (0 if it can't be measured / doesn't exist).
  async function freeBytes(dir) {
    try { const s = await fsp.statfs(dir); return s.bavail * s.bsize; } catch { return 0; }
  }

  // Choose a writable volume for a new rel per the configured policy.
  async function pickWriteVolume(rel, sizeHint, avoidReadOnlyId) {
    const writable = volumes.filter((v) => !v.readOnly);
    if (!writable.length) return null;
    if (writable.length === 1) return writable[0];

    if (placement === 'route') {
      const m = routes.find((r) => rel === r.prefix || rel.startsWith(r.prefix.endsWith('/') ? r.prefix : r.prefix + '/') || rel.startsWith(r.prefix));
      if (m) { const v = byId.get(m.volumeId); if (v && !v.readOnly) return v; }
      // no matching route → fall back to free-space
    }
    if (placement === 'fill') {
      // First writable volume with room for the file (+64 MiB headroom); else the
      // one with the most free space.
      const need = (sizeHint || 0) + 64 * 1024 * 1024;
      for (const v of writable) { if ((await freeBytes(v.dir)) >= need) return v; }
    }
    // `free` (and fallbacks): most free space.
    let best = null, bestFree = -1;
    for (const v of writable) {
      const f = await freeBytes(v.dir);
      if (f > bestFree) { bestFree = f; best = v; }
    }
    return best || writable[0];
  }

  return storage;
}

module.exports = { createStorage };
