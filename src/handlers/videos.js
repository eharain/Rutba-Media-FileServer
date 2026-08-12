'use strict';

/**
 * Video control surface under `/_api/videos` — the endpoints the ERP's video gallery
 * proxies.
 *
 * WHY a namespace of its own when `GET /_api/files?type=video/` already exists: the
 * ERP is a MACHINE caller. It holds exactly one credential for this server — the
 * UPLOAD_TOKEN it already writes masters with — and has no user account here.
 * `/_api/files` demands a platform session, so wiring the gallery to it would mean
 * minting a service user and rotating its password alongside everything else. These
 * routes accept the upload token directly (`requireServiceOrAuth`), which is the same
 * grant `readauth.js` already honours for reads and therefore no new trust.
 *
 * It also answers the three questions a gallery actually asks and the generic file
 * search does not: which folders hold video, how long each clip runs, and whether the
 * drive has been re-scanned since someone dropped new files onto it.
 *
 * Routes:
 *   GET  /_api/videos          service|user   ?folder=&recursive=&q=&tag=&since=&until=
 *                                             &limit=&offset=&sort=
 *   GET  /_api/videos/folders  service|user   every folder holding video, with totals
 *   GET  /_api/videos/tags     service|user   tags that are actually ON video, w/ counts
 *   POST /_api/videos/scan     service|admin  queue the existing `scan` job → 202
 *   GET  /_api/videos/scan     service|user   the live/last scan job + library totals
 *
 * Scanning is NOT re-implemented here. `src/scanner.js` already walks every volume —
 * resumably, rate-limited so it never starves the request path — as the `scan` job
 * type. This module only queues and reports on it; a second scanner would drift from
 * the first and fight it for the same disk.
 */

const crypto = require('crypto');
const { HDR_UPLOAD_TOKEN } = require('../constants');
const { buildFileFilter } = require('./filequery');

// Sort orders a caller may ask for, as SQL fragments chosen from this table and
// never composed from input. The `id` tiebreak is not decoration: DATETIME has
// second granularity, so a bulk import gives dozens of rows the same timestamp and
// MySQL is free to order them differently per query — which makes offset pages
// silently repeat and skip clips. `newest` is by created_at rather than updated_at
// because a gallery means "recently added", and a re-upload should not jump an old
// clip back to the top.
const SORTS = {
  newest: 'created_at DESC, id DESC',
  oldest: 'created_at ASC, id ASC',
  name: 'name ASC, id ASC',
  size: 'size_bytes DESC, id DESC',
};

