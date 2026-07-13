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

    // ── Login / sessions ───────────────────────────────────────────────────────
    async login(login, password, meta = {}) {
      const user = await auth.findUser(login);
      if (!user || user.status !== 'active') return null;
      if (!(await verifyPassword(password, user.password_hash))) return null;
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
    async verifyCredentials(login, password) {
      if (!db.enabled) return null;
      const user = await auth.findUser(login);
      if (!user || user.status !== 'active') return null;
      if (!(await verifyPassword(password, user.password_hash))) return null;
      return { user, roles: await auth.rolesOf(user.id) };
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

module.exports = { createAuth, hashPassword, verifyPassword, tokenHash, newToken, hasRole, bearerFrom, mysqlDate };
