'use strict';

/**
 * Shared "download a master from a remote base and persist it" primitive, used by
 * both the external origin pull-through (src/origin.js) and the cluster peer pull
 * (src/cluster.js). Tries each base in order; the first that returns 200 + a body
 * wins. The bytes are streamed to a temp file under cacheDir and atomically
 * renamed into masterDir, so a partial download never publishes a half file and a
 * read-only masterDir degrades to a clean miss.
 *
 * Security: callers pass traversal-safe rels (derived from resolveSafe) and an
 * explicit base allow-list, so this is not a general SSRF surface.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { pathHash } = require('./util');
const { HDR_VISIBILITY } = require('./constants');
const { normVisibility } = require('./visibility');

// Returns { path, rel, stat, base, visibility } on success, or null if no base had it.
async function fetchAndStore({ bases, rel, headers, masterDir, cacheDir, timeoutMs, label }) {
  label = label || 'pull';
  for (const base of bases) {
    const url = base + '/' + encodeURI(rel);
    let res;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs || 10000);
      try { res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: headers || {} }); }
      finally { clearTimeout(timer); }
    } catch { continue; }
    if (!res || !res.ok || !res.body) continue;

    const dest = path.join(masterDir, rel);
    const tmp = path.join(cacheDir, `${label}.${process.pid}.${pathHash(rel)}.tmp`);
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(tmp, dest); // atomic publish into masterDir
      const stat = await fsp.stat(dest);
      return { path: dest, rel, stat, base, visibility: normVisibility(res.headers.get(HDR_VISIBILITY)) };
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      console.warn(`[media] ${label}: failed to store ${rel} from ${base}: ${e && e.message || e}`);
      continue;
    }
  }
  return null;
}

module.exports = { fetchAndStore };
