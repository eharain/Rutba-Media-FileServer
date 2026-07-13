'use strict';

/**
 * Video derivative engine: poster frames and transcodes, cached in the same
 * size-capped LRU cache as image variants. Naming shares the master's `pathHash`
 * prefix, so `cache.purgeForPath(rel)` on PUT/DELETE invalidates posters and
 * transcodes too. Identical concurrent requests are de-duped via an in-flight map;
 * writes go to a temp file then atomic-rename into the cache.
 *
 * Disabled (returns null) when ffmpeg is unavailable, so the read handler falls
 * back to streaming the original.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { pathHash } = require('./util');
const { FMT_EXT } = require('./constants');

class MediaVariant {
  constructor({ ffmpeg, sharp, cache }) {
    this.ffmpeg = ffmpeg;
    this.sharp = sharp;
    this.cache = cache;
    this.inflight = new Map();
  }

  get enabled() { return this.ffmpeg && this.ffmpeg.enabled; }

  async _produce(name, make) {
    const { cache } = this;
    const cachePath = cache.pathFor(name);
    if (cache.has(name)) { cache.touch(name); return cachePath; }
    if (this.inflight.has(name)) { await this.inflight.get(name); return cachePath; }
    const p = (async () => {
      const tmp = cachePath + '.' + process.pid + '.tmp';
      try {
        await make(tmp);
        const st = await fsp.stat(tmp);
        await fsp.rename(tmp, cachePath);
        cache.add(name, st.size);
      } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        throw e;
      }
    })();
    this.inflight.set(name, p);
    try { await p; } finally { this.inflight.delete(name); }
    return cachePath;
  }

  // A poster frame (image) for a video master.
  async getPoster(masterPath, rel, stat, { t = 1, w = 0, h = 0, q = 80, fm = '' } = {}) {
    if (!this.enabled) return null;
    const ext = FMT_EXT[fm] || '.jpg';
    const key = `${stat.size}|${stat.mtimeMs}|poster|${t}|${w}x${h}|${q}|${fm}`;
    const name = pathHash(rel) + '_p_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + ext;
    const cachePath = await this._produce(name, async (tmp) => {
      const frame = await this.ffmpeg.posterBuffer(masterPath, { t, w, h });
      // Re-encode through sharp when a non-JPEG format/quality is requested (or to
      // normalize); otherwise write the ffmpeg JPEG straight out.
      if (this.sharp && (fm === 'webp' || fm === 'avif' || fm === 'png')) {
        let img = this.sharp(frame);
        if (fm === 'webp') img = img.webp({ quality: q });
        else if (fm === 'avif') img = img.avif({ quality: q });
        else img = img.png({ compressionLevel: 9 });
        await img.toFile(tmp);
      } else {
        await fsp.writeFile(tmp, frame);
      }
    });
    return { cachePath, ext };
  }

  // A transcoded H.264/AAC MP4 (optionally scaled to `height`).
  async getTranscode(masterPath, rel, stat, { height = 720, crf = 24 } = {}) {
    if (!this.enabled) return null;
    const key = `${stat.size}|${stat.mtimeMs}|mp4|${height}|${crf}`;
    const name = pathHash(rel) + '_v_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '.mp4';
    const cachePath = await this._produce(name, async (tmp) => {
      const out = tmp + '.mp4'; // ffmpeg infers the container from the extension
      await this.ffmpeg.transcodeToFile(masterPath, out, { height, crf });
      await fsp.rename(out, tmp);
    });
    return { cachePath, ext: '.mp4' };
  }
}

module.exports = { MediaVariant };
