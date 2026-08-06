'use strict';

/**
 * Named renditions — "web-hero" instead of "?w=1600&h=900&fit=cover&q=82&fm=webp".
 *
 * Pure metadata over the resize engine that already exists. The value is indirection:
 * a downstream team asks for a rendition by name, and the definition can be retuned
 * later without touching a single URL they shipped.
 *
 * Definitions live in the `renditions` table, so this needs the DB layer. They are
 * cached in memory with a short TTL because the read path consults them on every
 * request that names one, and a database round trip per image request is not a thing
 * this server does.
 */

const CACHE_TTL_MS = 30_000;

function createRenditions({ db }) {
  let cache = new Map();
  let loadedAt = 0;
  let loading = null;

  async function reload() {
    const rows = await db.query('SELECT name, width, height, fit, format, quality FROM renditions').catch(() => []);
    const next = new Map();
    for (const r of rows) {
      next.set(r.name, {
        name: r.name,
        width: r.width != null ? Number(r.width) : 0,
        height: r.height != null ? Number(r.height) : 0,
        fit: r.fit || null,
        format: r.format || null,
        quality: r.quality != null ? Number(r.quality) : null,
      });
    }
    cache = next;
    loadedAt = Date.now();
    return cache;
  }

  return {
    /** Look up a rendition by name, or null. Cheap: memory, refreshed on a TTL. */
    async get(name) {
      if (!db || !db.enabled) return null;
      if (Date.now() - loadedAt > CACHE_TTL_MS) {
        // De-duplicate concurrent refreshes — a burst of requests must not become a
        // burst of identical queries.
        loading = loading || reload().finally(() => { loading = null; });
        await loading;
      }
      return cache.get(String(name)) || null;
    },

    /** Drop the cache (after an admin edits a definition, so it takes effect now). */
    invalidate() { loadedAt = 0; },

    async all() {
      if (!db || !db.enabled) return [];
      if (Date.now() - loadedAt > CACHE_TTL_MS) await reload();
      return [...cache.values()];
    },
  };
}

module.exports = { createRenditions };
