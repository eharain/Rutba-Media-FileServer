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

const { fetchAndStore } = require('./fetchstore');

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
    const hit = await fetchAndStore({
      bases: this.sources, rel, masterDir: this.masterDir, cacheDir: this.cacheDir,
      timeoutMs: this.timeoutMs, label: 'origin',
    });
    if (hit) console.log(`[media] origin: fetched ${rel} from ${hit.base} (${(hit.stat.size / 1024).toFixed(1)} KiB)`);
    return hit;
  }
}

module.exports = { OriginFetcher };
