'use strict';

/**
 * Resolve a request path to a master file on disk, applying (in order):
 *   1. Exact path under MASTER_DIR — serve as-is / resize per query.
 *   2. Strapi-style prefix (`<dir>/small_<name>.ext`) — strip the prefix to find
 *      the master and set the variant width. The requested extension is treated
 *      as a hint only: if `<name>.<reqExt>` is absent, the same base name is tried
 *      against the known master extensions (so `/small_x.webp` finds master `x.jpg`).
 *      Output keeps the MASTER's own format — extension-swap locates, it never
 *      transcodes (callers can still force a format with `?fm=`).
 *   3. Cluster peers — if still missing and peers are configured, pull the master
 *      from an eligible sibling node (per the master's visibility) and persist it.
 *   4. Origin pull-through — if still missing and origins are configured, download
 *      the master (trying the same candidate rels) and persist it, then serve.
 *
 * Returns one of:
 *   { masterPath, stat, rel }   resolved (rel = volume-independent URL key)
 *   { forbidden: true }         path escaped MASTER_DIR
 *   { notFound: true }          nothing matched
 * and may set `opts.w` to the variant width when a prefix matched.
 *
 * The local disk checks (1, 2) search every configured storage volume (default
 * first) via `storage`, so masters spread across mounts all resolve. `rel` is
 * returned so the caller keys the variant cache on the URL path, not the physical
 * volume it happened to land on.
 */

const path = require('path');
const { resolveSafe, relOf, swapExt } = require('./util');
const { MASTER_EXTS, SIDECAR_EXT } = require('./constants');
const { isPrivateRel } = require('./visibility');

// Requested extension first (so an exact-format master is preferred), then the
// rest of the known master extensions, de-duplicated.
function candidateExts(reqExt) {
  const out = [];
  const push = (e) => { if (e && !out.includes(e)) out.push(e); };
  push(reqExt);
  for (const e of MASTER_EXTS) push(e);
  return out;
}

function createMasterResolver({ config, storage, origin, cluster }) {
  const { masterDir, variantRe, variants, privatePaths } = config;

  return async function resolveMaster(reqRel, opts) {
    // Visibility sidecars are an internal record, never directly served.
    if (reqRel.endsWith(SIDECAR_EXT)) return { notFound: true };

    // Path-derived visibility — the cross-node authority for which peers may hold
    // this master (an explicit per-file override only travels with the bytes, so a
    // not-yet-present master is classified by its path).
    const visibility = isPrivateRel(reqRel, privatePaths) ? 'private' : 'public';

    // 1. Exact path (across all volumes).
    const exact = resolveSafe(masterDir, reqRel);
    if (!exact) return { forbidden: true };
    const exactRel = relOf(masterDir, exact);
    const exactHit = await storage.resolveRead(exactRel);
    if (exactHit) return { masterPath: exactHit.abs, stat: exactHit.stat, rel: exactRel };

    // Build the ordered list of candidate master rels (used for disk and origin).
    const candidates = [];
    const vm = variantRe.exec(path.basename(reqRel));
    if (vm) {
      const dir = path.dirname(reqRel);
      const restName = vm[2];                       // e.g. "x.webp"
      const reqExt = path.extname(restName).toLowerCase();
      for (const ext of candidateExts(reqExt)) {
        const abs = resolveSafe(masterDir, swapExt(path.join(dir, restName), ext));
        if (abs) candidates.push(relOf(masterDir, abs));
      }
      if (!opts.w) opts.w = variants[vm[1]]; // variant width (even if we go to origin)
    } else {
      candidates.push(exactRel); // direct request: master IS this path
    }

    // 2. Extension-swap across volumes.
    for (const rel of candidates) {
      const hit = await storage.resolveRead(rel);
      if (hit) return { masterPath: hit.abs, stat: hit.stat, rel };
    }

    // 3. Cluster peers (siblings) — pull from an eligible node for this visibility.
    if (cluster && cluster.enabled) {
      const got = await cluster.pull(candidates, visibility);
      if (got && got.stat && got.stat.isFile()) return { masterPath: got.path, stat: got.stat, rel: relOf(masterDir, got.path) };
    }

    // 4. Origin pull-through (external sources).
    if (origin && origin.enabled) {
      const got = await origin.fetchMaster(candidates);
      if (got && got.stat && got.stat.isFile()) return { masterPath: got.path, stat: got.stat, rel: relOf(masterDir, got.path) };
    }

    return { notFound: true };
  };
}

module.exports = { createMasterResolver };
