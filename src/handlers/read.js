'use strict';

/**
 * Public reads (GET/HEAD). Master resolution (exact path, Strapi-prefix with
 * extension-swap, and origin pull-through) is delegated to `resolveMaster`; this
 * handler parses resize options, then either streams the file or serves a cached
 * resize.
 *
 *   - query params:  /<path>?w=&h=&fit=&q=&fm=   (fm=auto honors the Accept header)
 *   - Strapi prefix: /<dir>/small_<name>.ext     (mapped to the variant width)
 *
 * Raster images are resized via the cache; videos/SVG/non-raster (and the
 * no-params case, or when sharp is absent) stream straight from disk with Range.
 */

const fsp = require('fs/promises');
const path = require('path');
const { relOf, clampInt } = require('../util');
const { send, streamFile } = require('../http');
const { MIME, RASTER, FMT_EXT } = require('../constants');

const FIT_VALUES = ['cover', 'contain', 'inside', 'outside', 'fill'];

function createReadHandler({ config, resizer, sharp, resolveMaster }) {
  // Parse resize options from the query string, clamped to safe ranges.
  function parseOpts(req, q) {
    const wq = clampInt(q.get('w'), 0, 1, config.maxDim);
    const hq = clampInt(q.get('h'), 0, 1, config.maxDim);
    let fm = (q.get('fm') || '').toLowerCase();
    if (fm === 'auto') {
      const a = req.headers.accept || '';
      fm = a.includes('image/avif') ? 'avif' : a.includes('image/webp') ? 'webp' : '';
    }
    if (fm && !FMT_EXT[fm]) fm = '';
    return {
      w: wq || 0,
      h: hq || 0,
      fit: FIT_VALUES.includes(q.get('fit')) ? q.get('fit') : 'inside',
      q: clampInt(q.get('q'), config.defaultQuality, 1, 100),
      fm,
    };
  }

  return async function handleRead(req, res, reqRel, q) {
    const opts = parseOpts(req, q);
    const hasQuery = !!(opts.w || opts.h || opts.fm);

    // resolveMaster may set opts.w (variant width) when a Strapi prefix matched.
    const r = await resolveMaster(reqRel, opts);
    if (r.forbidden) return send(res, 403, 'Forbidden');
    if (!r.masterPath || !r.stat) return send(res, 404, 'Not Found');
    const { masterPath, stat } = r;

    const ext = path.extname(masterPath).toLowerCase();
    const wantResize = (hasQuery || opts.w) && RASTER.has(ext) && sharp && ext !== '.svg';
    if (!wantResize) return streamFile(req, res, masterPath, MIME[ext] || 'application/octet-stream', stat);

    const v = await resizer.getVariant(masterPath, relOf(config.masterDir, masterPath), stat, opts);
    const vstat = await fsp.stat(v.cachePath).catch(() => null);
    if (!vstat) return streamFile(req, res, masterPath, MIME[ext] || 'application/octet-stream', stat);
    return streamFile(req, res, v.cachePath, MIME[v.ext] || 'image/jpeg', vstat);
  };
}

module.exports = { createReadHandler };
