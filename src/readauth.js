'use strict';

/**
 * Read authorization — the enforcement behind `READ_AUTH_MODE`.
 *
 * The setting was parsed and then read by nothing, so `READ_AUTH_MODE=private`
 * booted cleanly and left every master world-readable: a configuration that says
 * "locked down" and behaves the opposite way. Three modes now actually mean
 * something:
 *
 *   public  (default) — reads are open to everyone. Byte-for-byte the original
 *                       origin; this module short-circuits and costs nothing.
 *   mixed             — public-visibility masters stay open; `private` ones need an
 *                       authenticated, permitted caller.
 *   private           — every read needs one.
 *
 * WHO COUNTS AS PERMITTED (the grants, in the order they are cheapest to check):
 *
 *   1. `X-Cluster-Secret` — a sibling node. Cluster pull-on-miss is a GET against a
 *      peer; without this grant, turning on private reads would silently break
 *      replication topologies.
 *   2. `UPLOAD_TOKEN` (Authorization: Bearer, or the X-Upload-Token fallback) — the
 *      Strapi provider and the migration script. They already write with it; a mode
 *      change must not cut off the integration that populates the store.
 *   3. A platform session or API token with `viewer` or above.
 *
 * NOT handled here, deliberately: share links. `/_s/<token>` is its own namespace
 * that streams the file directly, and a share IS the explicit grant — that is what
 * makes it the right way to hand out a private file without handing out credentials.
 */

const { HDR_CLUSTER_SECRET, HDR_UPLOAD_TOKEN } = require('./constants');

function createReadGuard({ config, auth = null }) {
  const mode = config.readAuthMode || 'public';
  const enabled = mode !== 'public';

  // In `private` mode the caller must be permitted regardless of the file, so the
  // check can run before the master is even resolved.
  const checksBeforeResolve = mode === 'private';

  async function permitted(req) {
    if (config.clusterSecret && req.headers[HDR_CLUSTER_SECRET] === config.clusterSecret) return 'cluster';
    if (config.uploadToken) {
      if (req.headers.authorization === `Bearer ${config.uploadToken}`) return 'upload_token';
      if (req.headers[HDR_UPLOAD_TOKEN] === config.uploadToken) return 'upload_token';
    }
    if (auth) {
      const ctx = await auth.authenticate(req).catch(() => null);
      // Any role at all is enough to read; `viewer` is the floor, not a filter.
      if (ctx && ctx.roles && ctx.roles.length) return 'user';
    }
    return null;
  }

  return {
    mode,
    enabled,
    checksBeforeResolve,

    /**
     * Decide whether `req` may read a master of `visibility`.
     * Returns null when allowed, or { status, message } describing the refusal.
     *
     * A refusal is 401 (not 403): the caller may well have credentials and simply
     * did not send them, and 401 is what makes a WWW-Authenticate-capable client or
     * a script retry with its token.
     */
    async deny(req, visibility) {
      if (!enabled) return null;
      if (mode === 'mixed' && visibility !== 'private') return null;
      if (await permitted(req)) return null;
      return {
        status: 401,
        message: mode === 'private'
          ? 'Authentication required to read from this server'
          : 'Authentication required to read this file',
      };
    },
  };
}

module.exports = { createReadGuard };
