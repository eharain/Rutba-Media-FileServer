'use strict';

/**
 * Asset-management routes — the layer that turns a file listing into a library.
 *
 * Split out of api.js purely for size: these are the same `/_api/*` control plane,
 * mounted by the same dispatcher, using the same guards. `createAssetRoutes(ctx)`
 * returns `[method, regex, handler]` triples; `ctx` carries the shared services and
 * the small helpers (auth guards, audit, error shapes) so nothing is re-implemented.
 *
 * What lives here:
 *   versions      — list / download / restore / purge retained copies of a master
 *   folders       — real folder rows, rename/move of a subtree, folder shares
 *   collections   — cross-cutting sets, independent of path
 *   metadata      — per-installation custom field definitions and their values
 *   renditions    — named resize presets ("web-hero") over the existing engine
 *   searches      — saved filter sets
 *   bulk          — apply an action to everything matching a filter, as a job
 *   comments      — threaded per-asset discussion, with in-app notifications
 */

const path = require('path');
const { pathKey } = require('../util');
const { fromObject } = require('./filequery');

function createAssetRoutes(ctx) {
  const {
    db, storage, jobs, versions, config, index,
    guarded, requireAuth, requireAdmin, requireEditor, audit, httpErr, requireFields, clampInt,
    sendJson, readJson, streamFile,
  } = ctx;

  // Resolve a request path to its indexed row, or explain why not.
  async function fileByPath(rel, { allowTrashed = false } = {}) {
    const row = await db.one(
      'SELECT id, path, name, mime, size_bytes, status, owner_user_id FROM files WHERE path_hash = ? LIMIT 1', [rel]);
    if (!row) throw httpErr(404, 'file_not_found', 'File is not indexed');
    if (!allowTrashed && row.status === 'trashed') throw httpErr(409, 'trashed', 'File is in the trash');
    return row;
  }
  const relOfBody = (v) => String(v || '').replace(/^\/+/, '');
  const fileByRel = (rel, opts) => fileByPath(pathKey(rel), opts);

  // ── 4.1 versions ────────────────────────────────────────────────────────────
  async function listVersions(req, res, { url }) {
    await requireAuth(req);
    const rel = relOfBody(url.searchParams.get('path'));
    if (!rel) throw httpErr(400, 'missing_field', 'Missing field: path');
    await fileByRel(rel, { allowTrashed: true });
    return sendJson(res, 200, {
      versions: await versions.list(rel),
      retention: { enabled: versions.enabled, keepCount: versions.retainCount, keepDays: versions.retainDays || null },
    });
  }

  // Serve the retained bytes themselves. Versions live outside every served volume,
  // so this endpoint is the only way to read one — which is the point.
  async function getVersion(req, res, { url, params }) {
    await requireAuth(req);
    const rel = relOfBody(url.searchParams.get('path'));
    if (!rel) throw httpErr(400, 'missing_field', 'Missing field: path');
    const v = await versions.openVersion(rel, Number(params[0]));
    if (!v) throw httpErr(404, 'no_such_version', 'No retained copy of that version');
    res.setHeader('Content-Disposition', `attachment; filename="v${params[0]}-${path.basename(rel).replace(/["\\\r\n]/g, '_')}"`);
    return streamFile(req, res, v.abs, v.mime, v.stat);
  }

  async function restoreVersion(req, res) {
    const c = await requireEditor(req);
    const body = await readJson(req);
    requireFields(body, ['path', 'version']);
    const rel = relOfBody(body.path);
    const out = await versions.restore(rel, Number(body.version), { userId: c.user.id });
    await ctx.purgeCache(rel);
    await audit(req, 'version_restore', rel, c.user.id);
    return sendJson(res, 200, out);
  }

  async function purgeVersion(req, res, { url, params }) {
    const c = await requireEditor(req);
    const rel = relOfBody(url.searchParams.get('path'));
    if (!rel) throw httpErr(400, 'missing_field', 'Missing field: path');
    const ok = await versions.purge(rel, Number(params[0]));
    if (!ok) throw httpErr(404, 'no_such_version', 'No retained copy of that version');
    await audit(req, 'version_purge', rel, c.user.id);
    return sendJson(res, 200, { ok: true });
  }

  // ── 4.2 folders ─────────────────────────────────────────────────────────────
  // Folders were path prefixes only: `folders` and `files.folder_id` were never
  // written. Rows are materialized from the paths already in the index, so a folder
  // can own metadata, be shared as a unit, and be renamed as a subtree.
  async function syncFolders(req, res) {
    const c = await requireEditor(req);
    const n = await rebuildFolders();
    await audit(req, 'folders_sync', null, c.user.id);
    return sendJson(res, 200, { ok: true, folders: n });
  }

  async function rebuildFolders() {
    const rows = await db.query("SELECT id, path FROM files WHERE status <> 'trashed'");
    const dirs = new Set();
    for (const r of rows) {
      const parts = String(r.path).split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    // Shortest first, so a parent always exists before its child needs its id.
    for (const d of [...dirs].sort((a, b) => a.length - b.length)) {
      const parentPath = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : null;
      const parent = parentPath ? await db.one('SELECT id FROM folders WHERE path = ?', [parentPath]) : null;
      await db.query(
        'INSERT INTO folders (path, name, parent_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id)',
        [d, d.split('/').pop(), parent ? parent.id : null]);
    }
    // Point every file at its folder in one statement rather than per row.
    await db.query(
      `UPDATE files f JOIN folders d
          ON d.path = SUBSTRING_INDEX(f.path, '/', LENGTH(f.path) - LENGTH(REPLACE(f.path, '/', '')))
         SET f.folder_id = d.id
       WHERE f.path LIKE '%/%'`);
    return dirs.size;
  }

  async function listFolders(req, res, { url }) {
    await requireAuth(req);
    const parent = url.searchParams.get('parent');
    const rows = await db.query(
      `SELECT d.id, d.path, d.name, d.parent_id, d.owner_user_id,
              (SELECT COUNT(*) FROM files f WHERE f.folder_id = d.id AND f.status='active') AS file_count
         FROM folders d
        ${parent ? 'WHERE d.parent_id = (SELECT id FROM folders WHERE path = ?)' : ''}
        ORDER BY d.path LIMIT 2000`, parent ? [parent] : []);
    return sendJson(res, 200, { folders: rows.map((r) => ({ ...r, file_count: Number(r.file_count) })) });
  }

  /**
   * Rename or move a folder subtree. The bytes move through the same `masterops`
   * used by WebDAV, so placement, indexing, cache purge and cluster replication all
   * behave identically to any other write — and the folder rows are rebuilt after.
   */
  async function renameFolder(req, res) {
    const c = await requireEditor(req);
    const body = await readJson(req);
    requireFields(body, ['path', 'to']);
    const from = relOfBody(body.path).replace(/\/+$/, '');
    const to = relOfBody(body.to).replace(/\/+$/, '');
    if (!from || !to) throw httpErr(400, 'bad_path', 'Both path and to are required');
    if (to === from) throw httpErr(400, 'bad_path', 'Source and destination are the same');
    if (to.startsWith(from + '/')) throw httpErr(400, 'bad_path', 'Cannot move a folder inside itself');
    const s = await storage.statPath(from);
    if (!s || s.type !== 'dir') throw httpErr(404, 'not_found', 'No such folder');
    if (await storage.statPath(to)) throw httpErr(409, 'exists', 'Destination already exists');

    await ctx.masterops.moveCopy(from, to, { move: true, actingUser: c.user });
    await rebuildFolders();
    await audit(req, 'folder_move', `${from} → ${to}`, c.user.id);
    return sendJson(res, 200, { ok: true, from, to });
  }

  // ── 4.3 collections ─────────────────────────────────────────────────────────
  async function listCollections(req, res) {
    await requireAuth(req);
    const rows = await db.query(
      `SELECT c.*, (SELECT COUNT(*) FROM collection_files cf WHERE cf.collection_id = c.id) AS file_count
         FROM collections c ORDER BY c.name`);
    return sendJson(res, 200, { collections: rows.map((r) => ({ ...r, file_count: Number(r.file_count) })) });
  }

  async function createCollection(req, res) {
    const c = await requireEditor(req);
    const body = await readJson(req);
    requireFields(body, ['name']);
    try {
      const r = await db.query('INSERT INTO collections (name, description, owner_user_id) VALUES (?, ?, ?)',
        [String(body.name).slice(0, 191), body.description || null, c.user.id]);
      await audit(req, 'collection_create', null, c.user.id);
      return sendJson(res, 201, { collection: await db.one('SELECT * FROM collections WHERE id = ?', [r.insertId]) });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw httpErr(409, 'exists', 'A collection with that name already exists');
      throw e;
    }
  }

  async function deleteCollection(req, res, { params }) {
    const c = await requireEditor(req);
    const r = await db.query('DELETE FROM collections WHERE id = ?', [Number(params[0])]);
    if (!r.affectedRows) throw httpErr(404, 'not_found', 'Collection not found');
    await audit(req, 'collection_delete', null, c.user.id);
    return sendJson(res, 200, { ok: true });
  }

  async function collectionFiles(req, res, { params, url }) {
    await requireAuth(req);
    const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
    const rows = await db.query(
      `SELECT f.id, f.path, f.name, f.mime, f.size_bytes, f.width, f.height, f.status, cf.position, cf.added_at
         FROM collection_files cf JOIN files f ON f.id = cf.file_id
        WHERE cf.collection_id = ? ORDER BY cf.position IS NULL, cf.position, cf.added_at DESC LIMIT ${limit}`,
      [Number(params[0])]);
    return sendJson(res, 200, { files: rows });
  }

  // Add or remove by path, in bulk — a collection is edited a selection at a time.
  async function editCollectionFiles(req, res, { params }) {
    const c = await requireEditor(req);
    const body = await readJson(req);
    const id = Number(params[0]);
    if (!(await db.one('SELECT id FROM collections WHERE id = ?', [id]))) throw httpErr(404, 'not_found', 'Collection not found');
    const add = Array.isArray(body.add) ? body.add : [];
    const remove = Array.isArray(body.remove) ? body.remove : [];
    let added = 0, removed = 0;
    for (const p of add) {
      const f = await db.one('SELECT id FROM files WHERE path_hash = ?', [pathKey(relOfBody(p))]);
      if (!f) continue;
      const r = await db.query('INSERT IGNORE INTO collection_files (collection_id, file_id, added_by) VALUES (?, ?, ?)', [id, f.id, c.user.id]);
      added += r.affectedRows || 0;
    }
    for (const p of remove) {
      const f = await db.one('SELECT id FROM files WHERE path_hash = ?', [pathKey(relOfBody(p))]);
      if (!f) continue;
      const r = await db.query('DELETE FROM collection_files WHERE collection_id = ? AND file_id = ?', [id, f.id]);
      removed += r.affectedRows || 0;
    }
    await audit(req, 'collection_edit', null, c.user.id);
    return sendJson(res, 200, { ok: true, added, removed });
  }

  // ── 4.4 custom metadata ─────────────────────────────────────────────────────
  async function listFields(req, res) {
    await requireAuth(req);
    const rows = await db.query('SELECT * FROM metadata_fields ORDER BY position, id');
    return sendJson(res, 200, { fields: rows.map(shapeField) });
  }

  async function createField(req, res) {
    const c = await requireAdmin(req);
    const body = await readJson(req);
    requireFields(body, ['field_key', 'label']);
    const type = ['text', 'number', 'date', 'enum', 'multi', 'bool'].includes(body.type) ? body.type : 'text';
    const key = String(body.field_key).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
    if (!key) throw httpErr(400, 'bad_key', 'field_key must contain letters or digits');
    try {
      const r = await db.query(
        'INSERT INTO metadata_fields (field_key, label, type, options, required, position) VALUES (?, ?, ?, ?, ?, ?)',
        [key, String(body.label).slice(0, 191), type,
         body.options ? JSON.stringify(body.options) : null, body.required ? 1 : 0, Number(body.position) || 0]);
      await audit(req, 'field_create', null, c.user.id);
      return sendJson(res, 201, { field: shapeField(await db.one('SELECT * FROM metadata_fields WHERE id = ?', [r.insertId])) });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw httpErr(409, 'exists', 'A field with that key already exists');
      throw e;
    }
  }

  async function deleteField(req, res, { params }) {
    const c = await requireAdmin(req);
    const r = await db.query('DELETE FROM metadata_fields WHERE id = ?', [Number(params[0])]);
    if (!r.affectedRows) throw httpErr(404, 'not_found', 'Field not found');
    await audit(req, 'field_delete', null, c.user.id);
    return sendJson(res, 200, { ok: true });
  }

  async function getFileFields(req, res, { url }) {
    await requireAuth(req);
    const rel = relOfBody(url.searchParams.get('path'));
    if (!rel) throw httpErr(400, 'missing_field', 'Missing field: path');
    const rows = await db.query(
      `SELECT m.field_key, m.label, m.type, v.value_text, v.value_num, v.value_date
         FROM metadata_fields m
         LEFT JOIN file_field_values v ON v.field_id = m.id
          AND v.file_id = (SELECT id FROM files WHERE path_hash = ?)
        ORDER BY m.position, m.id`, [pathKey(rel)]);
    const out = {};
    for (const r of rows) out[r.field_key] = readValue(r);
    return sendJson(res, 200, { values: out, fields: rows.map((r) => ({ field_key: r.field_key, label: r.label, type: r.type })) });
  }

  // Write a value into the column its type deserves, so filtering and ordering are
  // real comparisons rather than string ones.
  async function setFileFields(req, res) {
    const c = await requireEditor(req);
    const body = await readJson(req);
    requireFields(body, ['path']);
    const rel = relOfBody(body.path);
    const file = await fileByRel(rel);
    const values = body.values && typeof body.values === 'object' ? body.values : {};
    const applied = {};
    for (const [key, raw] of Object.entries(values)) {
      const field = await db.one('SELECT * FROM metadata_fields WHERE field_key = ?', [key]);
      if (!field) continue;
      if (raw == null || raw === '') {
        await db.query('DELETE FROM file_field_values WHERE file_id = ? AND field_id = ?', [file.id, field.id]);
        applied[key] = null;
        continue;
      }
      const v = coerceValue(field, raw);
      await db.query(
        `INSERT INTO file_field_values (file_id, field_id, value_text, value_num, value_date)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE value_text=VALUES(value_text), value_num=VALUES(value_num), value_date=VALUES(value_date)`,
        [file.id, field.id, v.text, v.num, v.date]);
      applied[key] = raw;
    }
    await audit(req, 'fields_set', rel, c.user.id);
    return sendJson(res, 200, { values: applied });
  }

  // ── 4.6 named renditions ────────────────────────────────────────────────────
  async function listRenditions(req, res) {
    await requireAuth(req);
    return sendJson(res, 200, { renditions: await db.query('SELECT * FROM renditions ORDER BY name') });
  }

  async function upsertRendition(req, res) {
    const c = await requireAdmin(req);
    const body = await readJson(req);
    requireFields(body, ['name']);
    const name = String(body.name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
    if (!name) throw httpErr(400, 'bad_name', 'name must contain letters or digits');
    await db.query(
      `INSERT INTO renditions (name, width, height, fit, format, quality, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE width=VALUES(width), height=VALUES(height), fit=VALUES(fit),
         format=VALUES(format), quality=VALUES(quality), description=VALUES(description)`,
      [name, posInt(body.width), posInt(body.height), body.fit || null, body.format || null, posInt(body.quality), body.description || null]);
    ctx.invalidateRenditions();
    await audit(req, 'rendition_upsert', name, c.user.id);
    return sendJson(res, 200, { rendition: await db.one('SELECT * FROM renditions WHERE name = ?', [name]) });
  }

  async function deleteRendition(req, res, { params }) {
    const c = await requireAdmin(req);
    const r = await db.query('DELETE FROM renditions WHERE name = ?', [String(params[0])]);
    if (!r.affectedRows) throw httpErr(404, 'not_found', 'Rendition not found');
    ctx.invalidateRenditions();
    await audit(req, 'rendition_delete', String(params[0]), c.user.id);
    return sendJson(res, 200, { ok: true });
  }

  // ── 4.5 saved searches + bulk operations ────────────────────────────────────
  async function listSearches(req, res) {
    const c = await requireAuth(req);
    const rows = await db.query(
      'SELECT * FROM saved_searches WHERE owner_user_id = ? OR shared = 1 ORDER BY name', [c.user.id]);
    return sendJson(res, 200, { searches: rows.map((r) => ({ ...r, query: parseJson(r.query) })) });
  }

  async function saveSearch(req, res) {
    const c = await requireAuth(req);
    const body = await readJson(req);
    requireFields(body, ['name', 'query']);
    await db.query(
      `INSERT INTO saved_searches (name, query, owner_user_id, shared) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE query = VALUES(query), shared = VALUES(shared)`,
      [String(body.name).slice(0, 191), JSON.stringify(body.query), c.user.id, body.shared ? 1 : 0]);
    return sendJson(res, 201, { ok: true });
  }

  async function deleteSearch(req, res, { params }) {
    const c = await requireAuth(req);
    const r = await db.query('DELETE FROM saved_searches WHERE id = ? AND owner_user_id = ?', [Number(params[0]), c.user.id]);
    if (!r.affectedRows) throw httpErr(404, 'not_found', 'Saved search not found');
    return sendJson(res, 200, { ok: true });
  }

  /**
   * Apply an action to everything matching a filter. Queued as a job rather than run
   * inline: "tag 40,000 assets" is not a request-path operation, and the queue
   * already gives it progress, cancellation and retry.
   */
  async function bulk(req, res) {
    const c = await requireEditor(req);
    const body = await readJson(req);
    requireFields(body, ['action']);
    const action = String(body.action);
    if (!['tag', 'untag', 'collection_add', 'collection_remove', 'delete', 'enrich', 'extract'].includes(action)) {
      throw httpErr(400, 'bad_action', `Unsupported bulk action: ${action}`);
    }
    if (!jobs || !jobs.enabled) throw httpErr(503, 'jobs_disabled', 'Bulk operations need the job queue');
    // Refuse up front rather than queueing thousands of jobs no handler in this
    // deployment will ever claim.
    if (action === 'enrich') requireAi();
    const id = await jobs.enqueue('bulk', {
      action,
      filter: body.filter && typeof body.filter === 'object' ? body.filter : {},
      params: body.params && typeof body.params === 'object' ? body.params : {},
      userId: c.user.id,
    }, { priority: 6, createdBy: c.user.id });
    if (!id) throw httpErr(500, 'enqueue_failed', 'Could not queue the operation');
    await audit(req, 'bulk_' + action, null, c.user.id);
    return sendJson(res, 202, { job: await jobs.get(id) });
  }

  // ── 4.7 comments + notifications ────────────────────────────────────────────
  async function listComments(req, res, { url }) {
    await requireAuth(req);
    const rel = relOfBody(url.searchParams.get('path'));
    if (!rel) throw httpErr(400, 'missing_field', 'Missing field: path');
    const rows = await db.query(
      `SELECT c.id, c.body, c.parent_id, c.resolved_at, c.created_at, c.user_id, u.username, u.display_name
         FROM comments c JOIN files f ON f.id = c.file_id LEFT JOIN users u ON u.id = c.user_id
        WHERE f.path_hash = ? ORDER BY c.id`, [pathKey(rel)]);
    return sendJson(res, 200, { comments: rows });
  }

  async function addComment(req, res) {
    const c = await requireAuth(req);
    const body = await readJson(req);
    requireFields(body, ['path', 'body']);
    const rel = relOfBody(body.path);
    const file = await fileByRel(rel, { allowTrashed: true });
    const text = String(body.body).slice(0, 8000);
    const r = await db.query('INSERT INTO comments (file_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)',
      [file.id, c.user.id, body.parent_id ? Number(body.parent_id) : null, text]);
    await notifyAbout(file, c.user, text);
    await audit(req, 'comment_add', rel, c.user.id);
    return sendJson(res, 201, { comment: await db.one('SELECT * FROM comments WHERE id = ?', [r.insertId]) });
  }

  /**
   * Tell the people already involved with this asset: its owner, and everyone who
   * has commented on it. Notifying the whole installation would make the feature
   * useless within a week.
   */
  async function notifyAbout(file, actor, text) {
    const targets = new Set();
    if (file.owner_user_id) targets.add(Number(file.owner_user_id));
    const others = await db.query('SELECT DISTINCT user_id FROM comments WHERE file_id = ? AND user_id IS NOT NULL', [file.id]);
    for (const o of others) targets.add(Number(o.user_id));
    targets.delete(Number(actor.id)); // nobody needs telling about their own comment
    for (const uid of targets) {
      await db.query('INSERT INTO notifications (user_id, kind, body, file_id, actor_id) VALUES (?, ?, ?, ?, ?)',
        [uid, 'comment', `${actor.username} commented on ${file.name}: ${text.slice(0, 140)}`, file.id, actor.id]).catch(() => {});
    }
  }

  async function editComment(req, res, { params }) {
    const c = await requireAuth(req);
    const body = await readJson(req);
    const id = Number(params[0]);
    const row = await db.one('SELECT * FROM comments WHERE id = ?', [id]);
    if (!row) throw httpErr(404, 'not_found', 'Comment not found');
    if (Number(row.user_id) !== c.user.id && !ctx.isAdmin(c)) throw httpErr(403, 'forbidden', 'Not your comment');
    if (body.resolved != null) {
      await db.query('UPDATE comments SET resolved_at = ? WHERE id = ?', [body.resolved ? new Date() : null, id]);
    }
    if (body.body) await db.query('UPDATE comments SET body = ? WHERE id = ?', [String(body.body).slice(0, 8000), id]);
    return sendJson(res, 200, { comment: await db.one('SELECT * FROM comments WHERE id = ?', [id]) });
  }

  async function deleteComment(req, res, { params }) {
    const c = await requireAuth(req);
    const row = await db.one('SELECT * FROM comments WHERE id = ?', [Number(params[0])]);
    if (!row) throw httpErr(404, 'not_found', 'Comment not found');
    if (Number(row.user_id) !== c.user.id && !ctx.isAdmin(c)) throw httpErr(403, 'forbidden', 'Not your comment');
    await db.query('DELETE FROM comments WHERE id = ? OR parent_id = ?', [row.id, row.id]);
    return sendJson(res, 200, { ok: true });
  }

  async function listNotifications(req, res, { url }) {
    const c = await requireAuth(req);
    const unread = url.searchParams.get('unread') === '1';
    const rows = await db.query(
      `SELECT n.*, f.path AS file_path FROM notifications n LEFT JOIN files f ON f.id = n.file_id
        WHERE n.user_id = ? ${unread ? 'AND n.read_at IS NULL' : ''} ORDER BY n.id DESC LIMIT 200`, [c.user.id]);
    const count = await db.one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [c.user.id]);
    return sendJson(res, 200, { notifications: rows, unread: count ? Number(count.n) : 0 });
  }

  async function readNotifications(req, res) {
    const c = await requireAuth(req);
    const body = await readJson(req);
    if (Array.isArray(body.ids) && body.ids.length) {
      await db.query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND id IN (?)', [c.user.id, body.ids.map(Number)]);
    } else {
      await db.query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [c.user.id]);
    }
    return sendJson(res, 200, { ok: true });
  }

  // ── 5.8 AI review + 5.9 cost accounting ─────────────────────────────────────
  // The console surface for AI output. Nothing a model produced is allowed to be
  // indistinguishable from what a person asserted — so suggestions live apart from
  // human tags and only become human tags through an explicit promotion here.
  const { ai, aiStore } = ctx;
  function requireAi() {
    if (!ai || !ai.enabled) throw httpErr(503, 'ai_disabled', `AI enrichment is not configured (${(ai && ai.disabledReason) || 'no provider'})`);
    return ai;
  }

  async function aiStatus(req, res) {
    await requireAuth(req);
    const enabled = !!(ai && ai.enabled);
    const body = { enabled, reason: enabled ? null : (ai && ai.disabledReason) || 'no provider' };
    if (enabled) {
      body.model = ai.model;
      body.promptVersion = ai.promptVersion;
      body.pricingPerMTok = ai.pricing;
      body.maxImageDim = config.aiMaxImageDim;
      body.budget = { monthlyUsd: config.aiMonthlyBudgetUsd || null, spentThisMonth: await ai.monthlySpend() };
    }
    return sendJson(res, 200, body);
  }

  async function getFileAi(req, res, { url }) {
    await requireAuth(req);
    const rel = relOfBody(url.searchParams.get('path'));
    if (!rel) throw httpErr(400, 'missing_field', 'Missing field: path');
    return sendJson(res, 200, { ai: aiStore ? await aiStore.get(rel) : null });
  }

  /**
   * Review actions: accept (promote suggested tags to human tags), reject
   * (individual tags or the whole enrichment), and edit the generated prose.
   * A human edit is authoritative — a later re-run overwrites the machine output,
   * but a rejected tag never comes back.
   */
  async function reviewFileAi(req, res) {
    const c = await requireEditor(req);
    const body = await readJson(req);
    requireFields(body, ['path', 'action']);
    const rel = relOfBody(body.path);
    const file = await fileByRel(rel, { allowTrashed: true });
    const action = String(body.action);
    let result;
    switch (action) {
      case 'promote_tags':
        result = { promoted: await aiStore.promoteTags(file.id, body.tags || [], c.user.id) };
        break;
      case 'reject_tags':
        result = { rejected: await aiStore.rejectTags(file.id, body.tags || [], c.user.id) };
        break;
      case 'edit':
        result = { edited: await aiStore.edit(file.id, body.fields || {}, c.user.id) };
        break;
      case 'reject':
        result = { rejected: await aiStore.reject(file.id, c.user.id) };
        break;
      default:
        throw httpErr(400, 'bad_action', `Unsupported review action: ${action}`);
    }
    await audit(req, 'ai_review_' + action, rel, c.user.id);
    return sendJson(res, 200, { ok: true, ...result, ai: await aiStore.get(rel) });
  }

  /** Queue enrichment: one asset live, or a whole filter through the batch path. */
  async function enrich(req, res) {
    const c = await requireEditor(req);
    requireAi();
    if (!jobs || !jobs.enabled) throw httpErr(503, 'jobs_disabled', 'Enrichment needs the job queue');
    const body = await readJson(req);
    if (body.path) {
      const rel = relOfBody(body.path);
      await fileByRel(rel);
      const id = await jobs.enqueue('enrich', { path: rel }, {
        dedupeKey: `enrich:${pathKey(rel)}`, priority: 5, createdBy: c.user.id,
      });
      await audit(req, 'ai_enrich', rel, c.user.id);
      return sendJson(res, 202, { job: await jobs.get(id) });
    }
    // Bulk: the Batches API at half price is the right shape for a library, and is
    // the default for anything but a single asset.
    const id = await jobs.enqueue('enrich_batch', {
      filter: body.filter && typeof body.filter === 'object' ? body.filter : {},
      limit: body.limit, userId: c.user.id,
    }, { priority: 7, createdBy: c.user.id });
    await audit(req, 'ai_backfill', null, c.user.id);
    return sendJson(res, 202, { job: await jobs.get(id) });
  }

  async function aiUsage(req, res, { url }) {
    await requireAdmin(req);
    const usage = aiStore ? await aiStore.usage({ days: clampInt(url.searchParams.get('days'), 30, 1, 365) }) : {};
    const batches = db ? await db.query('SELECT * FROM ai_batches ORDER BY id DESC LIMIT 50').catch(() => []) : [];
    return sendJson(res, 200, {
      ...usage,
      budget: { monthlyUsd: config.aiMonthlyBudgetUsd || null },
      model: ai && ai.enabled ? ai.model : null,
      batches,
    });
  }

  return [
    ['GET', /^\/_api\/ai\/status$/, guarded(aiStatus)],
    ['GET', /^\/_api\/ai\/usage$/, guarded(aiUsage)],
    ['POST', /^\/_api\/ai\/enrich$/, guarded(enrich)],
    ['GET', /^\/_api\/files\/ai$/, guarded(getFileAi)],
    ['POST', /^\/_api\/files\/ai\/review$/, guarded(reviewFileAi)],
    ['GET', /^\/_api\/files\/versions$/, guarded(listVersions)],
    ['GET', /^\/_api\/files\/versions\/(\d+)$/, guarded(getVersion)],
    ['POST', /^\/_api\/files\/versions\/restore$/, guarded(restoreVersion)],
    ['DELETE', /^\/_api\/files\/versions\/(\d+)$/, guarded(purgeVersion)],
    ['GET', /^\/_api\/files\/fields$/, guarded(getFileFields)],
    ['PUT', /^\/_api\/files\/fields$/, guarded(setFileFields)],
    ['GET', /^\/_api\/folders$/, guarded(listFolders)],
    ['POST', /^\/_api\/folders\/sync$/, guarded(syncFolders)],
    ['POST', /^\/_api\/folders\/move$/, guarded(renameFolder)],
    ['GET', /^\/_api\/collections$/, guarded(listCollections)],
    ['POST', /^\/_api\/collections$/, guarded(createCollection)],
    ['DELETE', /^\/_api\/collections\/(\d+)$/, guarded(deleteCollection)],
    ['GET', /^\/_api\/collections\/(\d+)\/files$/, guarded(collectionFiles)],
    ['POST', /^\/_api\/collections\/(\d+)\/files$/, guarded(editCollectionFiles)],
    ['GET', /^\/_api\/fields$/, guarded(listFields)],
    ['POST', /^\/_api\/fields$/, guarded(createField)],
    ['DELETE', /^\/_api\/fields\/(\d+)$/, guarded(deleteField)],
    ['GET', /^\/_api\/renditions$/, guarded(listRenditions)],
    ['POST', /^\/_api\/renditions$/, guarded(upsertRendition)],
    ['DELETE', /^\/_api\/renditions\/([A-Za-z0-9_-]+)$/, guarded(deleteRendition)],
    ['GET', /^\/_api\/searches$/, guarded(listSearches)],
    ['POST', /^\/_api\/searches$/, guarded(saveSearch)],
    ['DELETE', /^\/_api\/searches\/(\d+)$/, guarded(deleteSearch)],
    ['POST', /^\/_api\/bulk$/, guarded(bulk)],
    ['GET', /^\/_api\/comments$/, guarded(listComments)],
    ['POST', /^\/_api\/comments$/, guarded(addComment)],
    ['PATCH', /^\/_api\/comments\/(\d+)$/, guarded(editComment)],
    ['DELETE', /^\/_api\/comments\/(\d+)$/, guarded(deleteComment)],
    ['GET', /^\/_api\/notifications$/, guarded(listNotifications)],
    ['POST', /^\/_api\/notifications\/read$/, guarded(readNotifications)],
  ];
}

