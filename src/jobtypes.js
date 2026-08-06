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
 *   sweep    — housekeeping: expired sessions, expired API tokens, stale attempt
 *              records, old finished jobs. Re-queues itself, so it is its own cron.
 *
 * Later phases register their own types here: transcode, package, enrich, scrub.
 */

const path = require('path');
const { RASTER, MIME } = require('./constants');
const { normalizeMetadata, normalizeProbe } = require('./metadata');
const { pathKey } = require('./util');
const { fromObject } = require('./handlers/filequery');

// Tags are normalized identically wherever they are written — trimmed, lowercased,
// deduped, length-capped — so a bulk tag and a single tag produce the same rows.
function normalizeTags(names) {
  return [...new Set((Array.isArray(names) ? names : [names])
    .filter((x) => x != null)
    .map((tName) => String(tName).trim().toLowerCase())
    .filter((tName) => tName && tName.length <= 64))];
}

// How often the housekeeping sweep runs. Short enough that an expired session is
// gone within the hour, long enough to be invisible.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function registerJobTypes({ jobs, scanner, storage, index, sharp, ffmpeg, config, db = null, masterops = null }) {
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

  // ── bulk ────────────────────────────────────────────────────────────────────
  // Apply one action to every asset matching a filter. Anything above a few hundred
  // assets has no business on the request path, and the queue already supplies the
  // progress, cancellation and retry this needs.
  if (db) {
    jobs.register('bulk', async (payload, ctx) => {
      const { clause, args } = fromObject(payload.filter || {});
      const rows = await db.query(`SELECT id, path FROM files ${clause} ORDER BY id`, args);
      const total = rows.length;
      const out = { action: payload.action, matched: total, applied: 0, skipped: 0 };
      const p = payload.params || {};

      for (let i = 0; i < rows.length; i++) {
        if (i % 50 === 0) {
          if (await ctx.cancelled()) return { ...out, cancelled: true };
          await ctx.heartbeat({ done: i, total });
        }
        const file = rows[i];
        try {
          switch (payload.action) {
            case 'tag': await addTags(file.id, p.tags); break;
            case 'untag': await removeTags(file.id, p.tags); break;
            case 'collection_add':
              await db.query('INSERT IGNORE INTO collection_files (collection_id, file_id, added_by) VALUES (?, ?, ?)',
                [Number(p.collection_id), file.id, payload.userId || null]);
              break;
            case 'collection_remove':
              await db.query('DELETE FROM collection_files WHERE collection_id = ? AND file_id = ?', [Number(p.collection_id), file.id]);
              break;
            case 'delete':
              // Trash-aware: the same path a single DELETE takes, so a bulk delete is
              // just as recoverable as an individual one.
              await masterops.deleteMaster(file.path, { meta: { userId: payload.userId || null } });
              break;
            case 'extract':
            case 'enrich':
              await jobs.enqueue(payload.action, { path: file.path }, {
                dedupeKey: `${payload.action}:${pathKey(file.path)}`, priority: 7,
              });
              break;
            default:
              out.skipped++;
              continue;
          }
          out.applied++;
        } catch (e) {
          out.skipped++;
          out.lastError = String(e.message || e).slice(0, 300);
        }
      }
      ctx.log(`bulk ${payload.action}: ${out.applied}/${total} applied`);
      return out;
    }, { leaseSeconds: 900 });

    // Tag helpers, shared by the tag/untag actions.
    var addTags = async (fileId, names) => {
      for (const raw of normalizeTags(names)) {
        await db.query('INSERT IGNORE INTO tags (name) VALUES (?)', [raw]);
        const tag = await db.one('SELECT id FROM tags WHERE name = ?', [raw]);
        if (tag) await db.query('INSERT IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)', [fileId, tag.id]);
      }
    };
    var removeTags = async (fileId, names) => {
      for (const raw of normalizeTags(names)) {
        await db.query(
          'DELETE ft FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = ? AND t.name = ?', [fileId, raw]);
      }
    };
  }

  // ── sweep ───────────────────────────────────────────────────────────────────
  // Housekeeping. Sessions were only ever removed on logout or on the next touch of
  // that exact token, so an abandoned session sat in the table until someone happened
  // to present it — `idx_sessions_expires` existed and nothing ever swept it.
  //
  // Self-perpetuating: the handler re-queues itself at the end, which is all the cron
  // this needs and keeps the schedule with the job rather than in the boot sequence.
  if (db) {
    jobs.register('sweep', async (payload, ctx) => {
      const out = {};
      const run = async (key, sql, args = []) => {
        const r = await db.query(sql, args).catch(() => null);
        out[key] = r && r.affectedRows ? Number(r.affectedRows) : 0;
      };
      await run('sessions', 'DELETE FROM sessions WHERE expires_at < NOW()');
      await run('apiTokens', 'DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < NOW()');
      // Attempt records outlive their usefulness the moment the window passes; keep a
      // generous multiple so a lockout is never cut short by the sweep itself.
      await run('loginAttempts', 'DELETE FROM login_attempts WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)',
        [Math.max(60, (config.loginWindowMinutes + config.loginLockoutMinutes) * 4)]);
      // Finished jobs are a log, not a queue — keep a week of them.
      await run('jobs', "DELETE FROM jobs WHERE state IN ('done','cancelled') AND finished_at < DATE_SUB(NOW(), INTERVAL 7 DAY)");

      if (payload.repeat !== false) {
        await jobs.enqueue('sweep', { repeat: true }, { dedupeKey: 'sweep:housekeeping', priority: 9, runAfterMs: SWEEP_INTERVAL_MS });
      }
      if (Object.values(out).some(Boolean)) ctx.log(`swept ${JSON.stringify(out)}`);
      return out;
    }, { leaseSeconds: 120 });
  }

  return jobs;
}

module.exports = { registerJobTypes };
