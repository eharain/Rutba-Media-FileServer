'use strict';

/**
 * Rutba media service — masters-only origin with on-the-fly resize + LRU cache,
 * plus authenticated upload/delete so a Strapi provider can push/remove masters.
 *
 * Built for Hostinger Node.js hosting (images.rutba.pk / images.trustlist.uk).
 *
 * READS (public):
 *   GET  /<path>                     serve master as-is (video → Range stream)
 *   GET  /<path>?w=&h=&fit=&q=&fm=    resize on the fly (cached, LRU-rotated)
 *   GET  /uploads/small_<name>.jpg    Strapi-style variant → resize master <name>
 *   GET  /_health                     200 ok
 *
 * WRITES (require Authorization: Bearer $UPLOAD_TOKEN):
 *   PUT    /<path>   (body = file bytes)   store/replace a master, invalidate its cache
 *   DELETE /<path>                         delete a master + purge its cached variants
 *
 * Strategy: keep only masters on disk; resize on request into a size-capped cache
 * (CACHE_MAX_BYTES) with least-recently-used eviction. Videos/SVG/non-raster stream
 * straight from disk with HTTP Range; never resized.
 *
 * Env: PORT HOST UPLOAD_DIR (aka MASTER_DIR/MEDIA_DIR) CACHE_DIR CACHE_MAX_BYTES
 *      IMAGE_QUALITY MAX_DIM VARIANTS CORS_ORIGIN UPLOAD_TOKEN
 *      (dir vars expand a leading `~`, e.g. UPLOAD_DIR=~/uploads/trustlist/)
 * Requires `sharp` (degrades to serving masters unresized if unavailable).
 *
 * This file is just the startup wiring. The implementation lives under src/:
 *   config.js   constants.js   sharp.js   util.js   http.js
 *   cache.js    resizer.js     handlers/{read,write}.js   app.js
 * The app is also exported (createApp/loadConfig) so it can be embedded or tested.
 */

const fs = require('fs');
const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');

// Start the server when run directly (`node server.js`) OR when loaded by a
// Passenger/LiteSpeed-lsnode host, which *require()s* the startup file rather
// than running it as the main module (so `require.main === module` is false
// there). lsnode sets LSNODE_ROOT / Passenger sets PASSENGER_BASE_URI. Plain
// `require('./server.js')` for embedding/testing still does NOT auto-start.
function start(config = loadConfig()) {
  const { server, cache, cluster, db, ffmpeg, storage, sharp } = createApp(config);

  if (!fs.existsSync(config.masterDir)) console.warn(`[media] WARNING: MASTER_DIR missing: ${config.masterDir}`);

  const clusterInfo = cluster.enabled ? `${config.clusterRole}, ${config.clusterPeers.length} peer(s)` : 'OFF';
  const volInfo = storage.multi ? `${storage.volumes.length} volumes (${config.storagePlacement})` : '1 volume';
  // Warm the cache index, bring up the optional DB layer, and probe ffmpeg
  // (best-effort — failures log and leave the feature off), then listen regardless.
  Promise.allSettled([cache.init(), db.init(), ffmpeg.ready]).then(() => server.listen(config.port, config.host, () =>
    console.log(`[media] listening ${config.host}:${config.port} — masters ${config.masterDir}, cache ${config.cacheDir}, storage ${volInfo}, sharp ${sharp ? 'on' : 'OFF'}, ffmpeg ${ffmpeg.enabled ? 'on' : 'OFF'}, writes ${config.uploadToken ? 'on' : 'OFF'}, cluster ${clusterInfo}, db ${db.enabled ? 'on' : 'OFF'}`)
  ));

  return { server, cache, db };
}

if (require.main === module || process.env.LSNODE_ROOT || process.env.PASSENGER_BASE_URI) start();

module.exports = { start, createApp, loadConfig };
