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
const fsp = require('fs/promises');
const { RASTER, MIME } = require('./constants');
const { normalizeMetadata, normalizeProbe } = require('./metadata');
const { pathKey } = require('./util');
const { fromObject } = require('./handlers/filequery');

/**
 * Produce the image actually sent to the model: JPEG, long edge bounded to
 * `maxDim`, never upscaled. This is the single biggest cost lever in the whole AI
 * layer — the API bills an image by area, so sending a 4000px master costs several
 * times what a 1568px variant does for tagging quality that does not differ.
 * Also keeps requests clear of the 32 MB per-request cap.
 */
async function downscaleForVision(abs, maxDim, sharp) {
  if (!sharp) {
    return { data: await fsp.readFile(abs), mediaType: 'image/jpeg' };
  }
  const data = await sharp(abs)
    .rotate() // honor EXIF orientation, or the model describes a sideways photo
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { data, mediaType: 'image/jpeg' };
}

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

function registerJobTypes({ jobs, scanner, storage, index, sharp, ffmpeg, config, db = null, masterops = null, ai = null, aiStore = null }) {
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

  // ── enrich / enrich_batch ───────────────────────────────────────────────────
  // Registered ONLY when a provider is configured. With no key these types have no
  // handler in this process, so `POST /_api/jobs {type:"enrich"}` is refused up
  // front rather than queueing work nothing will ever run.
  if (ai && ai.enabled && aiStore && db) {
    jobs.register('enrich', async (payload, ctx) => {
      const rel = String(payload.path || '').replace(/^\/+/, '');
      if (!rel) throw new Error('enrich: missing path');
      const fileId = await aiStore.fileIdFor(rel);
      if (!fileId) return { path: rel, skipped: 'not_indexed' };

      const hit = await storage.resolveRead(rel);
      if (!hit) return { path: rel, missing: true };

      const ext = path.extname(rel).toLowerCase();
      const mime = MIME[ext] || '';
      try {
        let result;
        if (RASTER.has(ext) && ext !== '.svg') {
          // THE cost lever: send a bounded variant, never the master. The API bills
          // images by area, so a 4000px photo costs several times a 1568px one for
          // tagging quality that does not differ.
          const payloadImage = await downscaleForVision(hit.abs, config.aiMaxImageDim, sharp);
          result = await ai.enrichImage(payloadImage, { fileId, hint: path.basename(rel) });
        } else if (mime === 'application/pdf') {
          const data = await fsp.readFile(hit.abs);
          result = await ai.enrichDocument({ data, mediaType: 'application/pdf' }, { fileId, hint: path.basename(rel) });
        } else {
          return { path: rel, skipped: `unsupported type ${mime || ext}` };
        }
        await aiStore.save(fileId, result, { model: result.model, promptVersion: result.promptVersion, cost: result.cost });
        return { path: rel, tags: result.tags.length, cost: result.cost, model: result.model };
      } catch (e) {
        // A refusal, a budget stop, or bad output is a RESULT, not a transient
        // fault — record it and stop, so it shows up in review instead of burning
        // four more attempts against the same asset (and the same budget).
        if (['refusal', 'bad_output', 'empty_output', 'budget_exceeded'].includes(e.error)) {
          await aiStore.saveFailure(fileId, e.message, { model: ai.model, promptVersion: ai.promptVersion });
          ctx.log(`enrich ${rel}: ${e.error} — ${e.message}`);
          return { path: rel, failed: e.error, message: e.message };
        }
        throw e; // network/rate-limit — let the queue back off and retry
      }
    }, { leaseSeconds: 300 });

    // Bulk backfill through the Message Batches API — half price, and the right
    // shape for a library rather than a trickle. One job submits a batch and then
    // re-queues itself to poll, so a batch that takes an hour holds no worker slot.
    jobs.register('enrich_batch', async (payload, ctx) => {
      if (payload.batchId) return ingestBatch(payload.batchId, ctx);

      const { clause, args } = fromObject(payload.filter || {});
      const limit = Math.min(config.aiBatchSize, Number(payload.limit) || config.aiBatchSize);
      // Only assets that have no enrichment yet — a backfill must be resumable and
      // must not re-bill work already paid for.
      //
      // Deliberately a subquery rather than a LEFT JOIN: the shared filter builder
      // emits unqualified column names (`status = ?`, `id IN (...)`), which are
      // ambiguous the moment a second table joins in.
      const rows = await db.query(
        `SELECT id, path, ext FROM files
          ${clause ? clause + ' AND' : 'WHERE'} id NOT IN (SELECT file_id FROM file_ai)
          ORDER BY id LIMIT ${limit}`, args);
      const candidates = rows.filter((r) => RASTER.has(String(r.ext || '').toLowerCase()));
      if (!candidates.length) return { submitted: 0, note: 'nothing left to enrich' };

      const requests = [];
      const mapping = [];
      for (const row of candidates) {
        const hit = await storage.resolveRead(row.path);
        if (!hit) continue;
        const customId = `f${row.id}`;
        const img = await downscaleForVision(hit.abs, config.aiMaxImageDim, sharp);
        requests.push(ai.imageBatchRequest(customId, img, path.basename(row.path)));
        mapping.push([customId, row.id, row.path]);
        if (requests.length % 20 === 0) await ctx.heartbeat({ prepared: requests.length, of: candidates.length });
      }
      if (!requests.length) return { submitted: 0, note: 'no readable bytes for the matched assets' };

      const batch = await ai.submitBatch(requests);
      await db.query(
        'INSERT INTO ai_batches (batch_id, state, model, requested, created_by) VALUES (?, ?, ?, ?, ?)',
        [batch.id, batch.state, ai.model, requests.length, payload.userId || null]);
      for (const [customId, fileId, p] of mapping) {
        await db.query('INSERT IGNORE INTO ai_batch_items (batch_id, custom_id, file_id, path) VALUES (?, ?, ?, ?)',
          [batch.id, customId, fileId, p]);
      }
      // Poll on the queue, not in this handler — a batch can take an hour.
      await jobs.enqueue('enrich_batch', { batchId: batch.id }, {
        dedupeKey: `enrich_batch:${batch.id}`, priority: 8, runAfterMs: config.aiBatchPollMs,
      });
      ctx.log(`submitted batch ${batch.id} with ${requests.length} assets`);
      return { submitted: requests.length, batchId: batch.id };
    }, { leaseSeconds: 900 });

    async function ingestBatch(batchId, ctx) {
      const status = await ai.batchStatus(batchId);
      await db.query('UPDATE ai_batches SET state = ? WHERE batch_id = ?', [status.state, batchId]).catch(() => {});
      if (status.state !== 'ended') {
        // Not ready — come back later rather than holding a worker slot open.
        await jobs.enqueue('enrich_batch', { batchId }, {
          dedupeKey: `enrich_batch:${batchId}`, priority: 8, runAfterMs: config.aiBatchPollMs * 2,
        });
        return { batchId, state: status.state, pending: true };
      }

      let ok = 0, failed = 0;
      for await (const item of ai.batchResults(batchId)) {
        // Results arrive in ANY order — the custom_id → file_id mapping is the only
        // thing that ties a result back to an asset.
        const map = await db.one('SELECT file_id, path FROM ai_batch_items WHERE batch_id = ? AND custom_id = ?',
          [batchId, item.custom_id]);
        if (!map) continue;
        if (item.result.type !== 'succeeded') {
          await aiStore.saveFailure(map.file_id, `batch ${item.result.type}`, { model: ai.model, promptVersion: ai.promptVersion });
          failed++;
          continue;
        }
        try {
          const parsed = ai.parseResult(item.result.message);
          const cost = await ai.record('image_batch', item.result.message.usage, { fileId: map.file_id, batchId, batch: true });
          await aiStore.save(map.file_id, { ...parsed, usage: item.result.message.usage }, {
            model: ai.model, promptVersion: ai.promptVersion, cost,
          });
          ok++;
        } catch (e) {
          await aiStore.saveFailure(map.file_id, e.message, { model: ai.model, promptVersion: ai.promptVersion });
          failed++;
        }
        if ((ok + failed) % 25 === 0) await ctx.heartbeat({ ingested: ok + failed });
      }
      await db.query(
        'UPDATE ai_batches SET state = ?, succeeded = ?, errored = ?, finished_at = NOW() WHERE batch_id = ?',
        ['ingested', ok, failed, batchId]).catch(() => {});
      ctx.log(`batch ${batchId} ingested — ${ok} ok, ${failed} failed`);
      return { batchId, ingested: ok, failed };
    }
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
