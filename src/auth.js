'use strict';

/**
 * Identity, sessions and RBAC on top of the optional DB layer (db.js).
 *
 * Passwords are hashed with scrypt (built-in `crypto`, no native dep) in a
 * self-describing `scrypt$N$r$p$salt$hash` string, verified in constant time.
 * Login issues an opaque 32-byte bearer token; only its sha256 is stored in
 * `sessions`, so a DB leak yields no usable tokens. Long-lived integration tokens
 * (`api_tokens`) work the same way.
 *
 * `authenticate(req)` resolves the caller from `Authorization: Bearer <token>`
 * (or the `sid` cookie) to a context `{ user, roles, via }`, or null when
 * anonymous. RBAC is role-name based: `admin` implies everything; `editor` can
 * write; `viewer` can read. Everything is gated on `db.enabled`, so with no DB the
 * whole module simply reports "anonymous / not enabled".
 */

const crypto = require('crypto');
const { promisify } = require('util');
const totp = require('./totp');
const scrypt = promisify(crypto.scrypt);

const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const dk = await scrypt(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch { return false; }
}

// Opaque token given to the client; its sha256 is what we persist/look up.
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

function createAuth({ db, config }) {
  const auth = {
    // ── Accounts ─────────────────────────────────────────────────────────────
    async countUsers() {
      const row = await db.one('SELECT COUNT(*) AS n FROM users');
      return row ? Number(row.n) : 0;
    },

    async findUser(idOrLogin) {
      if (typeof idOrLogin === 'number' || /^\d+$/.test(idOrLogin)) {
        return db.one('SELECT * FROM users WHERE id = ?', [Number(idOrLogin)]);
      }
      return db.one('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1', [idOrLogin, idOrLogin]);
    },

    async rolesOf(userId) {
      const rows = await db.query(
        'SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?', [userId]);
      return rows.map((x) => x.name);
    },

    // Create an account. The very first account created becomes `admin` (bootstrap);
    // otherwise it gets the requested role (default `editor`). Returns the new user.
    async createUser({ email, username, password, display_name, role }) {
      const first = (await auth.countUsers()) === 0;
      const hash = await hashPassword(password);
      const res = await db.query(
        'INSERT INTO users (email, username, display_name, password_hash) VALUES (?, ?, ?, ?)',
        [email, username, display_name || username, hash]);
      const userId = res.insertId;
      const roleName = first ? 'admin' : (role || 'editor');
      await auth.assignRole(userId, roleName);
      return auth.findUser(userId);
    },

    async assignRole(userId, roleName) {
      const role = await db.one('SELECT id FROM roles WHERE name = ?', [roleName]);
      if (!role) return false;
      await db.query('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, role.id]);
      return true;
    },

    // ── Login throttling ───────────────────────────────────────────────────────
    /**
     * Is this login attempt locked out? Counted two ways, because they defend
     * against different attacks: per-ACCOUNT stops someone grinding one password
     * list against one user, per-IP stops the same client spraying many accounts.
     * Returns `{ retryAfterSeconds, scope }` when locked, else null.
     */
    async loginLockout(login, ip) {
      const max = config.loginMaxFailures;
      if (!max || max <= 0) return null;
      const windowMin = config.loginWindowMinutes;
      const lockMin = config.loginLockoutMinutes;
      const check = async (column, value, threshold) => {
        if (!value) return null;
        const row = await db.one(
          `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM login_attempts
            WHERE ${column} = ? AND ok = 0 AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
          [value, windowMin]).catch(() => null);
        if (!row || Number(row.n) < threshold) return null;
        // The lock runs from the LAST failure, so hammering it keeps it shut.
        const until = new Date(new Date(row.last).getTime() + lockMin * 60_000);
        const retry = Math.ceil((until.getTime() - Date.now()) / 1000);
        return retry > 0 ? retry : null;
      };
      const byLogin = await check('login', login, max);
      if (byLogin) return { retryAfterSeconds: byLogin, scope: 'account' };
      const byIp = await check('ip', ip, config.loginMaxFailuresIp || max * 5);
      if (byIp) return { retryAfterSeconds: byIp, scope: 'ip' };
      return null;
    },

    async recordLoginAttempt(login, ip, ok) {
      await db.query('INSERT INTO login_attempts (login, ip, ok) VALUES (?, ?, ?)',
        [String(login || '').slice(0, 255) || null, ip || null, ok ? 1 : 0]).catch(() => {});
    },

    // Clear an account's failures after a success, so one bad night doesn't linger.
    async clearLoginFailures(login, ip) {
      await db.query('DELETE FROM login_attempts WHERE (login = ? OR ip = ?) AND ok = 0', [login, ip]).catch(() => {});
    },

    // ── Login / sessions ───────────────────────────────────────────────────────
    /**
     * Verify credentials and issue a session.
     *
     * Returns the session on success, or a REASON on failure — `{ mfaRequired }`
     * when the password was right but a second factor is owed, and null when the
     * credentials simply do not check out. The caller decides what to tell the user;
     * this never distinguishes "no such account" from "wrong password".
     */
    async login(login, password, meta = {}) {
      const user = await auth.findUser(login);
      if (!user || user.status !== 'active') return null;
      if (!(await verifyPassword(password, user.password_hash))) return null;
      if (user.mfa_enabled && user.mfa_secret) {
        const okMfa = await auth.verifySecondFactor(user, meta.mfaCode);
        if (!okMfa) return { mfaRequired: true, user };
      }
      return auth.issueSession(user, meta);
    },

    async issueSession(user, meta = {}) {
      const token = newToken();
      const expires = new Date(Date.now() + config.sessionTtlDays * 86400_000);
      await db.query(
        'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
        [tokenHash(token), user.id, mysqlDate(expires), meta.ip || null, (meta.userAgent || '').slice(0, 255) || null]);
      return { token, expires, user };
    },

    async logout(token) {
      if (!token) return;
      await db.query('DELETE FROM sessions WHERE id = ?', [tokenHash(token)]);
    },

    // Drop every session for a user — what a password change, a disable, or a role
    // revocation has to do to actually take effect on already-signed-in clients.
    async revokeSessions(userId, { keepToken = null } = {}) {
      if (keepToken) {
        await db.query('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, tokenHash(keepToken)]);
      } else {
        await db.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
      }
    },

    // ── Passwords ──────────────────────────────────────────────────────────────
    async setPassword(userId, newPassword) {
      const hash = await hashPassword(newPassword);
      await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
    },

    // ── Second factor (TOTP) ───────────────────────────────────────────────────
    /**
     * Check a TOTP code, or spend a one-time recovery code. Recovery codes are
     * matched by hash and marked used in the same conditional UPDATE, so a code can
     * never be redeemed twice even under concurrent attempts.
     */
    async verifySecondFactor(user, code) {
      if (!code) return false;
      if (totp.verify(user.mfa_secret, code)) return true;
      const res = await db.query(
        'UPDATE mfa_recovery_codes SET used_at = NOW() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
        [user.id, totp.hashRecovery(code)]).catch(() => null);
      return !!(res && res.affectedRows);
    },

    // Replace a user's recovery codes, returning the plaintext for the ONE time it
    // can ever be shown.
    async resetRecoveryCodes(userId) {
      const codes = totp.generateRecoveryCodes();
      await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [userId]);
      for (const c of codes) {
        await db.query('INSERT IGNORE INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)', [userId, totp.hashRecovery(c)]);
      }
      return codes;
    },

    async countRecoveryCodes(userId) {
      const row = await db.one('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
      return row ? Number(row.n) : 0;
    },

    async disableMfa(userId) {
      await db.query('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?', [userId]);
      await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [userId]);
    },

    // ── Account lifecycle ──────────────────────────────────────────────────────
    async revokeRole(userId, roleName) {
      const role = await db.one('SELECT id FROM roles WHERE name = ?', [roleName]);
      if (!role) return false;
      const res = await db.query('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [userId, role.id]);
      return !!(res && res.affectedRows);
    },

    // How many ACTIVE admins exist — the guard against locking everyone out by
    // disabling, deleting or demoting the last one.
    async countAdmins({ excludeUserId = null } = {}) {
      const row = await db.one(
        `SELECT COUNT(DISTINCT u.id) AS n
           FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
          WHERE r.name = 'admin' AND u.status = 'active' ${excludeUserId ? 'AND u.id <> ?' : ''}`,
        excludeUserId ? [excludeUserId] : []);
      return row ? Number(row.n) : 0;
    },

    async setStatus(userId, status) {
      const s = status === 'disabled' ? 'disabled' : 'active';
      await db.query('UPDATE users SET status = ? WHERE id = ?', [s, userId]);
      // A disabled account must stop working immediately, not at token expiry.
      if (s === 'disabled') await auth.revokeSessions(userId);
      return s;
    },

    // Resolve a bearer/session/api token to a live user, or null.
    async resolveToken(token) {
      if (!token) return null;
      const h = tokenHash(token);
      const session = await db.one(
        'SELECT s.user_id, s.expires_at FROM sessions s WHERE s.id = ? LIMIT 1', [h]);
      let userId = null;
      if (session) {
        if (new Date(session.expires_at).getTime() < Date.now()) {
          await db.query('DELETE FROM sessions WHERE id = ?', [h]).catch(() => {});
          return null;
        }
        userId = session.user_id;
        db.query('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [h]).catch(() => {});
      } else {
        const apiTok = await db.one(
          'SELECT user_id, expires_at FROM api_tokens WHERE token_hash = ? LIMIT 1', [h]);
        if (!apiTok) return null;
        if (apiTok.expires_at && new Date(apiTok.expires_at).getTime() < Date.now()) return null;
        userId = apiTok.user_id;
        db.query('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?', [h]).catch(() => {});
      }
      const user = await auth.findUser(Number(userId));
      if (!user || user.status !== 'active') return null;
      const roles = await auth.rolesOf(user.id);
      return { user, roles };
    },

    // Authenticate an incoming request from its Authorization header or `sid` cookie.
    async authenticate(req) {
      if (!db.enabled) return null;
      const token = bearerFrom(req);
      if (!token) return null;
      const ctx = await auth.resolveToken(token);
      if (ctx) ctx.via = 'token';
      return ctx;
    },

    // Verify a login/password pair without issuing a session (used by WebDAV Basic
    // auth). Returns { user, roles } or null.
    //
    // An MFA-enrolled account cannot authenticate this way — Basic auth has nowhere
    // to put a second factor. Such users reach WebDAV with an API token as the
    // password instead (see resolveToken / POST /_api/tokens).
    async verifyCredentials(login, password) {
      if (!db.enabled) return null;
      const user = await auth.findUser(login);
      if (!user || user.status !== 'active') return null;
      // Try an API token first: it is the supported credential for MFA accounts and
      // for scripts, and it never grants more than the user itself has.
      const viaToken = await auth.resolveToken(password).catch(() => null);
      if (viaToken && viaToken.user.id === user.id) return viaToken;
      if (user.mfa_enabled) return null;
      if (!(await verifyPassword(password, user.password_hash))) return null;
      return { user, roles: await auth.rolesOf(user.id) };
    },

    // ── API tokens ─────────────────────────────────────────────────────────────
    /**
     * Mint a long-lived integration token. The plaintext is returned here and
     * NOWHERE else — only its sha256 is stored, exactly like a session token, so a
     * database leak yields nothing replayable.
     */
    async createApiToken(userId, { name, expiresInDays = null, scopes = null } = {}) {
      const token = newToken();
      const expires = expiresInDays && Number(expiresInDays) > 0
        ? mysqlDate(new Date(Date.now() + Number(expiresInDays) * 86400_000)) : null;
      const res = await db.query(
        'INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?)',
        [userId, String(name).slice(0, 120), tokenHash(token), scopes || null, expires]);
      return { id: Number(res.insertId), token, name, expires_at: expires, scopes: scopes || null };
    },

    async listApiTokens(userId) {
      return db.query(
        `SELECT id, name, scopes, created_at, last_used_at, expires_at,
                (expires_at IS NOT NULL AND expires_at < NOW()) AS expired
           FROM api_tokens WHERE user_id = ? ORDER BY id DESC`, [userId]);
    },

    async deleteApiToken(userId, id, { any = false } = {}) {
      const res = any
        ? await db.query('DELETE FROM api_tokens WHERE id = ?', [id])
        : await db.query('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [id, userId]);
      return !!(res && res.affectedRows);
    },
  };
  return auth;
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Extract a bearer token from `Authorization: Bearer x` or the `sid` cookie.
function bearerFrom(req) {
  const h = req.headers['authorization'];
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const cookie = req.headers['cookie'];
  if (cookie) {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
    if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  }
  return null;
}

// Role predicate: admin ⊇ editor ⊇ viewer for capability checks.
function hasRole(ctx, role) {
  if (!ctx || !ctx.roles) return false;
  if (ctx.roles.includes('admin')) return true;
  if (role === 'viewer') return ctx.roles.some((r) => ['viewer', 'editor', 'admin'].includes(r));
  if (role === 'editor') return ctx.roles.some((r) => ['editor', 'admin'].includes(r));
  return ctx.roles.includes(role);
}

function mysqlDate(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }

module.exports = { createAuth, hashPassword, verifyPassword, tokenHash, newToken, hasRole, bearerFrom, mysqlDate, totp };