function createVideoRoutes(ctx) {
  const {
    config, db, jobs, auth,
    guarded, httpErr, clampInt, sendJson, readJson, audit, isAdmin,
  } = ctx;

  // ── auth ────────────────────────────────────────────────────────────────────
  // The upload token, from `Authorization: Bearer` or the `X-Upload-Token` fallback.
  // Both are accepted for the reason constants.js gives: some front-ends (LiteSpeed /
  // Passenger, i.e. the hosting this runs on) strip `Authorization` before the app
  // ever sees it, which would 401 the integration for reasons it cannot diagnose.
  //
  // The comparison is timing-safe. `===` on a secret leaks its prefix to anyone
  // willing to measure, and this token is also the write credential for the whole
  // store — the one place where that is worth the two extra lines.
  function presentedToken(req) {
    const h = req.headers['authorization'];
    if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
    const alt = req.headers[HDR_UPLOAD_TOKEN];
    return alt ? String(alt).trim() : null;
  }

  function hasUploadToken(req) {
    if (!config.uploadToken) return false;
    const given = presentedToken(req);
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(config.uploadToken);
    // timingSafeEqual throws on a length mismatch, and the length is not the secret.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Reads: the upload-token holder OR any authenticated user.
   *
   * Returns the user context when there is one and null for a token-only caller, so
   * handlers can audit an action against a user when they have one without having to
   * care which credential arrived.
   */
  async function requireServiceOrAuth(req) {
    if (hasUploadToken(req)) return null;
    const user = await auth.authenticate(req).catch(() => null);
    if (user) return user;
    throw httpErr(401, 'unauthorized', 'Authentication required (upload token or user session)');
  }

  // Writes/execution: the upload token OR an admin. A signed-in viewer must not be
  // able to start a full-library disk walk just because it can read the listing.
  async function requireServiceOrAdmin(req) {
    if (hasUploadToken(req)) return null;
    const user = await auth.authenticate(req).catch(() => null);
    if (user && isAdmin(user)) return user;
    if (user) throw httpErr(403, 'forbidden', 'Admin role (or the upload token) required');
    throw httpErr(401, 'unauthorized', 'Authentication required (upload token or admin session)');
  }

  function requireJobs() {
    if (!jobs || !jobs.enabled) throw httpErr(503, 'jobs_disabled', 'The job queue is not available');
    return jobs;
  }

  // ── GET /_api/videos ────────────────────────────────────────────────────────
  /**
   * List indexed videos.
   *
   * `folder` scopes the listing: with `recursive=0` (the default) only clips whose
   * IMMEDIATE directory is that folder, with `recursive=1` everything beneath it.
   * An absent or empty `folder` means EVERY video at any depth — the same meaning
   * `GET /_api/files` gives it, and the right landing page for a gallery — so
   * `recursive` only carries meaning alongside a folder.
   *
   * Only `status='active'` masters of `mime LIKE 'video/%'` are ever returned, and
   * neither is overridable from the query string: this is a video endpoint, and a
   * caller that wants trashed rows or other MIME types wants `/_api/files`.
   */
  async function listVideos(req, res, { url }) {
    await requireServiceOrAuth(req);
    const params = url.searchParams;
    const recursive = /^(1|true|yes|on)$/i.test(params.get('recursive') || '');
    const { clause, args } = videoFilter({
      q: params.get('q'),
      folder: params.get('folder'),
      recursive,
      tag: params.get('tag'),
      since: params.get('since'),
      until: params.get('until'),
    });

    const limit = clampInt(params.get('limit'), 50, 1, 500);
    const offset = clampInt(params.get('offset'), 0, 0, 1e9);
    const order = SORTS[String(params.get('sort') || 'newest').toLowerCase()] || SORTS.newest;

    const totalRow = await db.one(`SELECT COUNT(*) AS n FROM files ${clause}`, args);
    // Filtered against `files` alone, exactly as filequery.js documents its clause
    // ("for splicing after FROM files"). Joining file_metadata in here would make
    // `width`/`height` ambiguous and quietly change what the shared filter means.
    const rows = await db.query(
      `SELECT id, path, name, ext, mime, size_bytes, width, height, visibility, status, created_at, updated_at
         FROM files ${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, args);

    const ids = rows.map((r) => r.id);
    const [meta, tags] = await Promise.all([metadataFor(ids), tagsFor(ids)]);
    return sendJson(res, 200, {
      videos: rows.map((r) => shapeVideo(r, meta.get(Number(r.id)), tags.get(Number(r.id)))),
      total: totalRow ? Number(totalRow.n) : rows.length,
      limit,
      offset,
    });
  }

  // Tags for one page of results, keyed by file id. Same shape and same reason as
  // metadataFor: a JOIN would multiply the rows by their tag count and quietly
  // break `total` and the page size.
  async function tagsFor(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const holes = ids.map(() => '?').join(',');
    const rows = await db.query(
      `SELECT ft.file_id, t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
        WHERE ft.file_id IN (${holes}) ORDER BY t.name`,
      ids.map(Number));
    for (const r of rows) {
      const key = Number(r.file_id);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(r.name);
    }
    return out;
  }

  // Extracted metadata for one page of results, keyed by file id. A second query
  // rather than a JOIN, bounded by the page size (≤500) so the IN list stays sane.
  async function metadataFor(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const holes = ids.map(() => '?').join(',');
    const rows = await db.query(
      `SELECT file_id, width, height, raw FROM file_metadata WHERE file_id IN (${holes})`,
      ids.map(Number));
    for (const r of rows) out.set(Number(r.file_id), r);
    return out;
  }

  // ── GET /_api/videos/folders ────────────────────────────────────────────────
  /**
   * Every directory that holds video, ancestors included, with counts and bytes
   * aggregated over everything beneath.
   *
   * Aggregated in JS from `path,size_bytes` rather than in SQL. Rolling a count up
   * through every ancestor prefix needs either a recursive CTE or SUBSTRING_INDEX
   * arithmetic against a numbers table; at ~50k rows the loop below costs a few
   * hundred thousand map operations (milliseconds) and stays something a reader can
   * verify at a glance. Files at the volume root belong to no folder and so appear
   * in no row — their `folder` in the listing above is `''`.
   */
  async function listFolders(req, res) {
    await requireServiceOrAuth(req);
    const { clause, args } = videoFilter({});
    const rows = await db.query(`SELECT path, size_bytes FROM files ${clause}`, args);
    const folders = foldersFromPaths(rows);
    return sendJson(res, 200, { folders, total: folders.length });
  }

  // ── GET /_api/videos/tags ───────────────────────────────────────────────────
  /**
   * Tags that are actually on a video, with how many videos carry each.
   *
   * Deliberately not `GET /_api/tags`: that counts every file, so a gallery filter
   * built on it offers tags that match no clip and shows counts the listing then
   * contradicts. `?folder=` narrows it to the folder in view, which is what makes
   * the filter a facet of what you are looking at rather than of the whole store.
   */
  async function listTags(req, res, { url }) {
    await requireServiceOrAuth(req);
    const params = url.searchParams;
    const recursive = /^(1|true|yes|on)$/i.test(params.get('recursive') || '');
    const { clause, args } = videoFilter({ folder: params.get('folder'), recursive });
    const rows = await db.query(
      `SELECT t.name, COUNT(*) AS n
         FROM file_tags ft
         JOIN tags t ON t.id = ft.tag_id
        WHERE ft.file_id IN (SELECT id FROM files ${clause})
        GROUP BY t.name
        ORDER BY n DESC, t.name ASC`, args);
    return sendJson(res, 200, {
      tags: rows.map((r) => ({ name: r.name, count: Number(r.n) || 0 })),
      total: rows.length,
    });
  }

  // ── POST /_api/videos/scan ──────────────────────────────────────────────────
  /**
   * Trigger a drive scan by queuing the EXISTING `scan` job.
   *
   * The dedupe key is `scan:all`, deliberately the same one server.js uses for the
   * boot scan: a scan already queued or running is handed back instead of a second
   * full walk of the disk being started behind it.
   *
   * `folder` is accepted and recorded on the job payload, but does NOT narrow the
   * walk — src/scanner.js reconciles whole volumes, because deciding a row is
   * `missing` requires a complete pass. Saying so here is better than an endpoint
   * that silently ignores an argument it advertises.
   */
  async function triggerScan(req, res) {
    const user = await requireServiceOrAdmin(req);
    const body = await readJson(req);
    const folder = String(body.folder || '').replace(/^\/+|\/+$/g, '') || null;

    const id = await requireJobs().enqueue('scan', folder ? { folder } : {},
      { dedupeKey: 'scan:all', priority: 8, createdBy: user ? user.user.id : null });
    if (!id) throw httpErr(500, 'enqueue_failed', 'Could not queue the scan');

    const job = await jobs.get(id);
    await audit(req, 'video_scan', folder, user ? user.user.id : null);
    return sendJson(res, 202, {
      queued: true,
      job: job ? { id: job.id, type: job.type, state: job.state } : { id, type: 'scan', state: 'queued' },
    });
  }

  // ── GET /_api/videos/scan ───────────────────────────────────────────────────
  /**
   * What the last scan did, and what the library holds now.
   *
   * The job row is read straight from the table rather than through `jobs`, so this
   * still reports on a deployment where a separate process owns the worker
   * (`JOBS_ENABLED=0`) — "is my drive indexed?" is a question the queue being off
   * does not stop us answering.
   */
  async function scanStatus(req, res) {
    await requireServiceOrAuth(req);
    // Live work first (a running or queued scan is the answer to "is it scanning?"),
    // otherwise the most recent finished one.
    const job = await db.one(
      `SELECT id, type, state, created_at, started_at, finished_at, error,
              (state IN ('running','queued')) AS live
         FROM jobs WHERE type = ? ORDER BY live DESC, id DESC LIMIT 1`, ['scan']);
    const done = await db.one(
      `SELECT MAX(finished_at) AS at FROM jobs WHERE type = ? AND state = 'done'`, ['scan']);
    const totals = await db.one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes
         FROM files WHERE status = 'active' AND mime LIKE 'video/%'`);

    return sendJson(res, 200, {
      job: job ? {
        id: Number(job.id), type: job.type, state: job.state,
        created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
        ...(job.error ? { error: job.error } : {}),
      } : null,
      videos: totals ? Number(totals.n) : 0,
      bytes: totals ? Number(totals.bytes) : 0,
      lastCompletedAt: done ? done.at || null : null,
    });
  }

  return [
    ['GET', /^\/_api\/videos$/, guarded(listVideos)],
    ['GET', /^\/_api\/videos\/folders$/, guarded(listFolders)],
    ['GET', /^\/_api\/videos\/tags$/, guarded(listTags)],
    ['POST', /^\/_api\/videos\/scan$/, guarded(triggerScan)],
    ['GET', /^\/_api\/videos\/scan$/, guarded(scanStatus)],
  ];
}

// ── pure helpers (exported so they can be tested without a database) ───────────

/**
 * The shared WHERE builder, driven with the only keys this surface exposes.
 *
 * Everything else buildFileFilter understands (tag, collection, owner, volume,
 * custom fields…) returns null and is therefore absent — one filter implementation,
 * a deliberately narrow door into it.
 */
function videoFilter({ q = null, folder = null, recursive = false, tag = null, since = null, until = null }) {
  return buildFileFilter((k) => {
    switch (k) {
      case 'status': return 'active';
      case 'type': return 'video/';                          // → mime LIKE 'video/%'
      case 'q': return q;
      case 'tag': return tag;
      case 'created_after': return since;
      case 'created_before': return until;
      case 'folder': return folder;
      case 'folder_mode': return recursive ? 'under' : 'direct';
      default: return null;
    }
  });
}

// The directory portion of an indexed path; '' for a file at the volume root.
function dirOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i === -1 ? '' : s.slice(0, i);
}

