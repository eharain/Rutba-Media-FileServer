'use strict';

/**
 * Origin pull-through. When a master is absent locally, fetch it from one of the
 * configured `sources` (e.g. the original S3 bucket / old Strapi `/uploads`),
 * persist it under MASTER_DIR, and hand it back so the request can be served
 * (resized as asked). On a cold miss the master is downloaded once, then lives
 * locally like any other master (DELETE removes it).
 *
 * Security: only the explicit `sources` allow-list is fetched, and only at
 * traversal-safe relative paths (the caller passes rels derived from resolveSafe),
 * so this is not a general SSRF surface. Disabled when `sources` is empty.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { pathHash } = require('./util');

class OriginFetcher {
  constructor({ sources, masterDir, cacheDir, timeoutMs }) {
    this.sources = Array.isArray(sources) ? sources : [];
    this.enabled = this.sources.length > 0;
    this.masterDir = masterDir;
    this.cacheDir = cacheDir;
    this.timeoutMs = timeoutMs || 10000;
    this.inflight = new Map(); // rel -> Promise (de-dupe concurrent cold misses)
  }

  // Try each candidate rel (in order) against the sources; first hit wins.
  // Returns { path, rel, stat } once persisted, or null if none had it.
  async fetchMaster(rels) {
    for (const rel of rels) {
      const hit = await this._fetchRel(rel);
      if (hit) return hit;
    }
    return null;
  }

  _fetchRel(rel) {
    if (this.inflight.has(rel)) return this.inflight.get(rel);
    const p = this._doFetch(rel).finally(() => this.inflight.delete(rel));
    this.inflight.set(rel, p);
    return p;
  }

  async _doFetch(rel) {
    for (const base of this.sources) {
      const url = base + '/' + encodeURI(rel);
      let res;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        try { res = await fetch(url, { signal: ac.signal, redirect: 'follow' }); }
        finally { clearTimeout(timer); }
      } catch { continue; }
      if (!res || !res.ok || !res.body) continue;

      const dest = path.join(this.masterDir, rel);
      const tmp = path.join(this.cacheDir, `origin.${process.pid}.${pathHash(rel)}.tmp`);
      try {
        await fsp.mkdir(this.cacheDir, { recursive: true });
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rename(tmp, dest); // atomic publish into MASTER_DIR
        const stat = await fsp.stat(dest);
        console.log(`[media] origin: fetched ${rel} from ${base} (${(stat.size / 1024).toFixed(1)} KiB)`);
        return { path: dest, rel, stat };
      } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        // Could not persist (e.g. read-only MASTER_DIR) — treat as a miss.
        console.warn(`[media] origin: failed to store ${rel} from ${base}: ${e && e.message || e}`);
        continue;
      }
    }
    return null;
  }
}

module.exports = { OriginFetcher };
