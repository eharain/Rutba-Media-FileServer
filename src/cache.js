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
    this.warm = false; // true once init() has indexed the whole directory
  }

  has(name) { return this.index.has(name); }

  /**
   * Whether a variant is cached, for the request path. Once the index is warm it is the answer;
   * while the boot scan is still running (the server listens before it ends), a variant the scan
   * has not reached is looked up on disk and indexed, so it is served rather than made again.
   */
  async onDisk(name) {
    if (this.index.has(name)) return true;
    if (this.warm) return false;
    try {
      const st = await fsp.stat(this.pathFor(name));
      if (!st.isFile()) return false;
      if (!this.index.has(name)) { this.index.set(name, { size: st.size, mtime: st.mtimeMs }); this.bytes += st.size; }
      return true;
    } catch {
      return false;
    }
  }

  // Absolute path of a cache entry by name.
  pathFor(name) { return path.join(this.dir, name); }

  // Scan the cache dir into the index; tolerant of a missing/empty dir.
  // Runs after the server is listening (server.js), 16 stats at a time; entries the request
  // path indexed meanwhile (onDisk/add) are not counted twice.
  async init() {
    const started = Date.now();
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      const names = await fsp.readdir(this.dir);
      for (let i = 0; i < names.length; i += 16) {
        await Promise.all(names.slice(i, i + 16).map(async (name) => {
          if (this.index.has(name)) return;
          try {
            const st = await fsp.stat(this.pathFor(name));
            if (st.isFile() && !this.index.has(name)) { this.index.set(name, { size: st.size, mtime: st.mtimeMs }); this.bytes += st.size; }
          } catch {}
        }));
      }
    } catch {}
    this.warm = true;
    console.log(`[media] cache: ${this.index.size} files, ${(this.bytes / 1048576).toFixed(1)} MiB (cap ${(this.maxBytes / 1048576).toFixed(0)} MiB), indexed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    this.evictIfNeeded();
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
