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
 *   GET  /_api/jobs            (admin) ?state=&type=&limit=&offset=       → {jobs,total,summary,worker}
 *   POST /_api/jobs            (admin) {type,payload?}                    → 202 {job}
 *   GET  /_api/jobs/:id        (admin)                                    → {job}
 *   POST /_api/jobs/:id/cancel (admin)                                    → {ok}
 *   POST /_api/jobs/:id/retry  (admin)                                    → {ok,job}
 *   GET  /_api/videos          (token|user)  ?folder=&recursive=&q=&sort= → {videos,total,limit,offset}
 *   GET  /_api/videos/folders  (token|user)                               → {folders,total}
 *   POST /_api/videos/scan     (token|admin) {folder?}                    → 202 {queued,job}
 *   GET  /_api/videos/scan     (token|user)                               → {job,videos,bytes,lastCompletedAt}
 *
 * The register route allows the FIRST account unconditionally (bootstrap admin);
 * further self-registration needs config.allowRegistration, else an admin creates
 * accounts via POST /_api/users.
 */

const crypto = require('crypto');
const { sendJson, readJson, clientIp, wantSecureCookie, streamFile } = require('../http');
const { hasRole, hashPassword, mysqlDate, totp } = require('../auth');
const { createAssetRoutes } = require('./assets');
const { createVideoRoutes } = require('./videos');
const { buildFileFilter } = require('./filequery');

// Short enough not to be theatre, long enough to matter. Deliberately not a
// composition rule (uppercase + digit + symbol), which pushes people toward
// "Password1!" and away from length.
const MIN_PASSWORD_LENGTH = 8;

// Job types an admin may queue from the API. Deliberately a whitelist: the queue is
// an execution surface, and "run any registered type with any payload" is not a
// thing an HTTP endpoint should offer.
const QUEUEABLE_JOBS = new Set(['scan', 'extract', 'sweep', 'enrich', 'enrich_batch']);

