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
const { OriginFetcher } = require('./origin');
const { createMasterResolver } = require('./resolve');
const { createReadHandler } = require('./handlers/read');
const { createWriteHandler } = require('./handlers/write');
const { setCommon, send } = require('./http');

function createApp(config) {
  const cache = new VariantCache(config);
  const resizer = new VariantResizer({ sharp, cache });
  const origin = new OriginFetcher({ sources: config.originSources, masterDir: config.masterDir, cacheDir: config.cacheDir, timeoutMs: config.originTimeoutMs });
  const resolveMaster = createMasterResolver({ config, origin });
  const handleRead = createReadHandler({ config, resizer, sharp, resolveMaster });
  const handleWrite = createWriteHandler({ config, cache });

  const server = http.createServer(async (req, res) => {
    setCommon(res, config.corsOrigin);
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.url === '/_health' || req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

      const u = new URL(req.url, 'http://x');
      const reqRel = u.pathname.replace(/^\/+/, '');

      if (req.method === 'PUT' || req.method === 'DELETE') return handleWrite(req, res, reqRel);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');

      return handleRead(req, res, reqRel, u.searchParams);
    } catch (err) {
      if (!res.headersSent) send(res, 500, 'Server Error'); else res.destroy();
    }
  });
  server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

  return { server, cache, resizer, origin, sharp };
}

module.exports = { createApp };
