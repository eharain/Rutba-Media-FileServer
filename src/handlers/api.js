'use strict';

/**
 * JSON control-plane under `/_api/*` — the surface the eventual web UI / mobile
 * client / integrations talk to. Entirely gated on `db.enabled`: with no database
 * every route returns 503 `{error:'db_disabled'}` and the media data-plane
 * (GET/PUT/DELETE /<path>) is untouched.
 *
 * Routes (all JSON):
 *   POST /_api/auth/register   {email,username,password,display_name?}  → {user,token}
 *   POST /_api/auth/login      {login,password}                          → {user,token,roles}
 *   POST /_api/auth/logout     (bearer)                                  → 204
 *   GET  /_api/auth/me         (bearer)                                  → {user,roles}
 *   GET  /_api/users           (admin)                                   → {users}
 *   POST /_api/users           (admin) {email,username,password,role?}   → {user}
 *   POST /_api/users/:id/roles (admin) {role}                            → {ok}
 *   GET  /_api/files           (auth)  ?q=&type=&visibility=&status=&limit=&offset=  → {files,total}
 *   GET  /_api/audit           (admin) ?limit=&offset=                    → {events}
 *   GET  /_api/stats           (admin)                                    → counts + storage
 *
 * The register route allows the FIRST account unconditionally (bootstrap admin);
 * further self-registration needs config.allowRegistration, else an admin creates
 * accounts via POST /_api/users.
 */

const crypto = require('crypto');
const { sendJson, readJson, clientIp } = require('../http');
const { hasRole, hashPassword, mysqlDate } = require('../auth');

