'use strict';

/**
 * Build the immutable runtime config from environment variables. Kept as a pure
 * factory (`loadConfig(env)`) so the service can be embedded/tested with a custom
 * env instead of always reading `process.env`.
 *
 * Env: PORT HOST UPLOAD_DIR (aka MASTER_DIR/MEDIA_DIR) CACHE_DIR CACHE_MAX_BYTES
 *      IMAGE_QUALITY MAX_DIM VARIANTS CORS_ORIGIN UPLOAD_TOKEN
 *      UPLOAD_MAX_BYTES (aka SIZE_LIMIT) ORIGIN_SOURCES ORIGIN_TIMEOUT_MS
 *      CLUSTER_ROLE (aka NODE_VISIBILITY) CLUSTER_PEERS CLUSTER_SECRET
 *      CLUSTER_TIMEOUT_MS PRIVATE_PATHS
 *      (dir vars expand a leading `~`, e.g. UPLOAD_DIR=~/uploads/trustlist/)
 */

const path = require('path');
const { expandHome, clampInt, parseVariants, parseList, parsePeers } = require('./util');

// Project root (one level up from src/) — anchors the default master/cache dirs
// so they resolve to <repo>/public and <repo>/.cache exactly as before.
const ROOT = path.join(__dirname, '..');

// Prefix → max width (px) for Strapi-style variant URLs (/<dir>/<prefix>_<name>).
// Mirrors Strapi's upload breakpoints (xlarge/large/medium/small/xsmall) plus
// Strapi's always-on `thumbnail`, so every variant URL Strapi can emit resolves
// here off the master. Override wholesale via the VARIANTS env (JSON).
const DEFAULT_VARIANTS = { thumbnail: 245, xsmall: 64, small: 500, medium: 750, large: 1000, xlarge: 1920 };

// Strapi's default upload sizeLimit (256 MiB). PUTs larger than this are rejected.
const DEFAULT_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;