/**
 * The publicly served URL of a master.
 *
 * Path-relative on purpose: this server has no configured public base URL (it can be
 * reached on several — a LAN address, images.rutba.pk, a cluster peer) and inventing
 * one would hand callers an origin that is wrong for whoever asked. The caller
 * composes the origin it reached us on. `encodeURI` — not per-segment encoding — is
 * the convention already used to turn a rel into a URL in cluster.js/fetchstore.js.
 */
function videoUrl(rel) {
  return '/' + encodeURI(String(rel || ''));
}

/**
 * Seconds of runtime, or null.
 *
 * There is no `duration` column: `file_metadata` promotes the fields photographs
 * need, and ffprobe's numbers land in the `raw` JSON blob — as `durationSec`, written
 * by metadata.js `normalizeProbe` from `ffmpeg.probe()`. The other shapes are read
 * too (a raw ffprobe document keeps it at `format.duration`, and a stream-only file
 * only at `streams[].duration`) because rows may predate the current normalizer or
 * have been written by the migrate scripts, and a gallery showing "—" against half
 * its clips is a worse outcome than three extra property reads.
 */
function durationFromRaw(raw) {
  const j = parseJson(raw);
  if (!j) return null;
  const stream = Array.isArray(j.streams) ? j.streams.find((s) => s && s.duration != null) : null;
  const candidates = [j.durationSec, j.duration, j.format && j.format.duration, stream && stream.duration];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

// One indexed row + its optional file_metadata row → the object the gallery consumes.
// Dimensions prefer the `files` columns (kept current by every write path) and fall
// back to the extracted ones, so a row indexed by a scan before extraction ran still
// reports what it can.
function shapeVideo(row, meta, tags) {
  const width = firstNumber(row.width, meta && meta.width);
  const height = firstNumber(row.height, meta && meta.height);
  return {
    tags: tags || [],
    id: Number(row.id),
    path: row.path,
    name: row.name,
    ext: row.ext,
    mime: row.mime,
    size_bytes: Number(row.size_bytes) || 0,
    width,
    height,
    duration: meta ? durationFromRaw(meta.raw) : null,
    folder: dirOf(row.path),
    url: videoUrl(row.path),
    visibility: row.visibility,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * `[{path, size_bytes}]` → one row per directory that holds video, ancestors
 * included, each counting everything beneath it. Sorted by path so the caller can
 * render a tree without sorting it again.
 */
function foldersFromPaths(rows) {
  const acc = new Map();
  for (const r of rows || []) {
    const parts = String(r.path || '').split('/');
    parts.pop();                                   // drop the filename
    const size = Number(r.size_bytes) || 0;
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const cur = acc.get(dir) || { videos: 0, bytes: 0 };
      cur.videos++;
      cur.bytes += size;
      acc.set(dir, cur);
    }
  }
  return [...acc.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path, v]) => ({
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      parent: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null,
      videos: v.videos,
      bytes: v.bytes,
    }));
}

// mysql2 hands JSON columns back parsed on some drivers and as text on others — the
// same two-shape problem jobs.js normalizes.
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function firstNumber(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

module.exports = { createVideoRoutes, videoFilter, foldersFromPaths, durationFromRaw, dirOf, videoUrl };
