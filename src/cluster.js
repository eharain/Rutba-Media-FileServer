'use strict';

/**
 * Clustering: sibling media nodes that share MASTER files (resized variants are
 * always regenerated on demand, never synced).
 *
 * Nodes have a role — `public` (internet-facing) or `private` (local/LAN) — and
 * masters have a visibility (see src/visibility.js). The two combine into one rule:
 *
 *   peersFor(visibility):
 *     public master  -> every peer            (public content may live anywhere)
 *     private master -> only `private` peers, AND only when THIS node is private
 *                       (a public-zone node never replicates, accepts, or serves
 *                        private masters)
 *
 * That single rule drives both directions:
 *   - replicatePut/replicateDelete: a write fans out to peersFor(visibility) so a
 *     private/LAN node pushes its public uploads up to the public node(s), while a
 *     private upload stays within the private/LAN zone.
 *   - pull: a missing master is fetched from peersFor(visibility) — e.g. a private
 *     node asks the public node for a public master it does not have yet.
 *
 * Loop prevention: replicated writes carry X-Cluster-Replicated:1; a receiver that
 * sees it stores the master but does NOT fan out again. Node-to-node requests are
 * authenticated with CLUSTER_SECRET (X-Cluster-Secret).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const { fetchAndStore } = require('./fetchstore');
const { HDR_CLUSTER_SECRET, HDR_CLUSTER_REPLICATED, HDR_VISIBILITY } = require('./constants');

class Cluster {
  constructor({ role, peers, secret, masterDir, cacheDir, timeoutMs }) {
    this.role = role === 'private' ? 'private' : 'public';
    this.peers = Array.isArray(peers) ? peers : [];
    this.secret = secret || '';
    this.masterDir = masterDir;
    this.cacheDir = cacheDir;
    this.timeoutMs = timeoutMs || 10000;
    this.enabled = this.peers.length > 0;
    this.inflight = new Map(); // key -> Promise (de-dupe concurrent cold pulls)
  }

  // Peers eligible to hold / serve a master of this visibility (see file header).
  peersFor(visibility) {
    if (visibility === 'private') {
      if (this.role !== 'private') return []; // public-zone nodes never touch private masters
      return this.peers.filter((p) => p.role === 'private');
    }
    return this.peers; // public masters can live on any peer
  }

  _headers(extra) {
    const h = { ...(extra || {}) };
    if (this.secret) h[HDR_CLUSTER_SECRET] = this.secret;
    return h;
  }

  // Pull a missing master from eligible peers (first candidate rel + first peer
  // that has it wins); persist it locally. Returns { path, rel, stat } or null.
  async pull(rels, visibility) {
    const bases = this.peersFor(visibility).map((p) => p.url);
    if (!bases.length) return null;
    for (const rel of rels) {
      const key = visibility + '\0' + rel;
      let p = this.inflight.get(key);
      if (!p) {
        p = fetchAndStore({
          bases, rel, headers: this._headers(), masterDir: this.masterDir,
          cacheDir: this.cacheDir, timeoutMs: this.timeoutMs, label: 'cluster',
        }).finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
      }
      const hit = await p;
      if (hit) { console.log(`[media] cluster: pulled ${rel} from ${hit.base}`); return hit; }
    }
    return null;
  }

  // Replicate a freshly-stored master to eligible peers (fire-and-forget). Masters
  // only; the receiver regenerates variants on demand.
  replicatePut(rel, absPath, visibility) {
    for (const peer of this.peersFor(visibility)) this._put(peer, rel, absPath, visibility).catch(() => {});
  }

  async _put(peer, rel, absPath, visibility) {
    let stat;
    try { stat = await fsp.stat(absPath); } catch { return; }
    const url = peer.url + '/' + encodeURI(rel);
    const headers = this._headers({
      [HDR_CLUSTER_REPLICATED]: '1',
      [HDR_VISIBILITY]: visibility,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: 'PUT', headers, body: fs.createReadStream(absPath), duplex: 'half', signal: ac.signal });
      if (res && res.ok) console.log(`[media] cluster: replicated ${rel} -> ${peer.url}`);
      else console.warn(`[media] cluster: replicate PUT ${rel} -> ${peer.url} (${res ? res.status : 'no response'})`);
    } catch (e) {
      console.warn(`[media] cluster: replicate PUT ${rel} -> ${peer.url} failed: ${e && e.message || e}`);
    } finally { clearTimeout(timer); }
  }

  replicateDelete(rel, visibility) {
    for (const peer of this.peersFor(visibility)) this._delete(peer, rel).catch(() => {});
  }

  async _delete(peer, rel) {
    const url = peer.url + '/' + encodeURI(rel);
    const headers = this._headers({ [HDR_CLUSTER_REPLICATED]: '1' });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: 'DELETE', headers, signal: ac.signal });
      if (res && res.ok) console.log(`[media] cluster: replicated DELETE ${rel} -> ${peer.url}`);
    } catch { /* best-effort */ } finally { clearTimeout(timer); }
  }
}

module.exports = { Cluster };
