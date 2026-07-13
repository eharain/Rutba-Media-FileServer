'use strict';

/**
 * Wire the pieces into an HTTP server: build the cache + resizer, the read/write
 * handlers, and route requests. Returns the (not-yet-listening) server plus the
 * cache so the caller can `await cache.init()` before `server.listen(...)`.
 *
 * Routing:
 *   OPTIONS                  -> 204 (CORS preflight)
 *   GET /_health|/healthz    -> 200 ok
 *   PUT|DELETE /<path>       -> write handler (auth)
 *   GET|HEAD /<path>         -> read handler
 *   anything else            -> 405
 */

const http = require('http');
const sharp = require('./sharp');
const { VariantCache } = require('./cache');
const { VariantResizer } = require('./resizer');
const { createFfmpeg } = require('./ffmpeg');
const { MediaVariant } = require('./mediavariant');
const { OriginFetcher } = require('./origin');
const { Cluster } = require('./cluster');
const { createStorage } = require('./storage');
const { createDb } = require('./db');
const { createAuth } = require('./auth');
const { createFileIndex } = require('./fileindex');
const { createTrash } = require('./trash');
const { createMasterResolver } = require('./resolve');
const { createReadHandler } = require('./handlers/read');
const { createWriteHandler } = require('./handlers/write');
const { createApiHandler } = require('./handlers/api');
const { createUiHandler } = require('./handlers/ui');
const { createShareHandler } = require('./handlers/share');
const { createMasterOps } = require('./masterops');
const { createWebdavHandler } = require('./handlers/webdav');
const { setCommon, send } = require('./http');

function createApp(config) {
  const cache = new VariantCache(config);
  const resizer = new VariantResizer({ sharp, cache });
  const ffmpeg = createFfmpeg(config);
  const media = new MediaVariant({ ffmpeg, sharp, cache });
  const origin = new OriginFetcher({ sources: config.originSources, masterDir: config.masterDir, cacheDir: config.cacheDir, timeoutMs: config.originTimeoutMs });
  const cluster = new Cluster({ role: config.clusterRole, peers: config.clusterPeers, secret: config.clusterSecret, masterDir: config.masterDir, cacheDir: config.cacheDir, timeoutMs: config.clusterTimeoutMs });
  // Optional DB-backed layer (accounts / RBAC / metadata / audit). Disabled stub
  // when config.db is null — the handlers below run exactly as before without it.
  const storage = createStorage(config);
  const db = createDb(config);
  const auth = createAuth({ db, config });
  const index = createFileIndex({ db });
  const trash = createTrash({ config, db, cluster, storage });
  const resolveMaster = createMasterResolver({ config, storage, origin, cluster });
  const handleRead = createReadHandler({ config, resizer, sharp, resolveMaster, media });
  const handleWrite = createWriteHandler({ config, cache, cluster, storage, index, trash, auth, db, ffmpeg });
  const handleApi = createApiHandler({ config, db, auth, trash, storage });
  const handleUi = createUiHandler({ db });
  const handleShare = createShareHandler({ config, db, storage });
  const masterops = createMasterOps({ config, storage, cache, cluster, index, trash, sharp, ffmpeg });
  const handleDav = createWebdavHandler({ config, db, auth, storage, masterops });

  const server = http.createServer(async (req, res) => {
    setCommon(res, config.corsOrigin);
    try {
      const u = new URL(req.url, 'http://x');

      // WebDAV mount. Checked first because it owns non-standard methods (PROPFIND,
      // MKCOL, …) and needs its own OPTIONS (DAV headers) rather than the CORS 204.
      if (u.pathname === '/_dav' || u.pathname.startsWith('/_dav/')) return void (await handleDav(req, res, u));

      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.url === '/_health' || req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

      // Control plane: JSON API for accounts / management. Kept on its own `/_api/`
      // namespace (like `/_health`) so it never collides with media path keys.
      if (u.pathname === '/_api' || u.pathname.startsWith('/_api/')) return void (await handleApi(req, res, u));

      // Web console (static SPA). Own `/_ui/` namespace; 404s when the DB layer is off.
      if (u.pathname === '/_ui' || u.pathname.startsWith('/_ui/')) return void (await handleUi(req, res, u));

      // Public share links. Own `/_s/` namespace; 404s when the DB layer is off.
      if (u.pathname === '/_s' || u.pathname.startsWith('/_s/')) return void (await handleShare(req, res, u));

      const reqRel = u.pathname.replace(/^\/+/, '');

      if (req.method === 'PUT' || req.method === 'DELETE') return handleWrite(req, res, reqRel);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');

      return handleRead(req, res, reqRel, u.searchParams);
    } catch (err) {
      if (!res.headersSent) send(res, 500, 'Server Error'); else res.destroy();
    }
  });
  server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

  return { server, cache, resizer, media, ffmpeg, origin, cluster, storage, db, auth, trash, sharp };
}

module.exports = { createApp };
