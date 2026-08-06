'use strict';

/**
 * Registration of the built-in job types on the queue (src/jobs.js).
 *
 * Registration is CONDITIONAL on the capability each type needs. A type with no
 * handler in this process is never claimed here, so a node without ffmpeg leaves
 * transcode work queued for a node that has it, rather than burning its attempts.
 *
 *   scan     — reconcile the filesystem into the index (src/scanner.js)
 *   extract  — pull dimensions/EXIF (sharp) or duration/codecs (ffprobe) for one file
 *
 * Later phases register their own types here: transcode, package, enrich, scrub.
 */

const path = require('path');
const { RASTER, MIME } = require('./constants');
const { normalizeMetadata, normalizeProbe } = require('./metadata');

function registerJobTypes({ jobs, scanner, storage, index, sharp, ffmpeg, config }) {
  // Registration is deliberately unconditional on `jobs.enabled`: wiring happens in
  // createApp, but the database only comes up later in db.init(), so gating here
  // would leave every handler unregistered and the worker with nothing to claim.
  // Whether the queue actually runs is decided by jobs.start().
  if (!jobs) return jobs;

  // ── scan ────────────────────────────────────────────────────────────────────
  // Long-running by nature, so it gets a generous lease and heartbeats from inside
  // the walk. A crashed scan resumes from its recorded progress.
  jobs.register('scan', async (payload, ctx) => {
    const resume = (ctx.initialProgress && ctx.initialProgress.lastRel) ? ctx.initialProgress : (payload.resume || null);
    if (resume) ctx.log(`resuming after ${resume.volumeId}:${resume.lastRel}`);
    return scanner.scan({ volumeId: payload.volumeId || null, resume }, ctx);
  }, { leaseSeconds: 900 });

  // ── extract ─────────────────────────────────────────────────────────────────
  // The same metadata the upload path captures inline, but for files that never went
  // through it (scanned in, pulled from an origin or a peer) — and, unlike the inline
  // path, a failure is retried instead of silently lost.
  jobs.register('extract', async (payload) => {
    const rel = String(payload.path || '').replace(/^\/+/, '');
    if (!rel) throw new Error('extract: missing path');

    const hit = await storage.resolveRead(rel);
    if (!hit) {
      // Report it and stop — retrying four more times will not conjure the bytes.
      // Deliberately NOT marking the row `missing`: deciding a file is gone requires
      // a complete pass over every volume, which is the scanner's job, not a
      // single-file extraction's. (It also keeps a worker that cannot see a given
      // volume from condemning rows another node is serving perfectly well.)
      return { path: rel, missing: true };
    }
    // Keep the recorded volume honest — the bytes may have moved since indexing.
    await index.recordVolume(rel, hit.volumeId);

    const ext = path.extname(rel).toLowerCase();
    if (sharp && RASTER.has(ext)) {
      const m = await sharp(hit.abs).metadata();
      await index.recordExtracted(rel, { width: m.width || null, height: m.height || null, metadata: normalizeMetadata(m) });
      return { path: rel, kind: 'image', width: m.width || null, height: m.height || null };
    }
    if (ffmpeg && ffmpeg.enabled && /^(video|audio)\//.test(MIME[ext] || '')) {
      const pr = await ffmpeg.probe(hit.abs);
      if (!pr) return { path: rel, kind: 'media', probed: false };
      await index.recordExtracted(rel, { width: pr.width, height: pr.height, metadata: normalizeProbe(pr) });
      return { path: rel, kind: 'media', durationSec: pr.durationSec };
    }
    // Nothing this build can extract (a PDF without a reader, an unknown type…).
    return { path: rel, kind: 'other', extracted: false };
  }, { leaseSeconds: 300 });

  return jobs;
}

module.exports = { registerJobTypes };