function createApiHandler({ config, db, auth, trash, storage, jobs = null, versions = null, index = null, masterops = null, cache = null, renditions = null, ai = null, aiStore = null }) {
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
  const requireEditor = async (req) => {
    const ctx = await requireAuth(req);
    if (!hasRole(ctx, 'editor')) throw httpErr(403, 'forbidden', 'Editor role required');
    return ctx;
  };

  // ── route table: [method, /regex/ with named-ish groups, handler] ──────────
  const routes = [
    ['POST', /^\/_api\/auth\/register$/, guarded(register)],
    ['POST', /^\/_api\/auth\/login$/, guarded(login)],
    ['POST', /^\/_api\/auth\/logout$/, guarded(logout)],
    ['GET', /^\/_api\/auth\/me$/, guarded(me)],
    ['POST', /^\/_api\/auth\/password$/, guarded(changePassword)],
    ['POST', /^\/_api\/auth\/mfa\/setup$/, guarded(mfaSetup)],
    ['POST', /^\/_api\/auth\/mfa\/enable$/, guarded(mfaEnable)],
    ['POST', /^\/_api\/auth\/mfa\/disable$/, guarded(mfaDisable)],
    ['POST', /^\/_api\/auth\/mfa\/recovery$/, guarded(mfaRegenerateRecovery)],
    ['GET', /^\/_api\/tokens$/, guarded(listTokens)],
    ['POST', /^\/_api\/tokens$/, guarded(createToken)],
    ['DELETE', /^\/_api\/tokens\/(\d+)$/, guarded(deleteToken)],
    ['GET', /^\/_api\/users$/, guarded(listUsers)],
    ['POST', /^\/_api\/users$/, guarded(createUser)],
    ['DELETE', /^\/_api\/users\/(\d+)$/, guarded(deleteUser)],
    ['POST', /^\/_api\/users\/(\d+)\/status$/, guarded(setUserStatus)],
    ['POST', /^\/_api\/users\/(\d+)\/password$/, guarded(adminResetPassword)],
    ['POST', /^\/_api\/users\/(\d+)\/mfa\/reset$/, guarded(adminResetMfa)],
    ['POST', /^\/_api\/users\/(\d+)\/roles$/, guarded(addRole)],
    ['DELETE', /^\/_api\/users\/(\d+)\/roles\/([a-z]+)$/, guarded(removeRole)],
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
    ['GET', /^\/_api\/jobs$/, guarded(listJobs)],
    ['POST', /^\/_api\/jobs$/, guarded(createJob)],
    ['GET', /^\/_api\/jobs\/(\d+)$/, guarded(getJob)],
    ['POST', /^\/_api\/jobs\/(\d+)\/cancel$/, guarded(cancelJob)],
    ['POST', /^\/_api\/jobs\/(\d+)\/retry$/, guarded(retryJob)],
    // Asset-management routes live in their own module for size; same namespace,
    // same guards, same dispatcher. Appended AFTER the routes above so a specific
    // path like /_api/files/tags is never shadowed by a broader pattern.
    ...createAssetRoutes({
      config, db, storage, jobs, versions, index, masterops, ai, aiStore,
      guarded, requireAuth, requireAdmin, requireEditor, audit, httpErr, requireFields, clampInt,
      sendJson, readJson, streamFile,
      isAdmin: (ctx) => hasRole(ctx, 'admin'),
      purgeCache: (rel) => (cache ? cache.purgeForPath(rel) : Promise.resolve()),
      // An edited rendition must take effect now, not when its 30s cache expires.
      invalidateRenditions: () => renditions && renditions.invalidate(),
    }),
    // Video control surface. Same namespace and dispatcher, but its OWN auth rule:
    // these are called by the ERP, a machine that holds the upload token and no user
    // account (see handlers/videos.js). `auth` is handed over whole because the
    // module decides per route whether a token or a user is enough.
    ...createVideoRoutes({
      config, db, jobs, auth,
      guarded, httpErr, clampInt, sendJson, readJson, audit,
      isAdmin: (c) => hasRole(c, 'admin'),
    }),
  ];

  async function register(req, res) {
    const body = await readJson(req);
    requireFields(body, ['email', 'username', 'password']);
    const first = (await auth.countUsers()) === 0;
    if (!first && !config.allowRegistration) throw httpErr(403, 'registration_closed', 'Self-registration is disabled');
    if (await auth.findUser(body.email) || await auth.findUser(body.username)) {
      throw httpErr(409, 'exists', 'Email or username already in use');
    }
    checkPasswordStrength(body.password);
    const user = await auth.createUser(body);
    const session = await auth.issueSession(user, reqMeta(req));
    await audit(req, 'register', null, user.id);
    return sendJson(res, 201, { user: publicUser(user), token: session.token, roles: await auth.rolesOf(user.id) },
      { 'Set-Cookie': sessionCookie(req, session.token) });
  }

  // The session cookie. `Secure` is decided per request (SECURE_COOKIES) rather than
  // hardcoded: a cookie without it travels in the clear on a non-TLS deployment, and
  // hardcoding it on would break every plain-HTTP dev server.
  function sessionCookie(req, token) {
    const secure = wantSecureCookie(req, config.secureCookies) ? '; Secure' : '';
    return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionTtlDays * 86400}${secure}`;
  }

  async function login(req, res) {
    const body = await readJson(req);
    requireFields(body, ['login', 'password']);
    const ip = clientIp(req);

    // Throttling comes FIRST, before any password work: an unthrottled login is an
    // open invitation to grind, and scrypt makes each guess expensive for us too.
    const lock = await auth.loginLockout(body.login, ip);
    if (lock) {
      await audit(req, 'login_locked', body.login);
      const e = httpErr(429, 'too_many_attempts',
        `Too many failed attempts (${lock.scope}). Try again in ${Math.ceil(lock.retryAfterSeconds / 60)} minute(s).`);
      res.setHeader('Retry-After', String(lock.retryAfterSeconds));
      throw e;
    }

    const session = await auth.login(body.login, body.password, { ...reqMeta(req), mfaCode: body.mfa_code || body.code });
    if (!session) {
      await auth.recordLoginAttempt(body.login, ip, false);
      await audit(req, 'login_failed', body.login);
      throw httpErr(401, 'bad_credentials', 'Invalid login or password');
    }
    // Password was right but a second factor is owed. Deliberately NOT counted as a
    // failed attempt — the credential held, and locking someone out for fumbling a
    // 30-second code is a denial of service against your own users.
    if (session.mfaRequired) {
      await audit(req, 'login_mfa_required', null, session.user.id);
      throw httpErr(401, 'mfa_required', 'A multi-factor code is required');
    }

    await auth.recordLoginAttempt(body.login, ip, true);
    await auth.clearLoginFailures(body.login, ip);
    await audit(req, 'login', null, session.user.id);
    const roles = await auth.rolesOf(session.user.id);
    return sendJson(res, 200, { user: publicUser(session.user), token: session.token, roles },
      { 'Set-Cookie': sessionCookie(req, session.token) });
  }

  // ── Self-service password & MFA ────────────────────────────────────────────
  async function changePassword(req, res) {
    const ctx = await requireAuth(req);
    const body = await readJson(req);
    requireFields(body, ['old_password', 'new_password']);
    const { verifyPassword } = require('../auth');
    if (!(await verifyPassword(String(body.old_password), ctx.user.password_hash))) {
      throw httpErr(403, 'bad_password', 'Current password is incorrect');
    }
    checkPasswordStrength(body.new_password);
    await auth.setPassword(ctx.user.id, String(body.new_password));
    // Every OTHER session dies: a password change is usually a response to
    // "someone may have my credentials", and leaving their sessions live defeats it.
    const { bearerFrom } = require('../auth');
    await auth.revokeSessions(ctx.user.id, { keepToken: bearerFrom(req) });
    await audit(req, 'password_change', null, ctx.user.id);
    return sendJson(res, 200, { ok: true, otherSessionsRevoked: true });
  }

  function requireMfaFeature() {
    if (!config.mfaEnabled) throw httpErr(503, 'mfa_disabled', 'Multi-factor authentication is not enabled on this server');
  }

  // Step 1 of enrolment: mint a secret and hand back the otpauth:// URI to scan.
  // Nothing is turned on yet — the secret is stored but `mfa_enabled` stays 0 until
  // a working code proves the authenticator was actually set up.
  async function mfaSetup(req, res) {
    requireMfaFeature();
    const ctx = await requireAuth(req);
    const secret = totp.generateSecret();
    await db.query('UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ?', [secret, ctx.user.id]);
    return sendJson(res, 200, {
      secret,
      otpauth_url: totp.otpauthUrl({ secret, account: ctx.user.email || ctx.user.username, issuer: config.mfaIssuer }),
      issuer: config.mfaIssuer,
    });
  }

  // Step 2: a correct code enables MFA and issues the recovery codes — shown once.
  async function mfaEnable(req, res) {
    requireMfaFeature();
    const ctx = await requireAuth(req);
    const body = await readJson(req);
    requireFields(body, ['code']);
    const fresh = await auth.findUser(ctx.user.id);
    if (!fresh || !fresh.mfa_secret) throw httpErr(409, 'no_pending_setup', 'Start with POST /_api/auth/mfa/setup');
    if (!totp.verify(fresh.mfa_secret, String(body.code))) throw httpErr(400, 'bad_code', 'That code is not valid');
    await db.query('UPDATE users SET mfa_enabled = 1 WHERE id = ?', [ctx.user.id]);
    const recovery = await auth.resetRecoveryCodes(ctx.user.id);
    await audit(req, 'mfa_enable', null, ctx.user.id);
    return sendJson(res, 200, { ok: true, recovery_codes: recovery, note: 'Store these now — they are not shown again.' });
  }

  async function mfaDisable(req, res) {
    requireMfaFeature();
    const ctx = await requireAuth(req);
    const body = await readJson(req);
    requireFields(body, ['password']);
    const { verifyPassword } = require('../auth');
    if (!(await verifyPassword(String(body.password), ctx.user.password_hash))) throw httpErr(403, 'bad_password', 'Password is incorrect');
    await auth.disableMfa(ctx.user.id);
    await audit(req, 'mfa_disable', null, ctx.user.id);
    return sendJson(res, 200, { ok: true });
  }

  async function mfaRegenerateRecovery(req, res) {
    requireMfaFeature();
    const ctx = await requireAuth(req);
    const body = await readJson(req);
    requireFields(body, ['password']);
    const { verifyPassword } = require('../auth');
    if (!(await verifyPassword(String(body.password), ctx.user.password_hash))) throw httpErr(403, 'bad_password', 'Password is incorrect');
    const fresh = await auth.findUser(ctx.user.id);
    if (!fresh || !fresh.mfa_enabled) throw httpErr(409, 'mfa_not_enabled', 'MFA is not enabled for this account');
    const recovery = await auth.resetRecoveryCodes(ctx.user.id);
    await audit(req, 'mfa_recovery_reset', null, ctx.user.id);
    return sendJson(res, 200, { recovery_codes: recovery });
  }

  // ── API tokens ─────────────────────────────────────────────────────────────
  async function listTokens(req, res) {
    const ctx = await requireAuth(req);
    const rows = await auth.listApiTokens(ctx.user.id);
    return sendJson(res, 200, { tokens: rows.map((r) => ({ ...r, expired: !!r.expired })) });
  }

  async function createToken(req, res) {
    const ctx = await requireAuth(req);
    const body = await readJson(req);
    requireFields(body, ['name']);
    const t = await auth.createApiToken(ctx.user.id, {
      name: String(body.name), expiresInDays: body.expires_in_days, scopes: body.scopes || null,
    });
    await audit(req, 'token_create', null, ctx.user.id);
    // The plaintext appears here and never again — same discipline as a session token.
    return sendJson(res, 201, {
      token: t.token,
      api_token: { id: t.id, name: t.name, expires_at: t.expires_at, scopes: t.scopes },
      note: 'Copy this token now — it is not stored in plaintext and cannot be shown again.',
    });
  }

  async function deleteToken(req, res, { params }) {
    const ctx = await requireAuth(req);
    const ok = await auth.deleteApiToken(ctx.user.id, Number(params[0]), { any: hasRole(ctx, 'admin') });
    if (!ok) throw httpErr(404, 'not_found', 'Token not found');
    await audit(req, 'token_delete', null, ctx.user.id);
    return sendJson(res, 200, { ok: true });
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
      mfa: {
        available: !!config.mfaEnabled,
        enabled: !!ctx.user.mfa_enabled,
        recoveryCodesRemaining: ctx.user.mfa_enabled ? await auth.countRecoveryCodes(ctx.user.id) : 0,
      },
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
    checkPasswordStrength(body.password);
    if (await auth.findUser(body.email) || await auth.findUser(body.username)) throw httpErr(409, 'exists', 'Email or username already in use');
    const user = await auth.createUser(body);
    if (body.storage_quota_bytes != null && body.storage_quota_bytes !== '') {
      await db.query('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [Number(body.storage_quota_bytes) || null, user.id]);
    }
    await audit(req, 'user_create', null, user.id);
    return sendJson(res, 201, { user: publicUser(user), roles: await auth.rolesOf(user.id) });
  }

  async function addRole(req, res, { params }) {
    const ctx = await requireAdmin(req);
    const body = await readJson(req);
    requireFields(body, ['role']);
    const ok = await auth.assignRole(Number(params[0]), body.role);
    if (!ok) throw httpErr(400, 'bad_role', 'Unknown role');
    await audit(req, 'role_grant', null, ctx.user.id);
    return sendJson(res, 200, { ok: true });
  }

  /**
   * Revoke a role. The route table could grant roles and never take one back, so a
   * mis-click promoting someone to admin was permanent.
   *
   * Guarded against removing the last admin — an installation with no admin cannot
   * create one, and the only way back is direct SQL.
   */
  async function removeRole(req, res, { params }) {
    const ctx = await requireAdmin(req);
    const userId = Number(params[0]);
    const role = String(params[1]);
    if (role === 'admin') await assertNotLastAdmin(userId, 'revoke the admin role from');
    const ok = await auth.revokeRole(userId, role);
    if (!ok) throw httpErr(404, 'not_found', 'User does not have that role');
    // A revoked role must stop applying now, not whenever the token happens to expire.
    await auth.revokeSessions(userId);
    await audit(req, 'role_revoke', null, ctx.user.id);
    return sendJson(res, 200, { ok: true, sessionsRevoked: true });
  }

  // Refuse an operation that would leave the system with no active admin.
  async function assertNotLastAdmin(userId, what) {
    const target = await auth.findUser(userId);
    if (!target) throw httpErr(404, 'not_found', 'User not found');
    const roles = await auth.rolesOf(userId);
    if (!roles.includes('admin')) return;
    const others = await auth.countAdmins({ excludeUserId: userId });
    if (others === 0) throw httpErr(409, 'last_admin', `Refusing to ${what} the last remaining admin`);
  }

  async function setUserStatus(req, res, { params }) {
    const ctx = await requireAdmin(req);
    const body = await readJson(req);
    requireFields(body, ['status']);
    const userId = Number(params[0]);
    const status = String(body.status);
    if (!['active', 'disabled'].includes(status)) throw httpErr(400, 'bad_status', 'status must be active or disabled');
    if (status === 'disabled') {
      if (userId === ctx.user.id) throw httpErr(409, 'self_disable', 'Refusing to disable your own account');
      await assertNotLastAdmin(userId, 'disable');
    }
    if (!(await auth.findUser(userId))) throw httpErr(404, 'not_found', 'User not found');
    await auth.setStatus(userId, status);
    await audit(req, status === 'disabled' ? 'user_disable' : 'user_enable', null, ctx.user.id);
    return sendJson(res, 200, { ok: true, status });
  }

  /**
   * Delete a user.
   *
   * What happens to the files they own is a real decision, not a detail: the rows
   * carry tags, shares and quota accounting. `?files=orphan` (the default) clears the
   * owner and keeps everything; `?files=reassign&to=<id>` transfers ownership, which
   * also transfers the bytes against the new owner's quota. The masters themselves
   * are never touched either way — deleting an account is not a way to delete data.
   */
  async function deleteUser(req, res, { params, url }) {
    const ctx = await requireAdmin(req);
    const userId = Number(params[0]);
    if (userId === ctx.user.id) throw httpErr(409, 'self_delete', 'Refusing to delete your own account');
    await assertNotLastAdmin(userId, 'delete');
    const target = await auth.findUser(userId);
    if (!target) throw httpErr(404, 'not_found', 'User not found');

    const mode = (url.searchParams.get('files') || 'orphan').toLowerCase();
    if (mode === 'reassign') {
      const to = Number(url.searchParams.get('to'));
      if (!to || !(await auth.findUser(to))) throw httpErr(400, 'bad_reassign', 'files=reassign needs a valid ?to=<userId>');
      await db.query('UPDATE files SET owner_user_id = ? WHERE owner_user_id = ?', [to, userId]);
    } else if (mode === 'orphan') {
      await db.query('UPDATE files SET owner_user_id = NULL WHERE owner_user_id = ?', [userId]);
    } else {
      throw httpErr(400, 'bad_files_mode', 'files must be orphan or reassign');
    }
    // Sessions, tokens, roles and recovery codes go with the row (ON DELETE CASCADE);
    // audit entries keep their user_id so the trail stays readable.
    await db.query('DELETE FROM users WHERE id = ?', [userId]);
    await audit(req, 'user_delete', null, ctx.user.id);
    return sendJson(res, 200, { ok: true, files: mode });
  }

  async function adminResetPassword(req, res, { params }) {
    const ctx = await requireAdmin(req);
    const body = await readJson(req);
    requireFields(body, ['new_password']);
    checkPasswordStrength(body.new_password);
    const userId = Number(params[0]);
    if (!(await auth.findUser(userId))) throw httpErr(404, 'not_found', 'User not found');
    await auth.setPassword(userId, String(body.new_password));
    await auth.revokeSessions(userId);
    await audit(req, 'password_reset', null, ctx.user.id);
    return sendJson(res, 200, { ok: true, sessionsRevoked: true });
  }

  // The way back in for a user who lost their authenticator AND their recovery codes.
  async function adminResetMfa(req, res, { params }) {
    const ctx = await requireAdmin(req);
    const userId = Number(params[0]);
    if (!(await auth.findUser(userId))) throw httpErr(404, 'not_found', 'User not found');
    await auth.disableMfa(userId);
    await audit(req, 'mfa_admin_reset', null, ctx.user.id);
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
    // Shared with the bulk job (handlers/filequery.js) so the set you preview is
    // exactly the set a bulk action touches.
    const { clause, args } = buildFileFilter((k) => q.get(k));
    const limit = clampInt(q.get('limit'), 50, 1, 500);
    const offset = clampInt(q.get('offset'), 0, 0, 1e9);
    const totalRow = await db.one(`SELECT COUNT(*) AS n FROM files ${clause}`, args);
    // `id DESC` is not decoration: DATETIME has second granularity, so a bulk upload
    // gives dozens of rows the same `updated_at` and MySQL is free to order them
    // differently per query — which makes offset pages silently repeat and skip rows.
    const rows = await db.query(
      `SELECT id, path, name, ext, mime, size_bytes, volume_id, width, height, visibility, status, created_at, updated_at
       FROM files ${clause} ORDER BY updated_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, args);
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
    // Retained versions live outside the trash, so purging the master has to take
    // them too — otherwise "permanently delete" leaves copies on disk.
    if (versions) await versions.purgeAll(rel).catch(() => {});
    await trash.purge(rel);
    await audit(req, 'purge', rel, ctx.user.id);
    return sendJson(res, 200, { ok: true });
  }

  async function emptyTrash(req, res) {
    const ctx = await requireAdmin(req);
    if (versions) {
      const rows = await db.query("SELECT path FROM files WHERE status='trashed'").catch(() => []);
      for (const r of rows) await versions.purgeAll(r.path).catch(() => {});
    }
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

  // ── Background jobs ────────────────────────────────────────────────────────
  function requireJobs() {
    if (!jobs || !jobs.enabled) throw httpErr(503, 'jobs_disabled', 'The job queue is not available');
    return jobs;
  }

  async function listJobs(req, res, { url }) {
    await requireAdmin(req);
    const q = url.searchParams;
    const r = await requireJobs().list({
      state: q.get('state') || null,
      type: q.get('type') || null,
      limit: clampInt(q.get('limit'), 50, 1, 500),
      offset: clampInt(q.get('offset'), 0, 0, 1e9),
    });
    return sendJson(res, 200, {
      ...r,
      summary: await jobs.summary(),
      worker: { running: jobs.workerRunning, id: jobs.workerId, concurrency: jobs.concurrency, types: jobs.types() },
    });
  }

  async function createJob(req, res) {
    const ctx = await requireAdmin(req);
    const body = await readJson(req);
    requireFields(body, ['type']);
    const type = String(body.type);
    if (!QUEUEABLE_JOBS.has(type)) throw httpErr(400, 'bad_type', `Not queueable via the API: ${type}`);
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    // One live scan at a time; extraction dedupes per path. A manually-triggered
    // sweep gets no dedupe key so it never collides with the self-scheduled one.
    const dedupeKey = type === 'scan'
      ? `scan:${payload.volumeId || 'all'}`
      : (type === 'extract' || type === 'enrich') && payload.path
        ? `${type}:${require('../util').pathKey(String(payload.path).replace(/^\/+/, ''))}`
        : null;
    const id = await requireJobs().enqueue(type, payload, { dedupeKey, priority: 4, createdBy: ctx.user.id });
    if (!id) throw httpErr(500, 'enqueue_failed', 'Could not queue the job');
    await audit(req, 'job_create', payload.path || null, ctx.user.id);
    return sendJson(res, 202, { job: await jobs.get(id) });
  }

  async function getJob(req, res, { params }) {
    await requireAdmin(req);
    const job = await requireJobs().get(Number(params[0]));
    if (!job) throw httpErr(404, 'not_found', 'Job not found');
    return sendJson(res, 200, { job });
  }

  async function cancelJob(req, res, { params }) {
    const ctx = await requireAdmin(req);
    const ok = await requireJobs().cancel(Number(params[0]));
    if (!ok) throw httpErr(409, 'not_cancellable', 'Job is not queued or running');
    await audit(req, 'job_cancel', null, ctx.user.id);
    return sendJson(res, 200, { ok: true });
  }

  async function retryJob(req, res, { params }) {
    const ctx = await requireAdmin(req);
    const ok = await requireJobs().retry(Number(params[0]));
    if (!ok) throw httpErr(409, 'not_retryable', 'Job has not finished');
    await audit(req, 'job_retry', null, ctx.user.id);
    return sendJson(res, 200, { ok: true, job: await jobs.get(Number(params[0])) });
  }

  async function stats(req, res) {
    await requireAdmin(req);
    const files = await db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM files WHERE status='active'`);
    const trashed = await db.one(`SELECT COUNT(*) AS n FROM files WHERE status='trashed'`);
    const missing = await db.one(`SELECT COUNT(*) AS n FROM files WHERE status='missing'`);
    const users = await db.one(`SELECT COUNT(*) AS n FROM users`);
    return sendJson(res, 200, {
      files: Number(files.n), storageBytes: Number(files.bytes), trashed: Number(trashed.n),
      missing: Number(missing.n), users: Number(users.n),
      jobs: jobs && jobs.enabled ? await jobs.summary() : null,
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
function checkPasswordStrength(pw) {
  if (String(pw).length < MIN_PASSWORD_LENGTH) {
    throw httpErr(400, 'weak_password', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}
function reqMeta(req) { return { ip: clientIp(req), userAgent: req.headers['user-agent'] || '' }; }
function shareUrl(req, token) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['host'] || 'localhost';
  return `${proto}://${host}/_s/${token}`;
}
function clampInt(v, def, lo, hi) { const n = parseInt(v, 10); if (Number.isNaN(n)) return def; return Math.min(hi, Math.max(lo, n)); }

module.exports = { createApiHandler };