function loadConfig(env = process.env) {
  const cacheMaxBytes = parseInt(env.CACHE_MAX_BYTES, 10) || 1024 * 1024 * 1024;
  const variants = parseVariants(env.VARIANTS) || DEFAULT_VARIANTS;
  // Upload cap. UPLOAD_MAX_BYTES wins over the SIZE_LIMIT alias; an explicit `0`
  // disables the limit. Anything unparseable falls back to the 256 MiB default.
  const sizeLimitRaw = env.UPLOAD_MAX_BYTES != null ? env.UPLOAD_MAX_BYTES : env.SIZE_LIMIT;
  const sizeLimitNum = parseInt(sizeLimitRaw, 10);
  const uploadMaxBytes = Number.isNaN(sizeLimitNum) ? DEFAULT_UPLOAD_MAX_BYTES : sizeLimitNum;

  // Masters live here. Accept UPLOAD_DIR (and the legacy MASTER_DIR/MEDIA_DIR
  // aliases); the first one set wins. `~` is expanded.
  const masterDir = path.resolve(expandHome(env.MASTER_DIR || env.MEDIA_DIR || env.UPLOAD_DIR || path.join(ROOT, 'public')));

  return {
    port: parseInt(env.PORT, 10) || 3000,
    host: env.HOST || '0.0.0.0',
    masterDir,
    cacheDir: path.resolve(expandHome(env.CACHE_DIR || path.join(ROOT, '.cache'))),
    // Deleted masters are moved here (Trash & Recovery) instead of being unlinked,
    // when the DB layer is on. Kept a sibling of masterDir (same volume → atomic
    // rename) but OUTSIDE it, so trashed bytes are never servable. Override with
    // TRASH_DIR. With no DB the trash is unused and DELETE hard-unlinks as before.
    trashDir: path.resolve(expandHome(env.TRASH_DIR || path.join(path.dirname(masterDir), '.media-trash'))),
    // ── Multi-volume storage (optional) ─────────────────────────────────────────
    // Masters may be spread across several directories / mounts. `masterDir` is
    // always volume `default` (first); extra volumes come from STORAGE_VOLUMES,
    // each "id:path" or "id:path|ro" (read-only), whitespace/comma separated. e.g.
    //   STORAGE_VOLUMES="disk2:/mnt/disk2 archive:/mnt/archive|ro"
    // Reads search every volume (default first); new uploads are placed per
    // STORAGE_PLACEMENT: `free` (most free space, default) | `fill` (first with
    // room) | `route` (STORAGE_ROUTES prefix rules, e.g. "archive/=archive").
    // With no extra volumes this is a single-volume system — identical to before.
    storageVolumes: buildVolumes(env, masterDir),
    storagePlacement: ['fill', 'route'].includes((env.STORAGE_PLACEMENT || '').toLowerCase()) ? env.STORAGE_PLACEMENT.toLowerCase() : 'free',
    storageRoutes: parseRoutes(env.STORAGE_ROUTES),
    cacheMaxBytes,
    cacheLowBytes: Math.floor(cacheMaxBytes * 0.8), // evict down to ~80% when full
    defaultQuality: clampInt(env.IMAGE_QUALITY, 80, 1, 100),
    maxDim: parseInt(env.MAX_DIM, 10) || 4000,
    corsOrigin: env.CORS_ORIGIN || '*',
    uploadToken: env.UPLOAD_TOKEN || '',
    uploadMaxBytes, // 0 = unlimited
    // Pull-through origins. When a master is missing locally it is fetched from
    // the first source that has it, persisted under MASTER_DIR, then served.
    // Empty (default) = feature off (missing master → 404). e.g.
    // ORIGIN_SOURCES="https://bucket.s3.amazonaws.com https://old-strapi/uploads"
    originSources: parseList(env.ORIGIN_SOURCES),
    originTimeoutMs: parseInt(env.ORIGIN_TIMEOUT_MS, 10) || 10000,
    // ── Clustering ────────────────────────────────────────────────────────────
    // This node's role in the cluster. `public` = internet-facing; `private` =
    // local/LAN. Drives which masters this node will replicate, accept, and pull:
    // private (visibility) masters are confined to `private`-role nodes; public
    // masters can live on any node. (NODE_VISIBILITY is an alias.)
    clusterRole: (env.CLUSTER_ROLE || env.NODE_VISIBILITY || 'public').toLowerCase() === 'private' ? 'private' : 'public',
    // Sibling nodes. Each entry is "<baseUrl>" or "<baseUrl>|<role>" (role
    // defaults to `public`), whitespace/comma separated. e.g.
    // CLUSTER_PEERS="https://images.rutba.pk|public http://nas.lan:3000|private"
    clusterPeers: parsePeers(env.CLUSTER_PEERS),
    // Shared secret for node-to-node traffic (replication writes + private pulls),
    // distinct from the public UPLOAD_TOKEN. Empty = clustering effectively off
    // for anything that needs auth.
    clusterSecret: env.CLUSTER_SECRET || '',
    clusterTimeoutMs: parseInt(env.CLUSTER_TIMEOUT_MS, 10) || parseInt(env.ORIGIN_TIMEOUT_MS, 10) || 10000,
    // Path prefixes whose masters are private by default (segment-aware, leading
    // slash optional). e.g. PRIVATE_PATHS="private secure/docs". An explicit
    // X-Visibility header on upload overrides this per file.
    privatePaths: parseList(env.PRIVATE_PATHS),
    variants,
    // Matches Strapi-style `<prefix>_<name>` request basenames (e.g. small_photo.jpg).
    variantRe: new RegExp('^(' + Object.keys(variants).join('|') + ')_(.+)$'),
    // ── Database (optional) ─────────────────────────────────────────────────────
    // Enables the accounts / RBAC / metadata / sharing / audit layer. When no DB
    // host is configured, `db` is null and the server runs EXACTLY as before:
    // public reads, token-gated writes, no user layer. MYSQL_* aliases DB_* so
    // either naming works. Set DB_HOST (or MYSQL_HOST) to turn the layer on.
    db: buildDbConfig(env),
    // Read authorization mode (only consulted when `db` is set):
    //   public (default) — reads are open to everyone, exactly as today
    //   mixed            — public-visibility files open; private files need auth+permission
    //   private          — every read needs an authenticated, permitted user
    readAuthMode: ['mixed', 'private'].includes((env.READ_AUTH_MODE || '').toLowerCase())
      ? env.READ_AUTH_MODE.toLowerCase() : 'public',
    // Allow open self-service account registration via POST /_api/auth/register.
    // The very first account is always allowed (bootstrap admin) regardless; after
    // that, registration requires this flag (else an admin must create accounts).
    allowRegistration: /^(1|true|yes|on)$/i.test(env.ALLOW_REGISTRATION || ''),
    // Session lifetime (days) for issued login tokens.
    sessionTtlDays: parseInt(env.SESSION_TTL_DAYS, 10) || 30,
    // WebDAV mount at /_dav/ (needs the DB layer for accounts). On by default when
    // the DB layer is up; set WEBDAV_ENABLED/WEBDAV to 0/false/off to disable.
    webdavEnabled: !/^(0|false|off|no)$/i.test(env.WEBDAV_ENABLED || env.WEBDAV || ''),
  };
}

