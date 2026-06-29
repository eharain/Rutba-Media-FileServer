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

  return {
    port: parseInt(env.PORT, 10) || 3000,
    host: env.HOST || '0.0.0.0',
    // Masters live here. Accept UPLOAD_DIR (and the legacy MASTER_DIR/MEDIA_DIR
    // aliases); the first one set wins. `~` is expanded.
    masterDir: path.resolve(expandHome(env.MASTER_DIR || env.MEDIA_DIR || env.UPLOAD_DIR || path.join(ROOT, 'public'))),
    cacheDir: path.resolve(expandHome(env.CACHE_DIR || path.join(ROOT, '.cache'))),
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
  };
}

module.exports = { loadConfig, DEFAULT_VARIANTS, DEFAULT_UPLOAD_MAX_BYTES };
