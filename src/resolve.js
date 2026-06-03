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
 *   3. Origin pull-through — if still missing and origins are configured, download
 *      the master (trying the same candidate rels) and persist it, then serve.
 *
 * Returns one of:
 *   { masterPath, stat }   resolved
 *   { forbidden: true }    path escaped MASTER_DIR
 *   { notFound: true }     nothing matched
 * and may set `opts.w` to the variant width when a prefix matched.
 */

const fsp = require('fs/promises');
const path = require('path');
const { resolveSafe, relOf, swapExt } = require('./util');
const { MASTER_EXTS } = require('./constants');

const statFile = (p) => fsp.stat(p).catch(() => null);

// Requested extension first (so an exact-format master is preferred), then the
// rest of the known master extensions, de-duplicated.
function candidateExts(reqExt) {
  const out = [];
  const push = (e) => { if (e && !out.includes(e)) out.push(e); };
  push(reqExt);
  for (const e of MASTER_EXTS) push(e);
  return out;
}

function createMasterResolver({ config, origin }) {
  const { masterDir, variantRe, variants } = config;

  return async function resolveMaster(reqRel, opts) {
    // 1. Exact path.
    const exact = resolveSafe(masterDir, reqRel);
    if (!exact) return { forbidden: true };
    const exactStat = await statFile(exact);
    if (exactStat && exactStat.isFile()) return { masterPath: exact, stat: exactStat };

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
      candidates.push(relOf(masterDir, exact)); // direct request: master IS this path
    }

    // 2. Extension-swap on disk.
    for (const rel of candidates) {
      const abs = resolveSafe(masterDir, rel);
      const st = abs ? await statFile(abs) : null;
      if (st && st.isFile()) return { masterPath: abs, stat: st };
    }

    // 3. Origin pull-through.
    if (origin && origin.enabled) {
      const got = await origin.fetchMaster(candidates);
      if (got && got.stat && got.stat.isFile()) return { masterPath: got.path, stat: got.stat };
    }

    return { notFound: true };
  };
}

module.exports = { createMasterResolver };
