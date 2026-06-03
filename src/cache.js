'use strict';

/**
 * On-disk variant cache with size cap + least-recently-used eviction.
 *
 * Keeps an in-memory index (name → {size, mtime}) of the files in `cacheDir`.
 * Every read "touches" an entry (updates mtime on disk + in memory) so eviction
 * is true LRU. When total bytes exceed `maxBytes`, the oldest entries are deleted
 * until usage drops to `lowBytes` (~80%).
 *
 * Instantiated per service (`new VariantCache(config)`) rather than a module
 * singleton, so it carries no hidden global state and is straightforward to test.
 */

const fsp = require('fs/promises');
const path = require('path');
const { pathHash } = require('./util');

class VariantCache {
  constructor({ cacheDir, cacheMaxBytes, cacheLowBytes }) {
    this.dir = cacheDir;
    this.maxBytes = cacheMaxBytes;
    this.lowBytes = cacheLowBytes;
    this.index = new Map(); // name -> { size, mtime }
    this.bytes = 0;
    this.evicting = false;
  }

  has(name) { return this.index.has(name); }

  // Absolute path of a cache entry by name.
  pathFor(name) { return path.join(this.dir, name); }

  // Scan the cache dir into the index; tolerant of a missing/empty dir.
  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      for (const name of await fsp.readdir(this.dir)) {
        try {
          const st = await fsp.stat(this.pathFor(name));
          if (st.isFile()) { this.index.set(name, { size: st.size, mtime: st.mtimeMs }); this.bytes += st.size; }
        } catch {}
      }
    } catch {}
    console.log(`[media] cache: ${this.index.size} files, ${(this.bytes / 1048576).toFixed(1)} MiB (cap ${(this.maxBytes / 1048576).toFixed(0)} MiB)`);
  }

  // Mark an entry as freshly used (LRU bump), best-effort on disk.
  touch(name) {
    const e = this.index.get(name);
    if (e) {
      e.mtime = Date.now();
      fsp.utimes(this.pathFor(name), new Date(), new Date()).catch(() => {});
    }
  }

  // Register a newly written variant and trigger eviction if over cap.
  add(name, size) {
    this.index.set(name, { size, mtime: Date.now() });
    this.bytes += size;
    this.evictIfNeeded();
  }

  // Delete oldest entries until usage is back under `lowBytes`. Re-entrancy guarded.
  async evictIfNeeded() {
    if (this.evicting || this.bytes <= this.maxBytes) return;
    this.evicting = true;
    try {
      for (const [name, e] of [...this.index.entries()].sort((a, b) => a[1].mtime - b[1].mtime)) {
        if (this.bytes <= this.lowBytes) break;
        try { await fsp.unlink(this.pathFor(name)); } catch {}
        this.index.delete(name);
        this.bytes -= e.size;
      }
    } finally {
      this.evicting = false;
    }
  }

  // Purge every cached variant derived from a given master path (on PUT/DELETE).
  async purgeForPath(rel) {
    const prefix = pathHash(rel) + '_';
    for (const name of [...this.index.keys()]) {
      if (name.startsWith(prefix)) {
        const e = this.index.get(name);
        try { await fsp.unlink(this.pathFor(name)); } catch {}
        this.index.delete(name);
        this.bytes -= e ? e.size : 0;
      }
    }
  }
}

module.exports = { VariantCache };
