'use strict';

/**
 * Resize-on-request engine. Given a master file and resize options, produces (and
 * caches) a variant via `sharp`, then returns its cache path. Identical concurrent
 * requests are de-duped through an in-flight map so the same variant is only
 * rendered once. Writes go to a temp file then atomic-rename into the cache.
 *
 * Cache identity = master rel path + size + mtime + resize params, so a replaced
 * master (new size/mtime) naturally yields fresh variant names.
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pathHash } = require('./util');
const { FMT_EXT } = require('./constants');

class VariantResizer {
  constructor({ sharp, cache }) {
    this.sharp = sharp;
    this.cache = cache;
    this.inflight = new Map(); // name -> Promise (de-dupe concurrent identical work)
  }

  // Deterministic cache filename for a master + options pair.
  cacheNameFor(masterPath, masterRel, masterStat, opts) {
    const ext = FMT_EXT[opts.fm] || path.extname(masterPath).toLowerCase() || '.jpg';
    const keyRaw = `${masterRel}|${masterStat.size}|${masterStat.mtimeMs}|${opts.w || ''}x${opts.h || ''}|${opts.fit}|${opts.q}|${opts.fm || ''}`;
    const name = pathHash(masterRel) + '_' + crypto.createHash('sha1').update(keyRaw).digest('hex').slice(0, 24) + ext;
    return { name, ext };
  }

  async getVariant(masterPath, masterRel, masterStat, opts) {
    const { sharp, cache } = this;
    const { name, ext } = this.cacheNameFor(masterPath, masterRel, masterStat, opts);
    const cachePath = cache.pathFor(name);

    if (cache.has(name)) { cache.touch(name); return { cachePath, ext }; }
    if (this.inflight.has(name)) { await this.inflight.get(name); return { cachePath, ext }; }

    const p = (async () => {
      const tmp = cachePath + '.' + process.pid + '.tmp';
      const meta = await sharp(masterPath).metadata().catch(() => ({}));
      let img = sharp(masterPath, { failOn: 'none', animated: (meta.pages || 1) > 1 });
      if (opts.w || opts.h) img = img.resize({ width: opts.w || null, height: opts.h || null, fit: opts.fit, withoutEnlargement: true });
      const fm = opts.fm || meta.format || 'jpeg';
      if (fm === 'webp') img = img.webp({ quality: opts.q });
      else if (fm === 'avif') img = img.avif({ quality: opts.q });
      else if (fm === 'png') img = img.png({ compressionLevel: 9 });
      else if (fm === 'gif') img = img.gif();
      else img = img.jpeg({ quality: opts.q, mozjpeg: true });
      await img.toFile(tmp);
      const st = await fsp.stat(tmp);
      await fsp.rename(tmp, cachePath);
      cache.add(name, st.size);
    })();

    this.inflight.set(name, p);
    try { await p; } finally { this.inflight.delete(name); }
    return { cachePath, ext };
  }
}

module.exports = { VariantResizer };
