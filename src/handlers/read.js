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
const { isPrivateRel, readSidecar } = require('../visibility');

const FIT_VALUES = ['cover', 'contain', 'inside', 'outside', 'fill'];

// A fully-open guard, so the handler needs no null checks when READ_AUTH_MODE is
// unset — which is the default, and must stay free.
const OPEN_GUARD = { enabled: false, checksBeforeResolve: false, async deny() { return null; } };

function createReadHandler({ config, resizer, sharp, resolveMaster, media = null, readGuard = OPEN_GUARD, renditions = null }) {
  // Parse resize options from the query string, clamped to safe ranges.
  // A named rendition (`?rendition=web-hero`) supplies the same options from a
  // stored preset, so downstream teams ask for a name instead of memorizing a query
  // string — and the definition can be retuned without touching their URLs. An
  // explicit query parameter still wins, so a rendition is a default, not a cage.
  function parseOpts(req, q, preset) {
    const wq = clampInt(q.get('w'), preset ? preset.width || 0 : 0, 1, config.maxDim);
    const hq = clampInt(q.get('h'), preset ? preset.height || 0 : 0, 1, config.maxDim);
    let fm = (q.get('fm') || (preset && preset.format) || '').toLowerCase();
    if (fm === 'auto') {
      const a = req.headers.accept || '';
      fm = a.includes('image/avif') ? 'avif' : a.includes('image/webp') ? 'webp' : '';
    }
    if (fm && !FMT_EXT[fm]) fm = '';
    const fitParam = q.get('fit') || (preset && preset.fit);
    return {
      w: wq || 0,
      h: hq || 0,
      fit: FIT_VALUES.includes(fitParam) ? fitParam : 'inside',
      q: clampInt(q.get('q'), (preset && preset.quality) || config.defaultQuality, 1, 100),
      fm,
    };
  }

  return async function handleRead(req, res, reqRel, q) {
    const renditionName = q.get('rendition');
    const preset = renditionName && renditions ? await renditions.get(renditionName) : null;
    if (renditionName && !preset) return send(res, 404, `Unknown rendition: ${renditionName}`);
    const opts = parseOpts(req, q, preset);
    const hasQuery = !!(opts.w || opts.h || opts.fm);
    const posterReq = q.has('poster') || q.has('thumb');
    const transcodeReq = q.get('transcode') || q.get('mp4');

    // READ_AUTH_MODE=private refuses everything up front — no point resolving (or,
    // worse, pulling from an origin) for a caller who may not read anything at all.
    if (readGuard.checksBeforeResolve) {
      const refusal = await readGuard.deny(req, 'private');
      if (refusal) return send(res, refusal.status, refusal.message);
    }

    // resolveMaster may set opts.w (variant width) when a Strapi prefix matched.
    const r = await resolveMaster(reqRel, opts);
    if (r.forbidden) return send(res, 403, 'Forbidden');
    if (!r.masterPath || !r.stat) return send(res, 404, 'Not Found');
    const { masterPath, stat } = r;
    const rel = r.rel || relOf(config.masterDir, masterPath);

    // READ_AUTH_MODE=mixed gates only private masters, so it needs the resolved
    // file's actual visibility: an explicit per-file sidecar if one exists, else the
    // path rule. (A sidecar read is one stat-ish syscall and only happens in `mixed`.)
    if (readGuard.enabled && !readGuard.checksBeforeResolve) {
      const visibility = (await readSidecar(masterPath)) || (isPrivateRel(rel, config.privatePaths) ? 'private' : 'public');
      const refusal = await readGuard.deny(req, visibility);
      if (refusal) return send(res, refusal.status, refusal.message);
    }

    const ext = path.extname(masterPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const isVideo = /^video\//.test(mime);

    // Video poster frame (for <img>/thumbnails). Cached like an image variant.
    if (posterReq && isVideo) {
      if (!media || !media.enabled) return send(res, 415, 'Poster unavailable');
      try {
        const t = Math.max(0, parseFloat(q.get('t')) || 1);
        const pv = await media.getPoster(masterPath, rel, stat, { t, w: opts.w, h: opts.h, q: opts.q, fm: opts.fm });
        const pst = pv && await fsp.stat(pv.cachePath).catch(() => null);
        if (pst) return streamFile(req, res, pv.cachePath, MIME[pv.ext] || 'image/jpeg', pst);
      } catch (e) { /* fall through to error below */ }
      return send(res, 415, 'Poster failed');
    }

    // On-demand transcode to a web-friendly MP4 (optionally scaled). Heavy; cached.
    if (transcodeReq && isVideo && media && media.enabled) {
      try {
        const height = clampInt(transcodeReq, 720, 144, 2160);
        const tv = await media.getTranscode(masterPath, rel, stat, { height });
        const tst = tv && await fsp.stat(tv.cachePath).catch(() => null);
        if (tst) return streamFile(req, res, tv.cachePath, 'video/mp4', tst);
      } catch (e) { /* fall back to streaming the original below */ }
    }

    const wantResize = (hasQuery || opts.w) && RASTER.has(ext) && sharp && ext !== '.svg';
    if (!wantResize) return streamFile(req, res, masterPath, mime, stat);

    const v = await resizer.getVariant(masterPath, rel, stat, opts);
    const vstat = await fsp.stat(v.cachePath).catch(() => null);
    if (!vstat) return streamFile(req, res, masterPath, mime, stat);
    return streamFile(req, res, v.cachePath, MIME[v.ext] || 'image/jpeg', vstat);
  };
}

module.exports = { createReadHandler };
