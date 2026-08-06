'use strict';

/**
 * Filesystem scanner / reconciler — the thing that makes the index COMPLETE.
 *
 * Until this existed, a master was only ever indexed by an HTTP write. Everything
 * else on disk was served correctly and was invisible to the console, to search and
 * to every feature built on the index:
 *
 *   - masters copied or rsync'd in, restored from backup, or mounted from an
 *     existing Strapi uploads volume (which deploy/docker-compose.yml recommends);
 *   - masters fetched by origin pull-through;
 *   - masters pulled from a cluster peer on miss.
 *
 * A scan walks every storage volume and reconciles it against `files`:
 *   unknown bytes      → indexed (and queued for metadata extraction)
 *   drifted size/mtime → row refreshed, metadata re-extracted
 *   row with no bytes  → marked `missing` (never deleted — the row may carry tags,
 *                        shares and comments, and the bytes may be on an unmounted
 *                        volume)
 *
 * Properties that matter at 50k+ files:
 *   - **Resumable.** Traversal is deterministic (sorted, depth-first), and progress
 *     records the last rel completed per volume. A restart skips forward to it
 *     instead of starting over.
 *   - **Never starves the request path.** Work is rate-limited to
 *     SCAN_RATE_FILES_PER_SEC and yields between batches.
 *   - **Correct across volumes.** Each volume is walked separately and rows are
 *     attributed to the volume the bytes were actually found on; the "vanished"
 *     sweep only runs after a COMPLETE pass, so a partial scan never mass-marks
 *     files missing.
 */

const fsp = require('fs/promises');
const path = require('path');
const { SIDECAR_EXT } = require('./constants');
const { isPrivateRel } = require('./visibility');

// Directory/file names the store owns and must never index.
const SKIP_DIRS = new Set(['.media-trash', '.cache', 'node_modules']);
const isInternal = (name) =>
  name.startsWith('.media-trash') ||
  name.endsWith(SIDECAR_EXT) ||
  (name.includes('.up.') && name.endsWith('.tmp')) ||
  name.endsWith('.tmp');

function createScanner({ config, storage, db, index, jobs }) {
  const ratePerSec = Math.max(1, parseInt(config.scanRateFilesPerSec, 10) || 200);

  /**
   * Walk one volume depth-first in sorted order, yielding file entries. Sorted order
   * is what makes `resumeAfter` meaningful: rels come out in a stable sequence, so
   * "everything up to X is done" is a valid statement about a partial pass.
   */
  async function* walk(volume, relDir = '') {
    const abs = relDir === '' ? volume.dir : path.join(volume.dir, relDir);
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of entries) {
      const name = d.name;
      if (isInternal(name)) continue;
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        yield* walk(volume, rel);
      } else if (d.isFile()) {
        yield rel;
      }
    }
  }

  return {
    /**
     * Reconcile every volume against the index.
     *
     * `ctx` is the job context (heartbeat / cancelled / log). Returns a summary that
     * becomes the job's `result`.
     */
    async scan({ volumeId = null, resume = null, finalize = true } = {}, ctx = null) {
      if (!db || !db.enabled) return { skipped: 'db_disabled' };
      const scanId = ctx && ctx.id ? Number(ctx.id) : Date.now() % 2147483647;
      const volumes = storage.volumes.filter((v) => !volumeId || v.id === volumeId);
      const stats = { scanId, volumes: volumes.map((v) => v.id), seen: 0, created: 0, updated: 0, unchanged: 0, missing: 0, errors: 0, resumedFrom: resume || null };

      let budget = ratePerSec;
      let windowStart = Date.now();

      for (const volume of volumes) {
        // Resume applies to the volume it was recorded for; later volumes start fresh.
        let skipUntil = resume && resume.volumeId === volume.id ? resume.lastRel : null;
        let lastRel = null;

        for await (const rel of walk(volume)) {
          if (skipUntil) {
            if (rel <= skipUntil) continue;
            skipUntil = null;
          }
          if (ctx && await ctx.cancelled()) {
            return { ...stats, cancelled: true, progress: { volumeId: volume.id, lastRel } };
          }

          // Rate limiting: a scan of a large library must never starve request-path
          // I/O. Spend a per-second budget, then wait out the rest of the second.
          if (--budget <= 0) {
            const elapsed = Date.now() - windowStart;
            if (elapsed < 1000) await sleep(1000 - elapsed);
            budget = ratePerSec;
            windowStart = Date.now();
            if (ctx) await ctx.heartbeat({ volumeId: volume.id, lastRel, seen: stats.seen });
          }

          try {
            const abs = path.join(volume.dir, rel);
            const st = await fsp.stat(abs).catch(() => null);
            if (!st || !st.isFile()) continue;
            stats.seen++;
            const outcome = await index.recordDiscovered(rel, {
              size: st.size,
              mtimeMs: st.mtimeMs,
              volumeId: volume.id,
              visibility: isPrivateRel(rel, config.privatePaths) ? 'private' : 'public',
              scanId,
              source: 'scan',
            });
            if (outcome === 'created') stats.created++;
            else if (outcome === 'updated') stats.updated++;
            else if (outcome === 'unchanged') stats.unchanged++;
          } catch (e) {
            stats.errors++;
          }
          lastRel = rel;
        }
        if (ctx) await ctx.heartbeat({ volumeId: volume.id, lastRel, seen: stats.seen, done: true });
      }

      // Vanished bytes. ONLY after a complete pass over every volume — a partial or
      // single-volume scan must never mass-mark the rest of the library missing.
      if (finalize && !volumeId) {
        try {
          const res = await db.query(
            `UPDATE files SET status='missing'
              WHERE status='active' AND (last_scan_id IS NULL OR last_scan_id <> ?)`, [scanId]);
          stats.missing = res && res.affectedRows ? Number(res.affectedRows) : 0;
        } catch (e) { stats.errors++; }
      }

      // Anything previously marked missing that this scan found again is already back
      // to 'active' via the upsert, so no second pass is needed.
      if (jobs && jobs.enabled && ctx) ctx.log(
        `scan complete — ${stats.seen} files, +${stats.created} new, ~${stats.updated} updated, ${stats.missing} missing`);
      return stats;
    },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { createScanner };
