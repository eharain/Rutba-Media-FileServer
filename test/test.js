'use strict';
/**
 * Self-contained test suite for the media service + Strapi provider.
 * Spawns ../server.js, drives it with the provider and raw HTTP, asserts behavior.
 *
 *   cd test && npm install && node test.js
 *
 * Requires: sharp (test dep). Node >= 18 (global fetch).
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const sharp = require('sharp');
const provider = require('../provider/index.js');

const PORT = 8731;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-123';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediasrv-'));
const MASTER_DIR = path.join(tmp, 'masters');
const CACHE_DIR = path.join(tmp, 'cache');
fs.mkdirSync(MASTER_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };
const bad = (name, e) => { fail++; console.error(`  ✗ ${name}: ${e && e.message || e}`); };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const status = async (u, o) => (await fetch(u, o)).status;
const dim = async (u, o) => { const r = await fetch(u, o); const b = Buffer.from(await r.arrayBuffer()); const m = await sharp(b).metadata(); return { code: r.status, ...m, bytes: b.length, ct: r.headers.get('content-type') }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll an async predicate until truthy (for fire-and-forget replication).
const waitFor = async (fn, tries = 50, gap = 50) => { for (let i = 0; i < tries; i++) { try { if (await fn()) return true; } catch {} await sleep(gap); } return false; };
const waitHealth = async (base) => { for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/_health')).ok) return; } catch {} await sleep(100); } };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MASTER_DIR, CACHE_DIR, UPLOAD_TOKEN: TOKEN, CACHE_MAX_BYTES: '60000', UPLOAD_MAX_BYTES: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.env.DEBUG && console.error('[srv]', d.toString()));

  // wait for health
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/_health')).ok) break; } catch {} await sleep(100); }

  try {
    await t('health 200 ok', async () => { const r = await fetch(BASE + '/_health'); assert.equal(r.status, 200); assert.equal(await r.text(), 'ok'); });

    // provider round-trip
    const p = provider.init({ baseUrl: BASE, uploadToken: TOKEN });
    const master = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 60, b: 60 } } }).jpeg({ quality: 90 }).toBuffer();

    await t('provider stores master', async () => {
      const f = { hash: 'photoA', ext: '.jpg', mime: 'image/jpeg', path: 'general/cover', buffer: master };
      await p.upload(f);
      assert.equal(f.url, `${BASE}/general/cover/photoA.jpg`);
      assert.ok(fs.existsSync(path.join(MASTER_DIR, 'general/cover/photoA.jpg')), 'master on disk');
    });
    await t('provider skips variant bytes -> master?w=', async () => {
      const f = { hash: 'thumbnail_photoA', ext: '.webp', mime: 'image/webp', path: null, width: 245, height: 163, buffer: master };
      await p.upload(f);
      assert.equal(f.url, `${BASE}/general/cover/photoA.jpg?w=245&fm=webp`);
      assert.ok(!fs.existsSync(path.join(MASTER_DIR, 'thumbnail_photoA.webp')), 'variant not stored');
    });

    await t('GET master full size', async () => { const d = await dim(`${BASE}/general/cover/photoA.jpg`); assert.equal(d.code, 200); assert.equal(d.width, 1200); assert.equal(d.height, 800); });
    await t('resize ?w=100 keeps aspect, no upscale', async () => { const d = await dim(`${BASE}/general/cover/photoA.jpg?w=100`); assert.equal(d.width, 100); assert.equal(d.height, 67); });
    await t('format ?fm=webp', async () => { const d = await dim(`${BASE}/general/cover/photoA.jpg?w=200&fm=webp`); assert.equal(d.format, 'webp'); assert.equal(d.width, 200); });
    await t('provider variant URL resolves (245 webp)', async () => { const d = await dim(`${BASE}/general/cover/photoA.jpg?w=245&fm=webp`); assert.equal(d.format, 'webp'); assert.equal(d.width, 245); });

    // service-native Strapi prefix (same dir/name)
    await t('strapi prefix small_ resolves', async () => {
      const f = { hash: 'pic', ext: '.jpg', mime: 'image/jpeg', buffer: master };
      // upload a root master "pic.jpg" without the provider's variant skipping
      await fetch(`${BASE}/pic.jpg`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: master });
      const d = await dim(`${BASE}/small_pic.jpg`); assert.equal(d.code, 200); assert.equal(d.width, 500);
    });
    await t('strapi prefix xsmall_ resolves (64)', async () => {
      const d = await dim(`${BASE}/xsmall_pic.jpg`); assert.equal(d.code, 200); assert.equal(d.width, 64);
    });
    // extension-swap: variant requested as .webp, master is .jpg → locate master,
    // serve resized in the MASTER's own format (no transcode).
    await t('strapi prefix ext-swap (small_pic.webp -> pic.jpg @500, kept jpeg)', async () => {
      const d = await dim(`${BASE}/small_pic.webp`); assert.equal(d.code, 200); assert.equal(d.width, 500); assert.equal(d.format, 'jpeg');
    });

    // video range
    await t('video Range -> 206', async () => {
      const vid = Buffer.alloc(65536, 1);
      await fetch(`${BASE}/clip.mp4`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: vid });
      const r = await fetch(`${BASE}/clip.mp4`, { headers: { Range: 'bytes=0-1023' } });
      assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 0-1023/65536');
    });

    // auth
    await t('PUT without token -> 401', async () => { assert.equal(await status(`${BASE}/x.jpg`, { method: 'PUT', body: 'x' }), 401); });
    await t('DELETE without token -> 401', async () => { assert.equal(await status(`${BASE}/general/cover/photoA.jpg`, { method: 'DELETE' }), 401); });

    // upload size limit (cap 100000 bytes via UPLOAD_MAX_BYTES)
    await t('PUT over size limit -> 413', async () => {
      const big = Buffer.alloc(150000, 7);
      assert.equal(await status(`${BASE}/big.bin`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: big }), 413);
      assert.ok(!fs.existsSync(path.join(MASTER_DIR, 'big.bin')), 'oversize upload not stored');
    });

    // traversal / app-file protection
    await t('app file blocked', async () => { assert.equal(await status(`${BASE}/server.js`), 404); });
    await t('missing -> 404', async () => { assert.equal(await status(`${BASE}/nope.png`), 404); });

    // LRU eviction (cap 60000 bytes); generate many distinct variants of the master
    await t('LRU keeps cache under cap', async () => {
      for (let w = 100; w <= 800; w += 20) { await fetch(`${BASE}/general/cover/photoA.jpg?w=${w}`); }
      await sleep(200);
      let total = 0; for (const f of fs.readdirSync(CACHE_DIR)) { try { total += fs.statSync(path.join(CACHE_DIR, f)).size; } catch {} }
      assert.ok(total <= 60000 * 1.25, `cache total ${total} should be ~<= cap`);
    });

    // delete via provider purges master
    await t('provider.delete removes master', async () => {
      await p.delete({ hash: 'photoA', ext: '.jpg', path: 'general/cover' });
      assert.equal(await status(`${BASE}/general/cover/photoA.jpg`), 404);
    });
  } finally {
    srv.kill();
  }

  // ── origin pull-through (separate media server + mock origin) ──────────────
  await (async () => {
    const PORT2 = 8732, BASE2 = `http://127.0.0.1:${PORT2}`;
    const M2 = path.join(tmp, 'm2'), C2 = path.join(tmp, 'c2');
    fs.mkdirSync(M2, { recursive: true });
    const masterJpg = await sharp({ create: { width: 1000, height: 600, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg({ quality: 90 }).toBuffer();

    // Mock origin: serves a few masters (only as .jpg), 404 for anything else.
    const ORIGIN_FILES = { '/orig.jpg': masterJpg, '/deep/o2.jpg': masterJpg, '/swap.jpg': masterJpg };
    const origin = http.createServer((req, res) => {
      const body = ORIGIN_FILES[req.url.split('?')[0]];
      if (body) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(body); }
      else { res.writeHead(404); res.end('nope'); }
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const oport = origin.address().port;

    const srv2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT2), HOST: '127.0.0.1', MASTER_DIR: M2, CACHE_DIR: C2, UPLOAD_TOKEN: TOKEN, ORIGIN_SOURCES: `http://127.0.0.1:${oport}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv2.stderr.on('data', (d) => process.env.DEBUG && console.error('[srv2]', d.toString()));
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE2 + '/_health')).ok) break; } catch {} await sleep(100); }

    try {
      await t('origin: missing master fetched, served & persisted', async () => {
        const d = await dim(`${BASE2}/orig.jpg`); assert.equal(d.code, 200); assert.equal(d.width, 1000);
        assert.ok(fs.existsSync(path.join(M2, 'orig.jpg')), 'master persisted from origin');
      });
      await t('origin: nested master fetched & resized (?w=200)', async () => {
        const d = await dim(`${BASE2}/deep/o2.jpg?w=200`); assert.equal(d.code, 200); assert.equal(d.width, 200);
        assert.ok(fs.existsSync(path.join(M2, 'deep', 'o2.jpg')), 'nested master persisted');
      });
      await t('origin: prefix + ext-swap fetch (small_swap.webp -> swap.jpg @500, kept jpeg)', async () => {
        const d = await dim(`${BASE2}/small_swap.webp`); assert.equal(d.code, 200); assert.equal(d.width, 500); assert.equal(d.format, 'jpeg');
        assert.ok(fs.existsSync(path.join(M2, 'swap.jpg')), 'master located via ext-swap & persisted');
      });
      await t('origin: not present at origin -> 404', async () => { assert.equal(await status(`${BASE2}/notthere.jpg`), 404); });
    } finally {
      srv2.kill();
      origin.close();
    }
  })();

  // ── clustering (two sibling nodes: public + private/LAN) ───────────────────
  await (async () => {
    const PORT_PUB = 8733, PORT_PRV = 8734;
    const BASE_PUB = `http://127.0.0.1:${PORT_PUB}`, BASE_PRV = `http://127.0.0.1:${PORT_PRV}`;
    const M_PUB = path.join(tmp, 'mpub'), C_PUB = path.join(tmp, 'cpub');
    const M_PRV = path.join(tmp, 'mprv'), C_PRV = path.join(tmp, 'cprv');
    fs.mkdirSync(M_PUB, { recursive: true }); fs.mkdirSync(M_PRV, { recursive: true });
    const SECRET = 'cluster-secret-xyz';
    const img = await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 120, g: 200, b: 90 } } }).jpeg({ quality: 90 }).toBuffer();

    // Public node lists the private node as a private peer; private node lists the public node.
    const pub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT_PUB), HOST: '127.0.0.1', MASTER_DIR: M_PUB, CACHE_DIR: C_PUB, UPLOAD_TOKEN: TOKEN,
        CLUSTER_ROLE: 'public', CLUSTER_SECRET: SECRET, CLUSTER_PEERS: `${BASE_PRV}|private`, PRIVATE_PATHS: 'private' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const prv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT_PRV), HOST: '127.0.0.1', MASTER_DIR: M_PRV, CACHE_DIR: C_PRV, UPLOAD_TOKEN: TOKEN,
        CLUSTER_ROLE: 'private', CLUSTER_SECRET: SECRET, CLUSTER_PEERS: `${BASE_PUB}|public`, PRIVATE_PATHS: 'private' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pub.stderr.on('data', (d) => process.env.DEBUG && console.error('[pub]', d.toString()));
    prv.stderr.on('data', (d) => process.env.DEBUG && console.error('[prv]', d.toString()));
    await waitHealth(BASE_PUB); await waitHealth(BASE_PRV);

    try {
      // A public upload to the private/LAN node replicates UP to the public node.
      await t('cluster: public master replicates private -> public', async () => {
        const r = await fetch(`${BASE_PRV}/team/cover.jpg`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: img });
        assert.equal(r.status, 201);
        const arrived = await waitFor(() => fs.existsSync(path.join(M_PUB, 'team/cover.jpg')));
        assert.ok(arrived, 'master replicated to public node disk');
        const d = await dim(`${BASE_PUB}/team/cover.jpg?w=200`); assert.equal(d.code, 200); assert.equal(d.width, 200);
      });

      // A private-visibility upload stays in the private zone — never sent to a public node.
      await t('cluster: private master stays off public node', async () => {
        const r = await fetch(`${BASE_PRV}/private/secret.jpg`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: img });
        assert.equal(r.status, 201);
        await sleep(400); // give any (incorrect) replication a chance to land
        assert.ok(!fs.existsSync(path.join(M_PUB, 'private/secret.jpg')), 'private master must NOT be on the public node');
        assert.ok(fs.existsSync(path.join(M_PRV, 'private/secret.jpg')), 'private master present on the private node');
        assert.equal(await status(`${BASE_PUB}/private/secret.jpg`), 404, 'public node refuses to serve/pull private master');
      });

      // Pull-on-miss: a master placed only on the public node is fetched by the private node.
      await t('cluster: missing public master pulled from peer', async () => {
        fs.writeFileSync(path.join(M_PUB, 'pullme.jpg'), img); // seed only on the public node, no replication
        assert.ok(!fs.existsSync(path.join(M_PRV, 'pullme.jpg')), 'not on private node yet');
        const d = await dim(`${BASE_PRV}/pullme.jpg?w=150`); assert.equal(d.code, 200); assert.equal(d.width, 150);
        assert.ok(await waitFor(() => fs.existsSync(path.join(M_PRV, 'pullme.jpg'))), 'pulled master persisted locally');
      });

      // Node-to-node auth: the cluster secret authorizes a write; a wrong/absent one is rejected.
      await t('cluster: X-Cluster-Secret authorizes write, bad secret 401', async () => {
        const okR = await fetch(`${BASE_PUB}/viacluster.jpg`, { method: 'PUT', headers: { 'X-Cluster-Secret': SECRET, 'X-Cluster-Replicated': '1' }, body: img });
        assert.equal(okR.status, 201);
        const badR = await fetch(`${BASE_PUB}/nope.jpg`, { method: 'PUT', headers: { 'X-Cluster-Secret': 'wrong' }, body: img });
        assert.equal(badR.status, 401);
      });
    } finally {
      pub.kill(); prv.kill();
    }
  })();

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