// ── value coercion for custom fields ──────────────────────────────────────────
function coerceValue(field, raw) {
  const out = { text: null, num: null, date: null };
  switch (field.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw badValue(field, 'a number');
      out.num = n; out.text = String(n);
      break;
    }
    case 'date': {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw badValue(field, 'a date');
      out.date = d; out.text = d.toISOString();
      break;
    }
    case 'bool':
      out.num = /^(1|true|yes|on)$/i.test(String(raw)) ? 1 : 0;
      out.text = out.num ? 'true' : 'false';
      break;
    case 'multi':
      out.text = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x)).join(', ');
      break;
    default:
      out.text = String(raw).slice(0, 4000);
  }
  return out;
}
function badValue(field, want) {
  const e = new Error(`${field.field_key} must be ${want}`);
  e.statusCode = 400; e.error = 'bad_value';
  return e;
}
function readValue(r) {
  if (r.value_num != null && r.type === 'number') return Number(r.value_num);
  if (r.value_num != null && r.type === 'bool') return Number(r.value_num) === 1;
  if (r.value_date != null) return r.value_date;
  if (r.value_text != null && r.type === 'multi') return r.value_text.split(',').map((s) => s.trim()).filter(Boolean);
  return r.value_text;
}
function shapeField(f) { return f ? { ...f, options: parseJson(f.options), required: !!f.required } : f; }
function parseJson(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }
function posInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }

module.exports = { createAssetRoutes };