// Build the storage volume list. `default` (masterDir) is always first; extra
// volumes are parsed from STORAGE_VOLUMES ("id:path" or "id:path|ro"). Duplicate
// ids and a volume equal to masterDir are skipped.
function buildVolumes(env, masterDir) {
  const vols = [{ id: 'default', dir: masterDir, readOnly: false }];
  const seenId = new Set(['default']);
  const seenDir = new Set([masterDir]);
  const raw = env.STORAGE_VOLUMES;
  if (raw) {
    for (const tok of raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)) {
      let spec = tok, readOnly = false;
      const bar = spec.lastIndexOf('|');
      if (bar !== -1) { readOnly = /^ro$/i.test(spec.slice(bar + 1)); spec = spec.slice(0, bar); }
      const colon = spec.indexOf(':');
      // Keep Windows drive letters intact (e.g. d2:D:\media) — split on the FIRST
      // colon only when what follows isn't a drive-letter path.
      let id, dir;
      if (colon > 0) { id = spec.slice(0, colon); dir = spec.slice(colon + 1); }
      else { id = spec; dir = spec; }
      id = id.trim(); dir = path.resolve(expandHome(dir.trim()));
      if (!id || !dir || seenId.has(id) || seenDir.has(dir)) continue;
      seenId.add(id); seenDir.add(dir);
      vols.push({ id, dir, readOnly });
    }
  }
  return vols;
}

// Parse STORAGE_ROUTES ("prefix=volumeId prefix2=volumeId2") into rules sorted by
// prefix length (longest match wins).
function parseRoutes(s) {
  if (!s) return [];
  return s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean).map((t) => {
    const i = t.indexOf('=');
    if (i === -1) return null;
    return { prefix: t.slice(0, i).replace(/^\/+/, ''), volumeId: t.slice(i + 1) };
  }).filter((r) => r && r.prefix && r.volumeId).sort((a, b) => b.prefix.length - a.prefix.length);
}

// Assemble the DB connection config, or null when unconfigured (feature off).
// Accepts DB_* with MYSQL_* aliases; a bare DB_URL / MYSQL_URL is also honored.
function buildDbConfig(env) {
  const url = env.DB_URL || env.MYSQL_URL || env.DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        port: parseInt(u.port, 10) || 3306,
        user: decodeURIComponent(u.username || 'root'),
        password: decodeURIComponent(u.password || ''),
        database: u.pathname.replace(/^\//, '') || 'media',
        connectionLimit: parseInt(env.DB_POOL, 10) || 10,
      };
    } catch { /* fall through to discrete vars */ }
  }
  const host = env.DB_HOST || env.MYSQL_HOST;
  if (!host) return null;
  return {
    host,
    port: parseInt(env.DB_PORT || env.MYSQL_PORT, 10) || 3306,
    user: env.DB_USER || env.MYSQL_USER || 'root',
    password: env.DB_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASS || '',
    database: env.DB_NAME || env.MYSQL_DATABASE || 'media',
    connectionLimit: parseInt(env.DB_POOL, 10) || 10,
  };
}

module.exports = { loadConfig, DEFAULT_VARIANTS, DEFAULT_UPLOAD_MAX_BYTES };
