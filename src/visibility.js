'use strict';

/**
 * File visibility (public | private) for clustering decisions.
 *
 * Two sources, in priority order:
 *   1. An explicit per-file override, set via the `X-Visibility` header on upload
 *      and persisted in a small sidecar file next to the master (`<master>.vis`).
 *   2. The request path — anything under a configured PRIVATE_PATHS prefix is
 *      private; everything else is public.
 *
 * The path rule is the authority for cross-node decisions (replication targets,
 * pull-on-miss): it is stateless and every node derives the same answer from the
 * path alone, even for a master it does not yet hold. The sidecar override is
 * carried between nodes on the replication PUT (via the same header) so an
 * explicitly-marked master keeps its visibility wherever it lands.
 */

const fsp = require('fs/promises');
const { SIDECAR_EXT } = require('./constants');

// Segment-aware prefix match: rel "private/x.jpg" matches prefix "private",
// but "privatestuff/x.jpg" does NOT.
function isPrivateRel(rel, privatePaths) {
  if (!privatePaths || !privatePaths.length) return false;
  const r = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  return privatePaths.some((p) => r === p || r.startsWith(p + '/'));
}

// Normalize a free-form visibility string to 'public'/'private', or null if absent/unknown.
function normVisibility(v) {
  const s = String(v || '').toLowerCase();
  return s === 'private' ? 'private' : s === 'public' ? 'public' : null;
}

// Resolve a master's visibility for replication purposes: explicit header wins,
// else the path rule.
function visibilityFor(rel, headerVal, privatePaths) {
  return normVisibility(headerVal) || (isPrivateRel(rel, privatePaths) ? 'private' : 'public');
}

const sidecarPath = (masterPath) => masterPath + SIDECAR_EXT;

async function readSidecar(masterPath) {
  try { return normVisibility(await fsp.readFile(sidecarPath(masterPath), 'utf8')); }
  catch { return null; }
}

// Persist an explicit visibility next to the master (best-effort; a read-only
// MASTER_DIR just means no override is recorded).
async function writeSidecar(masterPath, visibility) {
  const v = normVisibility(visibility);
  if (!v) return;
  try { await fsp.writeFile(sidecarPath(masterPath), v); } catch { /* best-effort */ }
}

async function removeSidecar(masterPath) {
  try { await fsp.unlink(sidecarPath(masterPath)); } catch { /* may not exist */ }
}

module.exports = { isPrivateRel, normVisibility, visibilityFor, readSidecar, writeSidecar, removeSidecar };