function createApiHandler({ config, db, auth, trash, storage }) {
  // Wrap a handler so it only runs with a live DB, and turn thrown {statusCode}
  // errors into clean JSON responses.
  const guarded = (fn) => async (req, res, ctx) => {
    if (!db.enabled) return sendJson(res, 503, { error: 'db_disabled', message: 'Database layer is not configured' });
    try { return await fn(req, res, ctx); }
    catch (e) {
      const code = e.statusCode || 500;
      if (code >= 500) console.warn(`[media] api error: ${e.stack || e.message}`);
      return sendJson(res, code, { error: e.error || 'error', message: e.message });
    }
  };

  const requireAuth = async (req) => {
    const ctx = await auth.authenticate(req);
    if (!ctx) throw httpErr(401, 'unauthorized', 'Authentication required');
    return ctx;
  };
  const requireAdmin = async (req) => {
    const ctx = await requireAuth(req);
    if (!hasRole(ctx, 'admin')) throw httpErr(403, 'forbidden', 'Admin role required');
    return ctx;
  };

  // ── route table: [method, /regex/ with named-ish groups, handler] ──────────
  const routes = [
    ['POST', /^\/_api\/auth\/register$/, guarded(register)],
    ['POST', /^\/_api\/auth\/login$/, guarded(login)],
    ['POST', /^\/_api\/auth\/logout$/, guarded(logout)],
    ['GET', /^\/_api\/auth\/me$/, guarded(me)],
    ['GET', /^\/_api\/users$/, guarded(listUsers)],
    ['POST', /^\/_api\/users$/, guarded(createUser)],
    ['POST', /^\/_api\/users\/(\d+)\/roles$/, guarded(addRole)],
    ['POST', /^\/_api\/users\/(\d+)\/quota$/, guarded(setQuota)],
    ['GET', /^\/_api\/files$/, guarded(listFiles)],
    ['GET', /^\/_api\/files\/duplicates$/, guarded(duplicates)],
    ['GET', /^\/_api\/files\/metadata$/, guarded(fileMetadata)],
    ['GET', /^\/_api\/files\/tags$/, guarded(getFileTags)],
    ['PUT', /^\/_api\/files\/tags$/, guarded(setFileTags)],
    ['POST', /^\/_api\/files\/restore$/, guarded(restoreFile)],
    ['POST', /^\/_api\/files\/purge$/, guarded(purgeFile)],
    ['POST', /^\/_api\/trash\/empty$/, guarded(emptyTrash)],
    ['GET', /^\/_api\/tags$/, guarded(listTags)],
    ['POST', /^\/_api\/shares$/, guarded(createShare)],
    ['GET', /^\/_api\/shares$/, guarded(listShares)],
    ['DELETE', /^\/_api\/shares\/(\d+)$/, guarded(revokeShare)],
    ['GET', /^\/_api\/audit$/, guarded(listAudit)],
    ['GET', /^\/_api\/stats$/, guarded(stats)],
    ['GET', /^\/_api\/storage$/, guarded(storageInfo)],
  ];

  async function register(req, res) {
    const body = await readJson(req);
    requireFields(body, ['email', 'username', 'password']);
    const first = (await auth.countUsers()) === 0;
    if (!first && !config.allowRegistration) throw httpErr(403, 'registration_closed', 'Self-registration is disabled');
    if (await auth.findUser(body.email) || await auth.findUser(body.username)) {
      throw httpErr(409, 'exists', 'Email or username already in use');
    }
    const user = await auth.createUser(body);
    const session = await auth.login(body.email, body.password, reqMeta(req));
    await audit(req, 'register', null, user.id);
    return sendJson(res, 201, { user: publicUser(user), token: session.token, roles: await auth.rolesOf(user.id) });
  }

  async function login(req, res) {
    const body = await readJson(req);
    requireFields(body, ['login', 'password']);
    const session = await auth.login(body.login, body.password, reqMeta(req));
    if (!session) { await audit(req, 'login_failed', body.login); throw httpErr(401, 'bad_credentials', 'Invalid login or password'); }
    await audit(req, 'login', null, session.user.id);
    const roles = await auth.rolesOf(session.user.id);
    const cookie = `sid=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionTtlDays * 86400}`;
    return sendJson(res, 200, { user: publicUser(session.user), token: session.token, roles }, { 'Set-Cookie': cookie });
  }

  async function logout(req, res) {
    const { bearerFrom } = require('../auth');
    await auth.logout(bearerFrom(req));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }

  async function me(req, res) {
    const ctx = await requireAuth(req);
    const usage = await usageOf(ctx.user.id);
    return sendJson(res, 200, {
      user: publicUser(ctx.user), roles: ctx.roles,
      storage: { usedBytes: usage, quotaBytes: ctx.user.storage_quota_bytes != null ? Number(ctx.user.storage_quota_bytes) : null },
    });
  }

  async function listUsers(req, res) {
    await requireAdmin(req);
    const rows = await db.query(
      `SELECT u.id, u.email, u.username, u.display_name, u.status, u.mfa_enabled, u.created_at,
              u.storage_quota_bytes,
              GROUP_CONCAT(r.name) AS roles,
              (SELECT COALESCE(SUM(f.size_bytes),0) FROM files f WHERE f.owner_user_id=u.id AND f.status='active') AS used_bytes
       FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id
       GROUP BY u.id ORDER BY u.id`);
    return sendJson(res, 200, { users: rows.map((u) => ({
      ...u, roles: u.roles ? u.roles.split(',') : [],
      storage_quota_bytes: u.storage_quota_bytes != null ? Number(u.storage_quota_bytes) : null,
      used_bytes: Number(u.used_bytes) || 0,
    })) });
  }

  async function createUser(req, res) {
    await requireAdmin(req);
    const body = await readJson(req);
    requireFields(body, ['email', 'username', 'password']);
    if (await auth.findUser(body.email) || await auth.findUser(body.username)) throw httpErr(409, 'exists', 'Email or username already in use');
    const user = await auth.createUser(body);
    if (body.storage_quota_bytes != null && body.storage_quota_bytes !== '') {
      await db.query('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [Number(body.storage_quota_bytes) || null, user.id]);
    }
    await audit(req, 'user_create', null, user.id);
    return sendJson(res, 201, { user: publicUser(user), roles: await auth.rolesOf(user.id) });
  }

  async function addRole(req, res, { params }) {
    await requireAdmin(req);
    const body = await readJson(req);
    requireFields(body, ['role']);
    const ok = await auth.assignRole(Number(params[0]), body.role);
    if (!ok) throw httpErr(400, 'bad_role', 'Unknown role');
    return sendJson(res, 200, { ok: true });
  }

  // Set (or clear, with null) a user's storage quota in bytes.
  async function setQuota(req, res, { params }) {
    await requireAdmin(req);
    const body = await readJson(req);
    const raw = body.bytes;
    const bytes = raw == null || raw === '' ? null : Number(raw);
    if (bytes != null && (!Number.isFinite(bytes) || bytes < 0)) throw httpErr(400, 'bad_quota', 'bytes must be a non-negative number or null');
    const r = await db.query('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [bytes, Number(params[0])]);
    if (!r.affectedRows) throw httpErr(404, 'not_found', 'User not found');
    await audit(req, 'set_quota', null, Number(params[0]));
    return sendJson(res, 200, { ok: true, quotaBytes: bytes });
  }

  async function usageOf(userId) {
    const r = await db.one("SELECT COALESCE(SUM(size_bytes),0) AS s FROM files WHERE owner_user_id=? AND status='active'", [userId]);
    return r ? Number(r.s) || 0 : 0;
  }

  async function listFiles(req, res, { url }) {
    await requireAuth(req);
    const q = url.searchParams;
    const where = [];
    const args = [];
    const status = q.get('status') || 'active';
    where.push('status = ?'); args.push(status === 'trashed' ? 'trashed' : status === 'all' ? status : 'active');
    if (where[where.length - 1] === 'status = ?' && args[args.length - 1] === 'all') { where.pop(); args.pop(); }
    if (q.get('q')) { where.push('(path LIKE ? OR name LIKE ?)'); const like = `%${q.get('q')}%`; args.push(like, like); }
    if (q.get('type')) { where.push('mime LIKE ?'); args.push(`${q.get('type')}%`); }
    if (q.get('visibility')) { where.push('visibility = ?'); args.push(q.get('visibility') === 'private' ? 'private' : 'public'); }
    if (q.get('tag')) {
      where.push('id IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.name = ?)');
      args.push(q.get('tag'));
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = clampInt(q.get('limit'), 50, 1, 500);
    const offset = clampInt(q.get('offset'), 0, 0, 1e9);
    const totalRow = await db.one(`SELECT COUNT(*) AS n FROM files ${clause}`, args);
    const rows = await db.query(
      `SELECT id, path, name, ext, mime, size_bytes, width, height, visibility, status, created_at, updated_at
       FROM files ${clause} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`, args);
    return sendJson(res, 200, { files: rows, total: totalRow ? Number(totalRow.n) : rows.length, limit, offset });
  }

  // ── Media metadata (EXIF etc.) ─────────────────────────────────────────────
  async function fileMetadata(req, res, { url }) {
    await requireAuth(req);
    const rel = (url.searchParams.get('path') || '').replace(/^\/+/, '');
    if (!rel) throw httpErr(400, 'missing_field', 'Missing field: path');
    const row = await db.one(
      `SELECT m.* FROM file_metadata m JOIN files f ON f.id = m.file_id WHERE f.path = ? LIMIT 1`, [rel]);
    if (!row) return sendJson(res, 200, { metadata: null });
    // Numeric decimals arrive as strings from mysql2; coerce the useful ones.
    for (const k of ['f_number', 'focal_length', 'gps_lat', 'gps_lng']) if (row[k] != null) row[k] = Number(row[k]);
    if (row.raw && typeof row.raw === 'string') { try { row.raw = JSON.parse(row.raw); } catch { /* leave */ } }
    return sendJson(res, 200, { metadata: row });
  }

  // ── Tags ───────────────────────────────────────────────────────────────────
  async function listTags(req, res) {
    await requireAuth(req);
    const rows = await db.query(
      `SELECT t.id, t.name, COUNT(ft.file_id) AS count
       FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id
       GROUP BY t.id ORDER BY count DESC, t.name ASC`);
    return sendJson(res, 200, { tags: rows.map((t) => ({ ...t, count: Number(t.count) })) });
  }

  async function getFileTags(req, res, { url }) {
    await requireAuth(req);
    const rel = (url.searchParams.get('path') || '').replace(/^\/+/, '');
    if (!rel) throw httpErr(400, 'missing_field', 'Missing field: path');
    const rows = await db.query(
      `SELECT t.name FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
       JOIN files f ON f.id = ft.file_id WHERE f.path = ? ORDER BY t.name`, [rel]);
    return sendJson(res, 200, { tags: rows.map((r) => r.name) });
  }

  // Replace a file's full tag set. Body: { path, tags: [names] }.
  async function setFileTags(req, res) {
    const ctx = await requireAuth(req);
    if (!hasRole(ctx, 'editor')) throw httpErr(403, 'forbidden', 'Editor role required');
    const body = await readJson(req);
    requireFields(body, ['path']);
    const rel = String(body.path).replace(/^\/+/, '');
    const file = await db.one('SELECT id FROM files WHERE path = ? AND status <> ?', [rel, 'trashed']);
    if (!file) throw httpErr(404, 'file_not_found', 'File is not indexed');
    // Normalize: trim, lowercase, dedupe, drop empties, cap length.
    const names = [...new Set((Array.isArray(body.tags) ? body.tags : [])
      .map((t) => String(t).trim().toLowerCase()).filter((t) => t && t.length <= 64))];
    await db.query('DELETE FROM file_tags WHERE file_id = ?', [file.id]);
    for (const name of names) {
      await db.query('INSERT IGNORE INTO tags (name) VALUES (?)', [name]);
      const tag = await db.one('SELECT id FROM tags WHERE name = ?', [name]);
      if (tag) await db.query('INSERT IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)', [file.id, tag.id]);
    }
    await audit(req, 'set_tags', rel, ctx.user.id);
    return sendJson(res, 200, { tags: names });
  }

  // ── Duplicate detection (files sharing a content checksum) ─────────────────
  async function duplicates(req, res) {
    await requireAuth(req);
    const rows = await db.query(
      `SELECT checksum_sha256 AS checksum, COUNT(*) AS n, MAX(size_bytes) AS size_bytes,
              GROUP_CONCAT(path ORDER BY created_at SEPARATOR '\n') AS paths
       FROM files WHERE status='active' AND checksum_sha256 IS NOT NULL AND checksum_sha256 <> ''
       GROUP BY checksum_sha256 HAVING n > 1 ORDER BY n DESC, size_bytes DESC LIMIT 200`);
    let wasted = 0;
    const groups = rows.map((r) => {
      const paths = (r.paths || '').split('\n').filter(Boolean);
      wasted += (Number(r.n) - 1) * Number(r.size_bytes);
      return { checksum: r.checksum, count: Number(r.n), size_bytes: Number(r.size_bytes), paths };
    });
    return sendJson(res, 200, { groups, wastedBytes: wasted });
  }

  // ── Trash & Recovery ───────────────────────────────────────────────────────
  async function restoreFile(req, res) {
    const ctx = await requireAuth(req);
    if (!hasRole(ctx, 'editor')) throw httpErr(403, 'forbidden', 'Editor role required');
    const body = await readJson(req);
    requireFields(body, ['path']);
    const r = await trash.restore(String(body.path).replace(/^\/+/, ''));
    await audit(req, 'restore', r.path, ctx.user.id);
    return sendJson(res, 200, r);
  }

  async function purgeFile(req, res) {
    const ctx = await requireAuth(req);
    if (!hasRole(ctx, 'editor')) throw httpErr(403, 'forbidden', 'Editor role required');
    const body = await readJson(req);
    requireFields(body, ['path']);
    const rel = String(body.path).replace(/^\/+/, '');
    await trash.purge(rel);
    await audit(req, 'purge', rel, ctx.user.id);
    return sendJson(res, 200, { ok: true });
  }

  async function emptyTrash(req, res) {
    const ctx = await requireAdmin(req);
    const r = await trash.emptyTrash();
    await audit(req, 'empty_trash', null, ctx.user.id);
    return sendJson(res, 200, r);
  }

  // ── Share links ────────────────────────────────────────────────────────────
  async function createShare(req, res) {
    const ctx = await requireAuth(req);
    if (!hasRole(ctx, 'editor')) throw httpErr(403, 'forbidden', 'Editor role required');
    const body = await readJson(req);
    // Resolve the target file by id or path (must be indexed and not trashed).
    let file = null;
    if (body.file_id) file = await db.one(`SELECT id, path FROM files WHERE id = ? AND status='active'`, [body.file_id]);
    else if (body.path) file = await db.one(`SELECT id, path FROM files WHERE path = ? AND status='active'`, [String(body.path).replace(/^\/+/, '')]);
    if (!file) throw httpErr(404, 'file_not_found', 'File is not indexed (upload it through the platform first)');

    const permission = body.permission === 'download' ? 'download' : 'view';
    const passwordHash = body.password ? await hashPassword(String(body.password)) : null;
    let expiresAt = null;
    if (body.expires_in_days && Number(body.expires_in_days) > 0) expiresAt = mysqlDate(new Date(Date.now() + Number(body.expires_in_days) * 86400_000));
    const maxDownloads = body.max_downloads && Number(body.max_downloads) > 0 ? Number(body.max_downloads) : null;
    const token = crypto.randomBytes(16).toString('hex');

    await db.query(
      `INSERT INTO shares (token, file_id, permission, password_hash, expires_at, max_downloads, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [token, file.id, permission, passwordHash, expiresAt, maxDownloads, ctx.user.id]);
    await audit(req, 'share_create', file.path, ctx.user.id);
    return sendJson(res, 201, {
      share: { token, permission, expires_at: expiresAt, max_downloads: maxDownloads, protected: !!passwordHash, path: file.path },
      url: shareUrl(req, token), relativeUrl: '/_s/' + token,
    });
  }

  async function listShares(req, res) {
    const ctx = await requireAuth(req);
    const admin = hasRole(ctx, 'admin');
    const rows = await db.query(
      `SELECT s.id, s.token, s.permission, s.expires_at, s.max_downloads, s.download_count, s.created_by, s.created_at,
              (s.password_hash IS NOT NULL) AS protected, f.path AS file_path, f.name AS file_name
       FROM shares s LEFT JOIN files f ON f.id = s.file_id
       ${admin ? '' : 'WHERE s.created_by = ?'} ORDER BY s.id DESC LIMIT 500`, admin ? [] : [ctx.user.id]);
    return sendJson(res, 200, { shares: rows.map((s) => ({ ...s, protected: !!s.protected, url: shareUrl(req, s.token) })) });
  }

  async function revokeShare(req, res, { params }) {
    const ctx = await requireAuth(req);
    const id = Number(params[0]);
    const row = await db.one('SELECT created_by FROM shares WHERE id = ?', [id]);
    if (!row) throw httpErr(404, 'not_found', 'Share not found');
    if (row.created_by !== ctx.user.id && !hasRole(ctx, 'admin')) throw httpErr(403, 'forbidden', 'Not your share');
    await db.query('DELETE FROM shares WHERE id = ?', [id]);
    await audit(req, 'share_revoke', null, ctx.user.id);
    return sendJson(res, 200, { ok: true });
  }

  async function listAudit(req, res, { url }) {
    await requireAdmin(req);
    const limit = clampInt(url.searchParams.get('limit'), 100, 1, 1000);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1e9);
    const rows = await db.query(
      `SELECT id, user_id, action, target_path, ip, created_at FROM audit_log
       ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`);
    return sendJson(res, 200, { events: rows, limit, offset });
  }

  async function storageInfo(req, res) {
    await requireAdmin(req);
    const volumes = storage ? await storage.usage() : [];
    return sendJson(res, 200, { placement: config.storagePlacement, multi: !!(storage && storage.multi), volumes });
  }

  async function stats(req, res) {
    await requireAdmin(req);
    const files = await db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM files WHERE status='active'`);
    const trashed = await db.one(`SELECT COUNT(*) AS n FROM files WHERE status='trashed'`);
    const users = await db.one(`SELECT COUNT(*) AS n FROM users`);
    return sendJson(res, 200, {
      files: Number(files.n), storageBytes: Number(files.bytes), trashed: Number(trashed.n), users: Number(users.n),
    });
  }

  // Audit helper that resolves the acting user from the request (best-effort).
  async function audit(req, action, targetPath, userIdHint) {
    let userId = userIdHint || null;
    if (!userId) { const ctx = await auth.authenticate(req).catch(() => null); if (ctx) userId = ctx.user.id; }
    await db.query(
      'INSERT INTO audit_log (user_id, action, target_path, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      [userId, action, targetPath || null, clientIp(req), (req.headers['user-agent'] || '').slice(0, 255) || null]
    ).catch(() => {});
  }

  // Dispatch. Returns true if it handled the request (path was under /_api/).
  // Match method+path first; only fall back to 405 when the path exists under a
  // different method (so GET/POST on the same path don't shadow each other), then
  // 404 for an unknown path.
  return async function handleApi(req, res, url) {
    const pathname = url.pathname;
    let pathMatched = false;
    for (const [method, re, fn] of routes) {
      const m = re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (req.method === method) { await fn(req, res, { url, params: m.slice(1) }); return true; }
    }
    sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method_not_allowed' : 'not_found' });
    return true;
  };
}

// ── small helpers ─────────────────────────────────────────────────────────────
function httpErr(statusCode, error, message) { const e = new Error(message || error); e.statusCode = statusCode; e.error = error; return e; }
function requireFields(body, fields) {
  for (const f of fields) if (body[f] == null || body[f] === '') throw httpErr(400, 'missing_field', `Missing field: ${f}`);
}
function publicUser(u) { return { id: u.id, email: u.email, username: u.username, display_name: u.display_name, status: u.status, mfa_enabled: !!u.mfa_enabled, created_at: u.created_at }; }
function reqMeta(req) { return { ip: clientIp(req), userAgent: req.headers['user-agent'] || '' }; }
function shareUrl(req, token) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['host'] || 'localhost';
  return `${proto}://${host}/_s/${token}`;
}
function clampInt(v, def, lo, hi) { const n = parseInt(v, 10); if (Number.isNaN(n)) return def; return Math.min(hi, Math.max(lo, n)); }

module.exports = { createApiHandler };
