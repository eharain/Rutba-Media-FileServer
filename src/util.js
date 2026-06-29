'use strict';

/**
 * Pure helpers: home-dir / `~` expansion, numeric & JSON parsing, content hashing,
 * and safe path resolution. No dependence on runtime config or global state, so
 * these are trivially reusable and testable in isolation.
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Resolve the real user home for `~` expansion. Prefer the passwd entry
// (os.userInfo) over $HOME: some hosts (e.g. LiteSpeed `lsnode` on Hostinger)
// run the process with HOME set to the app/domain dir, which makes os.homedir()
// — and therefore `~` — mis-expand. os.userInfo().homedir reads the passwd
// record and ignores $HOME, so `UPLOAD_DIR=~/uploads/trustlist/` resolves to the
// real /home/<user>/uploads/... regardless of how HOME was set.
function userHome() {
  try { const h = os.userInfo().homedir; if (h) return h; } catch { /* fall through */ }
  return os.homedir();
}

// Expand a leading `~` / `~/` to the user home dir (Node does not do this itself).
function expandHome(p) {
  if (!p) return p;
  const home = userHome();
  if (p === '~') return home;
  if (p === '~/' || p === '~\\') return home + path.sep;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

// Parse an int from env-ish input, clamped to [lo, hi]; falls back to `def` if NaN.
function clampInt(v, def, lo, hi) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

// Parse a JSON object string (e.g. the VARIANTS env); null if absent/invalid.
function parseVariants(s) {
  if (!s) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

// Parse a whitespace/comma-separated list (e.g. ORIGIN_SOURCES) into a trimmed,
// trailing-slash-stripped array; [] if empty.
function parseList(s) {
  if (!s) return [];
  return s.split(/[\s,]+/).map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
}

// Parse CLUSTER_PEERS into [{ url, role }]. Each token is "<baseUrl>" or
// "<baseUrl>|<role>" (role ∈ {public, private}, default public); trailing slashes
// on the URL are stripped. Whitespace/comma separated.
function parsePeers(s) {
  if (!s) return [];
  return s.split(/[\s,]+/).map((tok) => tok.trim()).filter(Boolean).map((tok) => {
    const i = tok.lastIndexOf('|');
    let url = tok, role = 'public';
    if (i !== -1) { url = tok.slice(0, i); role = tok.slice(i + 1).toLowerCase(); }
    url = url.replace(/\/+$/, '');
    return { url, role: role === 'private' ? 'private' : 'public' };
  }).filter((p) => p.url);
}

// Swap an extension on a path's basename. swapExt('a/b.webp', '.jpg') -> 'a/b.jpg'.
function swapExt(p, ext) {
  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  const rel = (dir === '.' ? '' : dir + '/') + base + ext;
  return rel.replace(/\\/g, '/');
}

// Stable short hash of a relative path — used to namespace a master's cached variants.
function pathHash(rel) {
  return crypto.createHash('sha1').update(rel.replace(/\\/g, '/')).digest('hex').slice(0, 16);
}

// Resolve `relPath` under `root`, rejecting anything that escapes it (path traversal).
// Returns the absolute path, or null if unsafe / undecodable.
function resolveSafe(root, relPath) {
  let p;
  try { p = decodeURIComponent(relPath.split('?')[0]); } catch { return null; }
  const normalized = path.normalize(p).replace(/^([/\\])+/, '');
  const full = path.join(root, normalized);
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootSep)) return null;
  return full;
}

// Forward-slash relative path of `abs` within `root` (used for cache keys / URLs).
function relOf(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

module.exports = { userHome, expandHome, clampInt, parseVariants, parseList, parsePeers, swapExt, pathHash, resolveSafe, relOf };
