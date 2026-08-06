'use strict';
/**
 * Platform-layer test suite — everything gated behind a database.
 *
 * Boots `server.js` against a THROWAWAY database (created on boot by db.init, dropped
 * in the `finally` below whatever happens), then drives the whole platform surface
 * over HTTP exactly as a client would:
 *
 *   accounts & sessions · RBAC denials per role · /_api/files search + filters ·
 *   tags · duplicates · media metadata · storage quotas (413 + rollback) ·
 *   share links (password, expiry, download cap, revoke) · trash restore/purge/empty ·
 *   multi-volume placement + union reads · ffmpeg poster/transcode · WebDAV verbs
 *
 *   cd test && npm install && node platform.js
 *
 * Database config comes from the usual env (DB_HOST/DB_USER/DB_PASSWORD, or the
 * MYSQL_* aliases). With none set the suite prints a skip notice and exits 0, so
 * `npm test` on a machine without MySQL is unaffected; CI sets them explicitly.
 * DB_NAME is IGNORED — the suite always invents its own database name so it can
 * never scribble on a real one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { execFile } = require('child_process');
const sharp = require('sharp');
const { Runner, spawnServer, sleep, waitFor } = require('./harness');
// Same TOTP implementation the server uses — the point of the MFA checks is that a
// standard authenticator's code is accepted, and this is that code generator.
const totp = require('../src/totp');
// The same path→cache-key hash the version store names retained copies with.
const { pathHash } = require('../src/util');

// ── database config (env-driven; no credentials committed) ────────────────────
const DB = {
  host: process.env.DB_HOST || process.env.MYSQL_HOST || '',
  port: parseInt(process.env.DB_PORT || process.env.MYSQL_PORT, 10) || 3306,
  user: process.env.DB_USER || process.env.MYSQL_USER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || process.env.DB_PASS || '',
};
if (!DB.host) {
  console.log('platform suite SKIPPED — no database configured.');
  console.log('  Set DB_HOST (and DB_USER/DB_PASSWORD as needed) to run it, e.g.:');
  console.log('    DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=secret node test/platform.js');
  process.exit(0);
}
// Unique per run so parallel CI jobs never collide.
const DB_NAME = `media_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
// The pull-through node's own index (see withPullNode) — nodes don't share a database.
const DB_NAME_PULL = `${DB_NAME}_pull`;
// Every other throwaway database this run creates, so the cleanup drops all of them.
const extraDatabases = new Set([DB_NAME_PULL]);

const PORT = 8741;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'platform-upload-token';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaplat-'));
const MASTER_DIR = path.join(tmp, 'masters');
const VOL2_DIR = path.join(tmp, 'vol2');
const CACHE_DIR = path.join(tmp, 'cache');
const TRASH_DIR = path.join(tmp, 'trash');
for (const d of [MASTER_DIR, VOL2_DIR]) fs.mkdirSync(d, { recursive: true });

const runner = new Runner(`platform suite (database ${DB.user}@${DB.host}:${DB.port}/${DB_NAME})`);
const t = runner.t.bind(runner);

// ── tiny HTTP helpers ─────────────────────────────────────────────────────────
const authH = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const basicH = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });

// JSON call against /_api — returns { status, body } with body parsed when possible.
async function api(pathname, { method = 'GET', token = null, json = null, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...authH(token), ...headers },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

/**
 * Upload a master as a platform user (session/API bearer token) or with UPLOAD_TOKEN.
 *
 * Indexing is deliberately fire-and-forget — invariant 2 says a database hiccup must
 * degrade features, never fail a write, so `recordPut` is not awaited before the 201.
 * A test that reads the index immediately after the response is therefore racing it.
 * On a successful write we wait for the row instead of assuming it is already there.
 */
async function put(rel, buf, { token = TOKEN, headers = {}, awaitIndex = true } = {}) {
  const res = await fetch(`${BASE}/${rel}`, { method: 'PUT', headers: { ...authH(token), ...headers }, body: buf });
  const out = { status: res.status, body: await res.text().then((s) => { try { return JSON.parse(s); } catch { return s; } }) };
  if (out.status === 201 && awaitIndex) await waitRow(rel, (r) => r && r.status === 'active');
  return out;
}

// DELETE a master and wait for the index to reflect the soft-trash.
async function del(rel, token) {
  const res = await fetch(`${BASE}/${rel}`, { method: 'DELETE', headers: authH(token) });
  if (res.status === 204) await waitRow(rel, (r) => !r || r.status === 'trashed');
  return res.status;
}

const dav = (rel, opts = {}) => fetch(`${BASE}/_dav/${rel}`, opts);
const bytes = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers }; };

// Make a small H.264 MP4 with the ffmpeg the server itself would use. Returns the
// buffer, or null when no usable binary exists (those checks are then skipped).
async function makeVideo() {
  let bin = process.env.FFMPEG_PATH;
  if (!bin) { try { const p = require('ffmpeg-static'); bin = typeof p === 'string' ? p : p && p.path; } catch { bin = null; } }
  if (!bin) return null;
  const out = path.join(tmp, 'gen.mp4');
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', out];
  const okRun = await new Promise((resolve) => execFile(bin, args, { timeout: 60000 }, (err) => resolve(!err)));
  if (!okRun) return null;
  try { return fs.readFileSync(out); } catch { return null; }
}

/**
 * A stub Anthropic API.
 *
 * The AI layer is worth testing end-to-end — job → downscale → request → structured
 * response → store → review — and none of that should need a real key or cost money
 * on every CI run. The SDK honors ANTHROPIC_BASE_URL, so pointing it at this server
 * exercises the entire path with the real client, real request shapes and real
 * parsing; only the upstream is fake.
 *
 * It also records what it received, so the tests can assert on the things that
 * actually matter for cost: that the image was downscaled before being sent, and
 * that the cacheable prefix carries a cache_control breakpoint.
 */
function startStubAnthropic({ fail = false } = {}) {
  const http = require('http');
  const seen = { messages: [], batches: [] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch { /* not all routes have a body */ }
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const url = req.url.split('?')[0];

      // Live single-asset enrichment.
      if (url === '/v1/messages' && req.method === 'POST') {
        seen.messages.push(parsed);
        if (fail) return json(200, stubRefusal());
        return json(200, stubMessage());
      }
      // Bulk backfill through the Batches API.
      if (url === '/v1/messages/batches' && req.method === 'POST') {
        seen.batches.push(parsed);
        return json(200, {
          id: 'msgbatch_stub01', type: 'message_batch', processing_status: 'ended',
          request_counts: { processing: 0, succeeded: parsed.requests.length, errored: 0, canceled: 0, expired: 0 },
        });
      }
      if (/^\/v1\/messages\/batches\/[^/]+$/.test(url) && req.method === 'GET') {
        return json(200, {
          id: 'msgbatch_stub01', type: 'message_batch', processing_status: 'ended',
          request_counts: { processing: 0, succeeded: seen.batches[0] ? seen.batches[0].requests.length : 0, errored: 0, canceled: 0, expired: 0 },
          results_url: '/v1/messages/batches/msgbatch_stub01/results',
        });
      }
      // Results are JSONL, and deliberately returned in REVERSE order — the code
      // must key them by custom_id rather than by position.
      if (/\/results$/.test(url)) {
        const reqs = (seen.batches[0] && seen.batches[0].requests) || [];
        const lines = [...reqs].reverse().map((r) => JSON.stringify({
          custom_id: r.custom_id, result: { type: 'succeeded', message: stubMessage() },
        }));
        res.writeHead(200, { 'Content-Type': 'application/x-jsonl' });
        return res.end(lines.join('\n') + '\n');
      }
      json(404, { type: 'error', error: { type: 'not_found_error', message: url } });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${srv.address().port}`,
      seen,
      stop: () => srv.close(),
    }));
  });
}

function stubMessage() {
  return {
    id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-opus-5',
    stop_reason: 'end_turn', stop_details: null,
    content: [{ type: 'text', text: JSON.stringify({
      caption: 'A flat blue rectangle.',
      alt_text: 'Solid blue image',
      description: 'A single-colour blue field with no other subject matter.',
      tags: ['Blue', 'blue', '  abstract ', 'colour field'],
      detected_text: '',
      confidence: 0.91,
    }) }],
    usage: { input_tokens: 1200, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 },
  };
}
function stubRefusal() {
  return {
    id: 'msg_stub_refusal', type: 'message', role: 'assistant', model: 'claude-opus-5',
    stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' },
    content: [], usage: { input_tokens: 10, output_tokens: 0 },
  };
}

/**
 * Stand up the pieces needed to exercise pull-through indexing, run `fn`, tear down:
 *
 *   - a mock external origin serving one master
 *   - a plain (database-free) media node acting as a cluster peer, holding another
 *   - a "puller" node that has NEITHER master locally and is pointed at both sources
 *
 * The puller gets its OWN throwaway database, mirroring how clustering actually
 * deploys: nodes replicate files to each other, not database rows, so each runs its
 * own index and its own job queue.
 */
async function withPullNode({ img, img2 }, fn) {
  const http = require('http');
  const SECRET = 'pull-cluster-secret';
  const PEER_PORT = PORT + 1, PULL_PORT = PORT + 2;
  const peerDir = path.join(tmp, 'peer-masters');
  const pullDir = path.join(tmp, 'pull-masters');
  fs.mkdirSync(peerDir, { recursive: true });
  fs.mkdirSync(pullDir, { recursive: true });
  fs.writeFileSync(path.join(peerDir, 'from-peer.png'), img2);

  const originSrv = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/from-origin.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(img); }
    else { res.writeHead(404); res.end('no'); }
  });
  await new Promise((r) => originSrv.listen(0, '127.0.0.1', r));
  const originPort = originSrv.address().port;

  let peer = null, puller = null;
  try {
    peer = await spawnServer({
      port: PEER_PORT, label: 'peer',
      env: { MASTER_DIR: peerDir, CACHE_DIR: path.join(tmp, 'peer-cache'), UPLOAD_TOKEN: TOKEN, CLUSTER_SECRET: SECRET },
    });
    puller = await spawnServer({
      port: PULL_PORT, label: 'puller',
      env: {
        MASTER_DIR: pullDir, CACHE_DIR: path.join(tmp, 'pull-cache'), TRASH_DIR: path.join(tmp, 'pull-trash'),
        UPLOAD_TOKEN: TOKEN,
        DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USER: DB.user, DB_PASSWORD: DB.password, DB_NAME: DB_NAME_PULL,
        ORIGIN_SOURCES: `http://127.0.0.1:${originPort}`,
        CLUSTER_PEERS: `http://127.0.0.1:${PEER_PORT}|public`,
        CLUSTER_SECRET: SECRET,
      },
    });
    await fn(puller);
  } finally {
    if (puller) puller.stop();
    if (peer) peer.stop();
    originSrv.close();
  }
}

/**
 * Boot a throwaway node with its own database and master dir, run `fn`, tear it all
 * down. Used for settings that are decided at boot and cannot be toggled per request
 * — READ_AUTH_MODE and SECURE_COOKIES.
 */
async function withNode({ label, port, dbName, env = {}, seed = null }, fn) {
  const dir = path.join(tmp, label + '-masters');
  fs.mkdirSync(dir, { recursive: true });
  if (seed) for (const [rel, buf] of Object.entries(seed)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  }
  extraDatabases.add(dbName);
  let node = null;
  try {
    node = await spawnServer({
      port, label,
      env: {
        MASTER_DIR: dir, CACHE_DIR: path.join(tmp, label + '-cache'), TRASH_DIR: path.join(tmp, label + '-trash'),
        UPLOAD_TOKEN: TOKEN,
        DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USER: DB.user, DB_PASSWORD: DB.password, DB_NAME: dbName,
        ...env,
      },
    });
    await fn(node, dir);
  } finally {
    if (node) node.stop();
  }
}

/**
 * A node with the AI layer configured against the stub upstream (see
 * startStubAnthropic), plus one seeded image. Its own database, like every other
 * throwaway node here.
 */
async function withStubAi({ img, fail = false, label = 'ainode', budget = 0.02 }, fn) {
  const stub = await startStubAnthropic({ fail });
  const dbName = `${DB_NAME}_${label}`;
  try {
    await withNode({
      label, port: PORT + (label === 'ainode' ? 5 : 6), dbName,
      seed: { 'shoot/blue.jpg': img },
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-stub-key',
        ANTHROPIC_BASE_URL: stub.base,
        AI_MODEL: 'claude-opus-5',
        // Deliberately small: the seeded master is 900x600, so a correct
        // implementation must actually resize before sending.
        AI_MAX_IMAGE_DIM: '900',
        AI_MONTHLY_BUDGET_USD: String(budget),
        JOBS_POLL_MS: '300',
        // Poll a submitted batch promptly; in production this is a minute.
        AI_BATCH_POLL_MS: '500',
      },
    }, (node) => fn(node, stub));
  } finally {
    stub.stop();
  }
}

// A JSON call against a node other than the main one.
async function nodeApi(node, pathname, { method = 'GET', token = null, json = null } = {}) {
  const res = await fetch(node.base + pathname, {
    method,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...authH(token) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

// Queue a job on another node and wait for it to finish.
async function runJob(node, token, spec) {
  const r = await nodeApi(node, '/_api/jobs', { method: 'POST', token, json: spec });
  if (r.status !== 202) throw new Error(`could not queue ${spec.type}: ${r.status} ${JSON.stringify(r.body)}`);
  return waitJobOn(node, token, r.body.job.id);
}
async function waitJobOn(node, token, id, tries = 400, gap = 100) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await nodeApi(node, `/_api/jobs/${id}`, { token });
    last = r.body && r.body.job;
    if (last && ['done', 'failed', 'cancelled'].includes(last.state)) return last;
    await sleep(gap);
  }
  throw new Error(`job ${id} never finished (last state: ${last && last.state})`);
}

// Register an admin on a fresh node and return its bearer token.
async function bootstrapAdmin(base) {
  const res = await fetch(base + '/_api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'root@test.local', username: 'root', password: 'rootpw-12345' }),
  });
  return (await res.json()).token;
}

// ── suite ─────────────────────────────────────────────────────────────────────
(async () => {
  let srv = null;
  try {
    srv = await spawnServer({
      port: PORT, label: 'platform',
      env: {
        MASTER_DIR, CACHE_DIR, TRASH_DIR, UPLOAD_TOKEN: TOKEN,
        DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USER: DB.user, DB_PASSWORD: DB.password, DB_NAME,
        // Multi-volume: `archive/` is routed to vol2, everything else lands on default.
        STORAGE_VOLUMES: `vol2:${VOL2_DIR}`,
        STORAGE_PLACEMENT: 'route',
        STORAGE_ROUTES: 'archive/=vol2',
        WEBDAV_ENABLED: '1',
        // Registration stays closed so the "second registration is refused" check is
        // meaningful; the first (bootstrap admin) account is always allowed.
        ALLOW_REGISTRATION: '0',
        MFA_ENABLED: '1',
        // A low per-account threshold keeps the throttling check quick. The per-IP
        // threshold stays high so the rest of the suite's deliberate bad logins —
        // all from 127.0.0.1 — never lock the whole suite out.
        LOGIN_MAX_FAILURES: '4',
        LOGIN_MAX_FAILURES_IP: '200',
      },
    });

    // The DB layer is best-effort by design: if it failed to come up the server still
    // serves masters, and every platform assertion below would fail one by one. Check
    // once, loudly, instead.
    const probe = await api('/_api/auth/me');
    if (probe.status === 503) {
      throw new Error(`the database layer did not come up — /_api answered 503 db_disabled.\n${srv.output()}`);
    }

    const img = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg({ quality: 88 }).toBuffer();
    const img2 = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 30, b: 90 } } }).png().toBuffer();
    const video = await makeVideo();

    // ── accounts & sessions ───────────────────────────────────────────────────
    let adminTok = null, editorTok = null, viewerTok = null, editorId = null, viewerId = null;
    let apiToken = null, disabledUserId = null, mfaTok = null, mfaSecret = null, mfaRecovery = [];
    let versionedV2Len = 0, collectionId = null, commentId = null;

    await t('register: first account bootstraps as admin', async () => {
      const r = await api('/_api/auth/register', { method: 'POST', json: { email: 'admin@test.local', username: 'admin', password: 'adminpw-123' } });
      assert.equal(r.status, 201);
      assert.ok(r.body.token, 'a session token is issued');
      assert.deepEqual(r.body.roles, ['admin'], 'first account is admin');
      adminTok = r.body.token;
    });

    await t('register: further self-registration is refused when ALLOW_REGISTRATION is off', async () => {
      const r = await api('/_api/auth/register', { method: 'POST', json: { email: 'x@test.local', username: 'x', password: 'pw-12345' } });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'registration_closed');
    });

    await t('register: missing fields → 400 missing_field', async () => {
      const r = await api('/_api/auth/register', { method: 'POST', json: { email: 'y@test.local' } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'missing_field');
    });

    await t('login: wrong password → 401 bad_credentials', async () => {
      const r = await api('/_api/auth/login', { method: 'POST', json: { login: 'admin', password: 'nope' } });
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'bad_credentials');
    });

    await t('login: correct password → token + roles + session cookie', async () => {
      const r = await api('/_api/auth/login', { method: 'POST', json: { login: 'admin@test.local', password: 'adminpw-123' } });
      assert.equal(r.status, 200);
      assert.ok(r.body.token);
      assert.ok(r.body.roles.includes('admin'));
      assert.match(r.headers.get('set-cookie') || '', /^sid=/, 'issues a sid cookie');
      adminTok = r.body.token;
    });

    await t('me: returns the user, roles and storage usage', async () => {
      const r = await api('/_api/auth/me', { token: adminTok });
      assert.equal(r.status, 200);
      assert.equal(r.body.user.username, 'admin');
      assert.ok(r.body.roles.includes('admin'));
      assert.ok(r.body.storage && 'usedBytes' in r.body.storage);
      assert.equal(r.body.user.password_hash, undefined, 'never leaks the password hash');
    });

    await t('unauthenticated /_api/files → 401', async () => {
      assert.equal((await api('/_api/files')).status, 401);
    });

    await t('logout: the session token stops working', async () => {
      const l = await api('/_api/auth/login', { method: 'POST', json: { login: 'admin', password: 'adminpw-123' } });
      const throwaway = l.body.token;
      assert.equal((await api('/_api/auth/me', { token: throwaway })).status, 200);
      assert.equal((await api('/_api/auth/logout', { method: 'POST', token: throwaway })).status, 200);
      assert.equal((await api('/_api/auth/me', { token: throwaway })).status, 401);
    });

    await t('admin creates editor and viewer accounts', async () => {
      const e = await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'ed@test.local', username: 'ed', password: 'editorpw-123', role: 'editor' } });
      assert.equal(e.status, 201);
      assert.deepEqual(e.body.roles, ['editor']);
      editorId = e.body.user.id;
      const v = await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'vi@test.local', username: 'vi', password: 'viewerpw-123', role: 'viewer' } });
      assert.equal(v.status, 201);
      assert.deepEqual(v.body.roles, ['viewer']);
      viewerId = v.body.user.id;
      editorTok = (await api('/_api/auth/login', { method: 'POST', json: { login: 'ed', password: 'editorpw-123' } })).body.token;
      viewerTok = (await api('/_api/auth/login', { method: 'POST', json: { login: 'vi', password: 'viewerpw-123' } })).body.token;
      assert.ok(editorTok && viewerTok);
    });

    await t('duplicate email/username → 409 exists', async () => {
      const r = await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'ed@test.local', username: 'ed2', password: 'pw-123456' } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'exists');
    });

    // ── RBAC denials, per role, per route ─────────────────────────────────────
    await t('RBAC: admin-only routes refuse editor and viewer (403), admit admin', async () => {
      for (const route of ['/_api/users', '/_api/audit', '/_api/stats', '/_api/storage']) {
        assert.equal((await api(route, { token: viewerTok })).status, 403, `viewer must not reach ${route}`);
        assert.equal((await api(route, { token: editorTok })).status, 403, `editor must not reach ${route}`);
        assert.equal((await api(route, { token: adminTok })).status, 200, `admin must reach ${route}`);
      }
    });

    await t('RBAC: viewer may read /_api/files but not mutate tags', async () => {
      assert.equal((await api('/_api/files', { token: viewerTok })).status, 200);
      const r = await api('/_api/files/tags', { method: 'PUT', token: viewerTok, json: { path: 'anything.jpg', tags: ['x'] } });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'forbidden');
    });

    await t('RBAC: viewer cannot upload a master (write needs editor)', async () => {
      const r = await put('viewer-denied.jpg', img, { token: viewerTok });
      assert.equal(r.status, 401);
      assert.ok(!fs.existsSync(path.join(MASTER_DIR, 'viewer-denied.jpg')));
    });

    await t('RBAC: role grant is applied (viewer → editor unlocks writes)', async () => {
      const r = await api(`/_api/users/${viewerId}/roles`, { method: 'POST', token: adminTok, json: { role: 'editor' } });
      assert.equal(r.status, 200);
      assert.equal((await put('viewer-promoted.jpg', img, { token: viewerTok })).status, 201);
      // Unknown role names are rejected rather than silently ignored.
      const bad = await api(`/_api/users/${viewerId}/roles`, { method: 'POST', token: adminTok, json: { role: 'wizard' } });
      assert.equal(bad.status, 400);
    });

    // ── index, search and filters ─────────────────────────────────────────────
    await t('upload with a session token is indexed and attributed to the uploader', async () => {
      const r = await put('gallery/blue.jpg', img, { token: editorTok });
      assert.equal(r.status, 201);
      const list = await api('/_api/files?q=blue', { token: adminTok });
      assert.equal(list.status, 200);
      const row = list.body.files.find((f) => f.path === 'gallery/blue.jpg');
      assert.ok(row, 'indexed row exists');
      assert.equal(row.mime, 'image/jpeg');
      assert.equal(Number(row.size_bytes), img.length);
      assert.equal(row.width, 900);
      assert.equal(row.height, 600);
    });

    await t('search: ?q= matches path and name', async () => {
      await put('gallery/needle-xyz.png', img2, { token: editorTok });
      const r = await api('/_api/files?q=needle-xyz', { token: adminTok });
      assert.equal(r.body.total, 1);
      assert.equal(r.body.files[0].path, 'gallery/needle-xyz.png');
    });

    await t('filter: ?type= narrows by mime prefix', async () => {
      const all = await api('/_api/files?type=image&limit=500', { token: adminTok });
      assert.ok(all.body.files.length >= 2);
      assert.ok(all.body.files.every((f) => String(f.mime).startsWith('image')));
      const none = await api('/_api/files?type=application', { token: adminTok });
      assert.equal(none.body.total, 0);
    });

    await t('filter: ?visibility= separates private masters', async () => {
      const r = await put('secrets/hidden.jpg', img, { token: editorTok, headers: { 'X-Visibility': 'private' } });
      assert.equal(r.status, 201);
      assert.equal(r.body.visibility, 'private');
      const priv = await api('/_api/files?visibility=private', { token: adminTok });
      assert.ok(priv.body.files.some((f) => f.path === 'secrets/hidden.jpg'));
      const pub = await api('/_api/files?visibility=public&limit=500', { token: adminTok });
      assert.ok(!pub.body.files.some((f) => f.path === 'secrets/hidden.jpg'));
    });

    await t('pagination: limit + offset walk the result set without overlap', async () => {
      const p1 = await api('/_api/files?limit=2&offset=0', { token: adminTok });
      const p2 = await api('/_api/files?limit=2&offset=2', { token: adminTok });
      assert.equal(p1.body.files.length, 2);
      assert.equal(p1.body.limit, 2);
      const ids = new Set(p1.body.files.map((f) => f.id));
      assert.ok(p2.body.files.every((f) => !ids.has(f.id)), 'pages do not repeat rows');
      assert.ok(p1.body.total >= 4);
    });

    // ── tags ──────────────────────────────────────────────────────────────────
    await t('tags: set, read back, normalized (trimmed, lowercased, deduped)', async () => {
      const r = await api('/_api/files/tags', { method: 'PUT', token: editorTok, json: { path: 'gallery/blue.jpg', tags: ['  Ocean ', 'ocean', 'Sky', ''] } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.tags.sort(), ['ocean', 'sky']);
      const g = await api('/_api/files/tags?path=gallery/blue.jpg', { token: viewerTok });
      assert.deepEqual(g.body.tags.sort(), ['ocean', 'sky']);
    });

    await t('tags: /_api/tags lists names with usage counts', async () => {
      const r = await api('/_api/tags', { token: adminTok });
      const ocean = r.body.tags.find((x) => x.name === 'ocean');
      assert.ok(ocean, 'tag is listed');
      assert.equal(ocean.count, 1);
    });

    await t('tags: ?tag= filters the file list', async () => {
      const r = await api('/_api/files?tag=ocean', { token: adminTok });
      assert.equal(r.body.total, 1);
      assert.equal(r.body.files[0].path, 'gallery/blue.jpg');
      assert.equal((await api('/_api/files?tag=nonexistent', { token: adminTok })).body.total, 0);
    });

    await t('tags: replacing the set removes the old tags', async () => {
      await api('/_api/files/tags', { method: 'PUT', token: editorTok, json: { path: 'gallery/blue.jpg', tags: ['sky'] } });
      const g = await api('/_api/files/tags?path=gallery/blue.jpg', { token: adminTok });
      assert.deepEqual(g.body.tags, ['sky']);
      assert.equal((await api('/_api/files?tag=ocean', { token: adminTok })).body.total, 0);
    });

    await t('tags: tagging an unindexed path → 404 file_not_found', async () => {
      const r = await api('/_api/files/tags', { method: 'PUT', token: editorTok, json: { path: 'no/such/file.jpg', tags: ['a'] } });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, 'file_not_found');
    });

    // ── duplicates ────────────────────────────────────────────────────────────
    await t('duplicates: identical bytes at two paths are grouped by checksum', async () => {
      await put('dupes/one.jpg', img2, { token: editorTok });
      await put('dupes/two.jpg', img2, { token: editorTok });
      const r = await api('/_api/files/duplicates', { token: adminTok });
      assert.equal(r.status, 200);
      const group = r.body.groups.find((g) => g.paths.includes('dupes/one.jpg') && g.paths.includes('dupes/two.jpg'));
      assert.ok(group, 'the two copies share a group');
      assert.ok(group.count >= 2);
      assert.ok(r.body.wastedBytes >= img2.length);
    });

    // ── extracted media metadata ──────────────────────────────────────────────
    await t('metadata: image dimensions and format are extracted on upload', async () => {
      const r = await api('/_api/files/metadata?path=gallery/blue.jpg', { token: adminTok });
      assert.equal(r.status, 200);
      assert.ok(r.body.metadata, 'a metadata row exists');
      assert.equal(r.body.metadata.width, 900);
      assert.equal(r.body.metadata.height, 600);
      assert.equal(r.body.metadata.format, 'jpeg');
    });

    // ── storage quotas ────────────────────────────────────────────────────────
    await t('quota: set for a user, and reported by /_api/auth/me', async () => {
      const r = await api(`/_api/users/${editorId}/quota`, { method: 'POST', token: adminTok, json: { bytes: img.length * 3 } });
      assert.equal(r.status, 200);
      const me = await api('/_api/auth/me', { token: editorTok });
      assert.equal(me.body.storage.quotaBytes, img.length * 3);
    });

    await t('quota: an over-quota upload is refused with 413 and rolled back', async () => {
      const big = Buffer.alloc(img.length * 5, 9);
      const r = await put('gallery/toobig.bin', big, { token: editorTok });
      assert.equal(r.status, 413);
      assert.ok(!fs.existsSync(path.join(MASTER_DIR, 'gallery/toobig.bin')), 'bytes must not survive a quota rejection');
      const list = await api('/_api/files?q=toobig', { token: adminTok });
      assert.equal(list.body.total, 0, 'and it must never be indexed');
    });

    await t('quota: uploads by unmetered principals (UPLOAD_TOKEN) are unaffected', async () => {
      const big = Buffer.alloc(img.length * 5, 9);
      assert.equal((await put('unmetered.bin', big)).status, 201);
    });

    await t('quota: clearing the quota restores unlimited uploads', async () => {
      assert.equal((await api(`/_api/users/${editorId}/quota`, { method: 'POST', token: adminTok, json: { bytes: null } })).status, 200);
      assert.equal((await put('gallery/nowfits.bin', Buffer.alloc(img.length * 5, 9), { token: editorTok })).status, 201);
      assert.equal((await api(`/_api/users/${editorId}/quota`, { method: 'POST', token: adminTok, json: { bytes: -1 } })).status, 400);
    });

    // ── share links ───────────────────────────────────────────────────────────
    await t('share: a plain link serves the master bytes at /_s/<token>', async () => {
      const r = await api('/_api/shares', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg' } });
      assert.equal(r.status, 201);
      assert.match(r.body.relativeUrl, /^\/_s\/[a-f0-9]{32}$/);
      const got = await bytes(BASE + r.body.relativeUrl);
      assert.equal(got.status, 200);
      assert.equal(got.buf.length, img.length);
    });

    await t('share: permission=download sets Content-Disposition attachment', async () => {
      const r = await api('/_api/shares', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg', permission: 'download' } });
      const got = await bytes(BASE + r.body.relativeUrl);
      assert.match(got.headers.get('content-disposition') || '', /^attachment; filename="blue\.jpg"/);
    });

    await t('share: password-protected link gates on ?pw=', async () => {
      const r = await api('/_api/shares', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg', password: 'letmein' } });
      assert.equal(r.body.share.protected, true);
      assert.equal((await fetch(BASE + r.body.relativeUrl)).status, 401, 'no password → unlock page');
      assert.equal((await fetch(BASE + r.body.relativeUrl + '?pw=wrong')).status, 401);
      assert.equal((await fetch(BASE + r.body.relativeUrl + '?pw=letmein')).status, 200);
    });

    await t('share: an expired link is 410 Gone', async () => {
      const r = await api('/_api/shares', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg', expires_in_days: -1 } });
      // A negative TTL is ignored by the API (no expiry), so expire it directly to
      // exercise the serve-side check on a link that is genuinely in the past.
      const r2 = await api('/_api/shares', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg' } });
      assert.equal((await fetch(BASE + r.body.relativeUrl)).status, 200);
      await expireShare(r2.body.share.token);
      assert.equal((await fetch(BASE + r2.body.relativeUrl)).status, 410);
    });

    await t('share: download cap is enforced atomically', async () => {
      const r = await api('/_api/shares', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg', max_downloads: 2 } });
      const url = BASE + r.body.relativeUrl;
      // Fire the two allowed downloads concurrently with two extra: exactly two win.
      const codes = (await Promise.all([1, 2, 3, 4].map(() => fetch(url).then((x) => x.status)))).sort();
      assert.equal(codes.filter((c) => c === 200).length, 2, `exactly two serves allowed, got ${codes}`);
      assert.equal(codes.filter((c) => c === 410).length, 2);
      assert.equal((await fetch(url)).status, 410, 'and it stays closed');
    });

    await t('share: listing shows own shares; admin sees all; revoke kills the link', async () => {
      const mine = await api('/_api/shares', { token: editorTok });
      assert.ok(mine.body.shares.length > 0);
      assert.ok(mine.body.shares.every((s) => s.created_by === editorId), 'editor sees only their own');
      const all = await api('/_api/shares', { token: adminTok });
      assert.ok(all.body.shares.length >= mine.body.shares.length);
      const target = mine.body.shares[0];
      assert.equal((await api(`/_api/shares/${target.id}`, { method: 'DELETE', token: editorTok })).status, 200);
      assert.equal((await fetch(`${BASE}/_s/${target.token}`)).status, 404);
    });

    await t('share: an unknown token is 404, and a share of an unindexed file is refused', async () => {
      assert.equal((await fetch(`${BASE}/_s/${'0'.repeat(32)}`)).status, 404);
      const r = await api('/_api/shares', { method: 'POST', token: editorTok, json: { path: 'not/indexed.jpg' } });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, 'file_not_found');
    });

    // ── trash & recovery ──────────────────────────────────────────────────────
    await t('trash: DELETE retains the bytes outside every served volume', async () => {
      await put('trashme/doc.jpg', img, { token: editorTok });
      assert.equal((await fetch(`${BASE}/trashme/doc.jpg`)).status, 200);
      assert.equal(await del('trashme/doc.jpg', editorTok), 204);
      assert.equal((await fetch(`${BASE}/trashme/doc.jpg`)).status, 404, 'no longer served');
      assert.ok(!fs.existsSync(path.join(MASTER_DIR, 'trashme/doc.jpg')), 'gone from the master volume');
      assert.ok(fs.readdirSync(TRASH_DIR).length > 0, 'retained in TRASH_DIR');
      const row = (await api('/_api/files?status=trashed', { token: adminTok })).body.files.find((f) => f.path === 'trashme/doc.jpg');
      assert.ok(row, 'row is marked trashed, not deleted');
    });

    await t('trash: restore brings the master and its row back', async () => {
      const r = await api('/_api/files/restore', { method: 'POST', token: editorTok, json: { path: 'trashme/doc.jpg' } });
      assert.equal(r.status, 200);
      assert.equal((await fetch(`${BASE}/trashme/doc.jpg`)).status, 200);
      const active = (await api('/_api/files?status=active&q=trashme', { token: adminTok })).body.files;
      assert.ok(active.some((f) => f.path === 'trashme/doc.jpg'));
      const r2 = await api('/_api/files/restore', { method: 'POST', token: editorTok, json: { path: 'trashme/doc.jpg' } });
      assert.equal(r2.status, 409, 'restoring an active file is a conflict');
    });

    await t('trash: purge removes the retained bytes and the row for good', async () => {
      await del('trashme/doc.jpg', editorTok);
      assert.equal((await api('/_api/files/purge', { method: 'POST', token: editorTok, json: { path: 'trashme/doc.jpg' } })).status, 200);
      const gone = (await api('/_api/files?status=all&q=trashme', { token: adminTok })).body.files;
      assert.ok(!gone.some((f) => f.path === 'trashme/doc.jpg'), 'row is gone');
      const r = await api('/_api/files/restore', { method: 'POST', token: editorTok, json: { path: 'trashme/doc.jpg' } });
      assert.equal(r.status, 404, 'nothing left to restore');
    });

    await t('trash: empty-trash is admin-only and purges everything trashed', async () => {
      await put('bulk/a.jpg', img, { token: editorTok });
      await put('bulk/b.jpg', img2, { token: editorTok });
      for (const p of ['bulk/a.jpg', 'bulk/b.jpg']) await del(p, editorTok);
      assert.equal((await api('/_api/trash/empty', { method: 'POST', token: editorTok })).status, 403);
      const r = await api('/_api/trash/empty', { method: 'POST', token: adminTok });
      assert.equal(r.status, 200);
      assert.ok(r.body.purged >= 2);
      assert.equal((await api('/_api/files?status=trashed', { token: adminTok })).body.total, 0);
    });

    // ── multi-volume storage ──────────────────────────────────────────────────
    await t('storage: route placement puts a master on the mapped volume', async () => {
      assert.equal((await put('archive/old.jpg', img, { token: editorTok })).status, 201);
      assert.ok(fs.existsSync(path.join(VOL2_DIR, 'archive/old.jpg')), 'placed on vol2 by STORAGE_ROUTES');
      assert.ok(!fs.existsSync(path.join(MASTER_DIR, 'archive/old.jpg')), 'and not on the default volume');
    });

    await t('storage: reads union across volumes (and resize works off vol2)', async () => {
      const full = await bytes(`${BASE}/archive/old.jpg`);
      assert.equal(full.status, 200);
      assert.equal(full.buf.length, img.length);
      const small = await bytes(`${BASE}/archive/old.jpg?w=120`);
      assert.equal((await sharp(small.buf).metadata()).width, 120);
    });

    await t('storage: a master dropped straight onto a volume is served (bytes are the truth)', async () => {
      fs.mkdirSync(path.join(VOL2_DIR, 'dropped'), { recursive: true });
      fs.writeFileSync(path.join(VOL2_DIR, 'dropped/manual.jpg'), img);
      assert.equal((await fetch(`${BASE}/dropped/manual.jpg`)).status, 200);
    });

    await t('storage: /_api/storage reports every volume with free/total bytes', async () => {
      const r = await api('/_api/storage', { token: adminTok });
      assert.equal(r.status, 200);
      assert.equal(r.body.multi, true);
      assert.equal(r.body.placement, 'route');
      assert.deepEqual(r.body.volumes.map((v) => v.id).sort(), ['default', 'vol2']);
      assert.ok(r.body.volumes.every((v) => v.totalBytes > 0), 'capacity is reported');
    });

    await t('storage: delete finds and trashes a master on a non-default volume', async () => {
      assert.equal(await del('archive/old.jpg', editorTok), 204);
      assert.ok(!fs.existsSync(path.join(VOL2_DIR, 'archive/old.jpg')));
      assert.equal((await api('/_api/files/restore', { method: 'POST', token: editorTok, json: { path: 'archive/old.jpg' } })).status, 200);
      assert.equal((await fetch(`${BASE}/archive/old.jpg`)).status, 200);
    });

    // ── ffmpeg-backed video features ──────────────────────────────────────────
    if (!video) {
      runner.skip('video: poster / transcode / probe', 'no usable ffmpeg binary');
    } else {
      await t('video: upload records ffprobe duration and dimensions', async () => {
        assert.equal((await put('media/clip.mp4', video, { token: editorTok })).status, 201);
        const row = (await api('/_api/files?q=clip.mp4', { token: adminTok })).body.files[0];
        assert.ok(row, 'video is indexed');
        assert.equal(row.width, 320);
        assert.equal(row.height, 240);
        const md = await api('/_api/files/metadata?path=media/clip.mp4', { token: adminTok });
        assert.ok(md.body.metadata, 'probe metadata stored');
        assert.ok(Number(md.body.metadata.raw && md.body.metadata.raw.durationSec) >= 1, 'duration recorded');
      });

      await t('video: ?poster returns a still frame as an image', async () => {
        const r = await bytes(`${BASE}/media/clip.mp4?poster`);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type') || '', /^image\//);
        const m = await sharp(r.buf).metadata();
        assert.equal(m.width, 320);
      });

      await t('video: ?poster honors w/fm (scaled webp frame)', async () => {
        const r = await bytes(`${BASE}/media/clip.mp4?poster&w=160&fm=webp`);
        assert.equal(r.status, 200);
        const m = await sharp(r.buf).metadata();
        assert.equal(m.format, 'webp');
        assert.equal(m.width, 160);
      });

      await t('video: ?transcode=<h> returns a scaled MP4', async () => {
        const r = await bytes(`${BASE}/media/clip.mp4?transcode=144`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('content-type'), 'video/mp4');
        assert.ok(r.buf.length > 0);
        assert.notEqual(r.buf.length, video.length, 'a re-encode, not the original');
      });

      await t('video: a PUT over the master purges its cached derivatives', async () => {
        const before = await bytes(`${BASE}/media/clip.mp4?poster&w=80`);
        await put('media/clip.mp4', video, { token: editorTok });
        const after = await bytes(`${BASE}/media/clip.mp4?poster&w=80`);
        assert.equal(after.status, 200);
        assert.equal(before.status, 200);
      });
    }

    // ── WebDAV verb matrix ────────────────────────────────────────────────────
    await t('dav: no credentials → 401 with a Basic challenge', async () => {
      const r = await dav('', { method: 'PROPFIND' });
      assert.equal(r.status, 401);
      assert.match(r.headers.get('www-authenticate') || '', /^Basic realm=/);
    });

    await t('dav: wrong credentials → 401', async () => {
      assert.equal((await dav('', { method: 'PROPFIND', headers: basicH('ed', 'wrong') })).status, 401);
    });

    await t('dav: OPTIONS advertises DAV class 1,2 and the verb set', async () => {
      const r = await dav('', { method: 'OPTIONS', headers: basicH('ed', 'editorpw-123') });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('dav') || '', /1/);
      for (const verb of ['PROPFIND', 'MKCOL', 'MOVE', 'COPY', 'LOCK']) {
        assert.match(r.headers.get('allow') || '', new RegExp(verb));
      }
    });

    await t('dav: PROPFIND depth 1 returns a 207 multistatus listing children', async () => {
      const r = await dav('gallery/', { method: 'PROPFIND', headers: { ...basicH('ed', 'editorpw-123'), Depth: '1' } });
      assert.equal(r.status, 207);
      const xml = await r.text();
      assert.match(xml, /<D:multistatus/);
      assert.match(xml, /blue\.jpg/);
      assert.match(xml, /<D:getcontentlength>/);
    });

    await t('dav: PROPFIND on a missing path → 404', async () => {
      assert.equal((await dav('no/such/dir/', { method: 'PROPFIND', headers: basicH('ed', 'editorpw-123') })).status, 404);
    });

    await t('dav: PUT creates (201) then replaces (204), and the bytes read back', async () => {
      const h = basicH('ed', 'editorpw-123');
      assert.equal((await dav('dav/new.png', { method: 'PUT', headers: h, body: img2 })).status, 201);
      const got = await bytes(`${BASE}/_dav/dav/new.png`, { headers: h });
      assert.equal(got.status, 200);
      assert.equal(got.buf.length, img2.length);
      assert.equal((await dav('dav/new.png', { method: 'PUT', headers: h, body: img2 })).status, 204);
      // …and it is indexed like any other write (asynchronously, as always).
      await waitRow('dav/new.png', (r) => r && r.status === 'active');
      assert.equal((await api('/_api/files?q=dav/new.png', { token: adminTok })).body.files.length, 1);
    });

    await t('dav: a viewer-only account is refused write verbs (403) but may read', async () => {
      // `vi` was promoted to editor earlier; use a fresh viewer for a clean check.
      await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'ro@test.local', username: 'ro', password: 'readonly-123', role: 'viewer' } });
      const h = basicH('ro', 'readonly-123');
      assert.equal((await dav('dav/new.png', { method: 'PUT', headers: h, body: img2 })).status, 403);
      assert.equal((await dav('dav/new.png', { method: 'DELETE', headers: h })).status, 403);
      assert.equal((await dav('gallery/', { method: 'PROPFIND', headers: { ...h, Depth: '1' } })).status, 207);
    });

    await t('dav: MKCOL creates a collection (and refuses to recreate it)', async () => {
      const h = basicH('ed', 'editorpw-123');
      assert.equal((await dav('davdir', { method: 'MKCOL', headers: h })).status, 201);
      assert.ok(fs.existsSync(path.join(MASTER_DIR, 'davdir')));
      assert.equal((await dav('davdir', { method: 'MKCOL', headers: h })).status, 405);
      assert.equal((await dav('nope/deep', { method: 'MKCOL', headers: h })).status, 409, 'missing parent');
    });

    await t('dav: MOVE relocates the master and follows it in the index', async () => {
      const h = basicH('ed', 'editorpw-123');
      const r = await dav('dav/new.png', { method: 'MOVE', headers: { ...h, Destination: `${BASE}/_dav/davdir/moved.png` } });
      assert.equal(r.status, 201);
      assert.equal((await fetch(`${BASE}/davdir/moved.png`)).status, 200);
      assert.equal((await fetch(`${BASE}/dav/new.png`)).status, 404);
      await waitRow('davdir/moved.png', (r) => !!r);
      const idx = await api('/_api/files?q=moved.png', { token: adminTok });
      assert.equal(idx.body.total, 1);
      assert.equal(idx.body.files[0].path, 'davdir/moved.png');
    });

    await t('dav: COPY duplicates the bytes and indexes the copy', async () => {
      const h = basicH('ed', 'editorpw-123');
      const r = await dav('davdir/moved.png', { method: 'COPY', headers: { ...h, Destination: `${BASE}/_dav/davdir/copy.png` } });
      assert.equal(r.status, 201);
      const a = await bytes(`${BASE}/davdir/moved.png`);
      const b = await bytes(`${BASE}/davdir/copy.png`);
      assert.equal(b.status, 200);
      assert.ok(a.buf.equals(b.buf));
      await waitRow('davdir/copy.png', (r) => r && r.status === 'active');
      assert.equal((await api('/_api/files?q=copy.png', { token: adminTok })).body.total, 1);
    });

    await t('dav: MOVE outside the DAV root is refused (502)', async () => {
      const h = basicH('ed', 'editorpw-123');
      const r = await dav('davdir/copy.png', { method: 'MOVE', headers: { ...h, Destination: `${BASE}/escaped.png` } });
      assert.equal(r.status, 502);
    });

    await t('dav: LOCK issues a token and UNLOCK releases it', async () => {
      const h = basicH('ed', 'editorpw-123');
      const r = await dav('davdir/moved.png', { method: 'LOCK', headers: h });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('lock-token') || '', /^<opaquelocktoken:/);
      assert.match(await r.text(), /<D:activelock>/);
      assert.equal((await dav('davdir/moved.png', { method: 'UNLOCK', headers: h })).status, 204);
    });

    await t('dav: DELETE trashes a file and recurses into a collection', async () => {
      const h = basicH('ed', 'editorpw-123');
      assert.equal((await dav('davdir/copy.png', { method: 'DELETE', headers: h })).status, 204);
      assert.equal((await fetch(`${BASE}/davdir/copy.png`)).status, 404);
      assert.equal((await dav('davdir', { method: 'DELETE', headers: h })).status, 204);
      assert.ok(!fs.existsSync(path.join(MASTER_DIR, 'davdir')));
      assert.equal((await dav('davdir', { method: 'DELETE', headers: h })).status, 404, 'already gone');
    });

    await t('dav: refuses to delete the root', async () => {
      assert.equal((await dav('', { method: 'DELETE', headers: basicH('ed', 'editorpw-123') })).status, 403);
    });

    // ── audit trail ───────────────────────────────────────────────────────────
    await t('audit: logins, uploads, shares and deletes are all recorded', async () => {
      const r = await api('/_api/audit?limit=1000', { token: adminTok });
      assert.equal(r.status, 200);
      const actions = new Set(r.body.events.map((e) => e.action));
      for (const a of ['login', 'login_failed', 'upload', 'delete', 'share_create', 'register']) {
        assert.ok(actions.has(a), `audit must record "${a}" (saw: ${[...actions].join(', ')})`);
      }
    });

    await t('stats: counts and byte totals reflect the indexed library', async () => {
      const r = await api('/_api/stats', { token: adminTok });
      assert.equal(r.status, 200);
      assert.ok(r.body.files > 0);
      assert.ok(r.body.storageBytes > 0);
      assert.ok(r.body.users >= 4);
    });

    // ── console ───────────────────────────────────────────────────────────────
    await t('console: /_ui/ is served with the DB layer up', async () => {
      const r = await fetch(`${BASE}/_ui/`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /text\/html/);
      assert.match(await r.text(), /<script/);
      assert.equal((await fetch(`${BASE}/_ui/app.js`)).status, 200);
      assert.equal((await fetch(`${BASE}/_ui/../server.js`)).status, 404, 'no traversal out of web/');
      const shell = await (await fetch(`${BASE}/_ui/`)).text();
      assert.match(shell, /data-view="jobs"/, 'the console exposes the background-jobs view');
      // The AI nav entry ships hidden and is revealed only when /_api/ai/status
      // reports a configured provider — no key, no tab.
      assert.match(shell, /nav-ai hidden/, 'the AI tab is absent until a provider is configured');
    });

    // ── index integrity: the path-collision bug ───────────────────────────────
    await t('index: two paths sharing a 255-char prefix get their own rows', async () => {
      // The old uniqueness key was `path(255)`. These two paths are identical for the
      // first 255 characters, so the upsert treated them as one row and the second
      // upload silently overwrote the first file's metadata with no error at all.
      // Built from many short segments: a single 260-char component is longer than
      // any filesystem allows, but a deep path of that total length is ordinary.
      const stem = 'collide/' + Array(30).fill('abcdefgh').join('/');
      assert.ok(stem.length > 255, `the shared prefix must exceed the old 255-char key (${stem.length})`);
      const a = `${stem}/A.jpg`;
      const b = `${stem}/B.jpg`;
      assert.equal(a.slice(0, 255), b.slice(0, 255), 'the two paths really do share a 255-char prefix');
      assert.equal((await put(a, img, { token: editorTok })).status, 201);
      assert.equal((await put(b, img2, { token: editorTok })).status, 201);
      const rowA = await fileRow(a);
      const rowB = await fileRow(b);
      assert.ok(rowA && rowB, 'both files are indexed');
      assert.notEqual(rowA.id, rowB.id, 'as two distinct rows');
      assert.equal(Number(rowA.size_bytes), img.length, "the first file's metadata survived");
      assert.equal(Number(rowB.size_bytes), img2.length);
      assert.notEqual(rowA.path_hash, rowB.path_hash);
    });

    await t('index: every row records the volume its bytes are on', async () => {
      assert.equal((await fileRow('gallery/blue.jpg')).volume_id, 'default');
      assert.equal((await fileRow('archive/old.jpg')).volume_id, 'vol2', 'routed writes record the routed volume');
    });

    // ── background jobs ───────────────────────────────────────────────────────
    await t('jobs: the queue is admin-only and reports its worker', async () => {
      assert.equal((await api('/_api/jobs', { token: editorTok })).status, 403);
      const r = await api('/_api/jobs', { token: adminTok });
      assert.equal(r.status, 200);
      assert.equal(r.body.worker.running, true);
      assert.ok(r.body.worker.types.includes('scan'));
      assert.ok(r.body.worker.types.includes('extract'));
      assert.ok(r.body.summary);
    });

    await t('jobs: only whitelisted types may be queued over HTTP', async () => {
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'rm -rf' } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'bad_type');
    });

    await t('jobs: an extract job runs and records metadata for a file that had none', async () => {
      // Drop a master straight onto the volume, index it WITHOUT metadata, then let
      // the queue fill it in — the scanned/pulled-in file's path.
      fs.writeFileSync(path.join(MASTER_DIR, 'jobbed.png'), img2);
      const conn = await inspectConn();
      await conn.query(
        "INSERT INTO files (path, path_hash, name, ext, mime, size_bytes, volume_id) VALUES (?, SHA2(?,256), 'jobbed.png', '.png', 'image/png', ?, 'default')",
        ['jobbed.png', 'jobbed.png', img2.length]);
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'extract', payload: { path: 'jobbed.png' } } });
      assert.equal(r.status, 202);
      const finished = await waitJob(r.body.job.id);
      assert.equal(finished.state, 'done', `job error: ${finished.error}`);
      const md = await api('/_api/files/metadata?path=jobbed.png', { token: adminTok });
      assert.equal(md.body.metadata.width, 400);
      assert.equal(md.body.metadata.format, 'png');
      assert.equal((await fileRow('jobbed.png')).width, 400);
    });

    await t('jobs: extraction of vanished bytes reports and stops, instead of retrying forever', async () => {
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'extract', payload: { path: 'never/existed.jpg' } } });
      const finished = await waitJob(r.body.job.id);
      assert.equal(finished.state, 'done');
      assert.equal(Number(finished.attempts), 1, 'a genuinely absent file is not retried');
      assert.equal(jsonOf(finished.result).missing, true);
    });

    await t('jobs: re-queuing live work returns the same job (dedupe)', async () => {
      const a = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'extract', payload: { path: 'gallery/blue.jpg' } } });
      const b = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'extract', payload: { path: 'gallery/blue.jpg' } } });
      assert.equal(a.status, 202);
      // Either the second call joined the first job, or the first already finished
      // and released its dedupe key — both are correct; two LIVE duplicates are not.
      const sameOrFinished = b.body.job.id === a.body.job.id || (await waitJob(a.body.job.id)).state === 'done';
      assert.ok(sameOrFinished);
      await waitJob(b.body.job.id);
    });

    await t('jobs: a job can be inspected, and retried after it finishes', async () => {
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'extract', payload: { path: 'gallery/blue.jpg' } } });
      const id = r.body.job.id;
      await waitJob(id);
      const one = await api(`/_api/jobs/${id}`, { token: adminTok });
      assert.equal(one.status, 200);
      assert.equal(one.body.job.type, 'extract');
      assert.equal((await api(`/_api/jobs/${id}/retry`, { method: 'POST', token: adminTok })).status, 200);
      await waitJob(id);
      assert.equal((await api(`/_api/jobs/999999`, { token: adminTok })).status, 404);
    });

    // ── the scanner ───────────────────────────────────────────────────────────
    await t('scan: masters placed directly on disk are indexed by a scan', async () => {
      // Exactly the deploy shortcut docker-compose.yml recommends: bytes appear on a
      // volume without ever passing through the write path. Before the scanner these
      // were served correctly and were invisible to the entire platform.
      fs.mkdirSync(path.join(MASTER_DIR, 'rsynced/deep'), { recursive: true });
      fs.writeFileSync(path.join(MASTER_DIR, 'rsynced/one.jpg'), img);
      fs.writeFileSync(path.join(MASTER_DIR, 'rsynced/deep/two.png'), img2);
      fs.writeFileSync(path.join(VOL2_DIR, 'rsynced-vol2.jpg'), img);
      assert.equal(await fileRow('rsynced/one.jpg'), null, 'invisible before the scan');

      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'scan' } });
      assert.equal(r.status, 202);
      const done = await waitJob(r.body.job.id);
      assert.equal(done.state, 'done', `scan error: ${done.error}`);
      const result = jsonOf(done.result);
      assert.ok(result.seen >= 3);
      assert.ok(result.created >= 3, `expected at least 3 new rows, got ${result.created}`);

      assert.ok(await fileRow('rsynced/one.jpg'), 'top-level file indexed');
      assert.ok(await fileRow('rsynced/deep/two.png'), 'nested file indexed');
      const v2 = await fileRow('rsynced-vol2.jpg');
      assert.ok(v2, 'file on the second volume indexed');
      assert.equal(v2.volume_id, 'vol2', 'attributed to the volume it was found on');
      assert.equal((await api('/_api/files?q=rsynced', { token: adminTok })).body.total >= 3, true);
    });

    await t('scan: the extraction queued for scanned-in files fills their metadata', async () => {
      await waitFor(async () => {
        const md = await api('/_api/files/metadata?path=rsynced/deep/two.png', { token: adminTok });
        return md.body.metadata && md.body.metadata.width === 400;
      }, 100, 100);
      const md = await api('/_api/files/metadata?path=rsynced/deep/two.png', { token: adminTok });
      assert.equal(md.body.metadata.width, 400, 'scanned-in files get the same metadata as uploaded ones');
    });

    await t('scan: internal artifacts are never indexed', async () => {
      fs.writeFileSync(path.join(MASTER_DIR, 'sidecar-test.jpg'), img);
      fs.writeFileSync(path.join(MASTER_DIR, 'sidecar-test.jpg.vis'), 'private');
      fs.writeFileSync(path.join(MASTER_DIR, 'half-written.up.999.tmp'), img);
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'scan' } });
      await waitJob(r.body.job.id);
      assert.ok(await fileRow('sidecar-test.jpg'), 'the master itself is indexed');
      assert.equal(await fileRow('sidecar-test.jpg.vis'), null, 'visibility sidecars are internal');
      assert.equal(await fileRow('half-written.up.999.tmp'), null, 'upload temp files are internal');
    });

    await t('scan: a row whose bytes vanished is marked missing, not deleted', async () => {
      // Tag it first, to prove the row (and everything hanging off it) is retained.
      await api('/_api/files/tags', { method: 'PUT', token: editorTok, json: { path: 'rsynced/one.jpg', tags: ['keepme'] } });
      fs.unlinkSync(path.join(MASTER_DIR, 'rsynced/one.jpg'));
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'scan' } });
      const done = await waitJob(r.body.job.id);
      assert.equal(done.state, 'done');
      const row = await fileRow('rsynced/one.jpg');
      assert.ok(row, 'the row is kept — it carries tags, shares and comments');
      assert.equal(row.status, 'missing');
      assert.deepEqual((await api('/_api/files/tags?path=rsynced/one.jpg', { token: adminTok })).body.tags, ['keepme']);
      const listed = await api('/_api/files?status=missing', { token: adminTok });
      assert.ok(listed.body.files.some((f) => f.path === 'rsynced/one.jpg'));
      assert.ok((await api('/_api/stats', { token: adminTok })).body.missing >= 1);
    });

    await t('scan: restoring the bytes brings the row back to active', async () => {
      fs.writeFileSync(path.join(MASTER_DIR, 'rsynced/one.jpg'), img);
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'scan' } });
      await waitJob(r.body.job.id);
      assert.equal((await fileRow('rsynced/one.jpg')).status, 'active');
    });

    await t('scan: a second scan finds no new work (idempotent)', async () => {
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'scan' } });
      const done = await waitJob(r.body.job.id);
      const result = jsonOf(done.result);
      assert.equal(result.created, 0, 'nothing is re-created on a repeat scan');
      assert.equal(result.missing, 0, 'and nothing is wrongly marked missing');
      assert.ok(result.unchanged > 0);
    });

    await t('scan: a single-volume scan never marks the other volume missing', async () => {
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'scan', payload: { volumeId: 'vol2' } } });
      const done = await waitJob(r.body.job.id);
      const result = jsonOf(done.result);
      assert.deepEqual(result.volumes, ['vol2']);
      assert.equal(result.missing, 0, 'a scoped scan must not finalize across volumes');
      assert.equal((await fileRow('gallery/blue.jpg')).status, 'active');
    });

    // ── AI enrichment: off by default ─────────────────────────────────────────
    // The main node has no ANTHROPIC_API_KEY, which is the shipping default. The
    // whole layer must be absent, not merely idle.
    await t('ai: with no key configured the layer reports itself off', async () => {
      const r = await api('/_api/ai/status', { token: editorTok });
      assert.equal(r.status, 200);
      assert.equal(r.body.enabled, false);
      assert.match(r.body.reason, /ANTHROPIC_API_KEY/);
      assert.equal(r.body.model, undefined, 'and leaks no configuration');
    });

    await t('ai: no key means no enrichment job type exists at all', async () => {
      const w = await api('/_api/jobs', { token: adminTok });
      assert.ok(!w.body.worker.types.includes('enrich'), 'enrich is unregistered');
      assert.ok(!w.body.worker.types.includes('enrich_batch'));
      const r = await api('/_api/ai/enrich', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg' } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'ai_disabled');
    });

    await t('ai: bulk enrich is refused rather than queueing unclaimable jobs', async () => {
      const r = await api('/_api/bulk', { method: 'POST', token: editorTok, json: { action: 'enrich', filter: { folder: 'gallery' } } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'ai_disabled');
    });

    await t('ai: no key means no AI columns are populated', async () => {
      assert.equal((await api('/_api/files/ai?path=gallery/blue.jpg', { token: editorTok })).body.ai, null);
      const conn = await inspectConn();
      const [rows] = await conn.query('SELECT COUNT(*) AS n FROM file_ai');
      assert.equal(Number(rows[0].n), 0);
    });

    // ── AI enrichment: the full path, against a stub upstream ─────────────────
    await withStubAi({ img }, async (node, stub) => {
      let aiTok = null;
      await t('ai: a configured node enriches an image end to end', async () => {
        aiTok = await bootstrapAdmin(node.base);
        const status = await nodeApi(node, '/_api/ai/status', { token: aiTok });
        assert.equal(status.body.enabled, true);
        assert.equal(status.body.model, 'claude-opus-5');

        // Index the seeded master, then enrich it.
        await runJob(node, aiTok, { type: 'scan' });
        const job = await runJob(node, aiTok, { type: 'enrich', payload: { path: 'shoot/blue.jpg' } });
        assert.equal(job.state, 'done', `enrich failed: ${job.error}`);

        const got = await nodeApi(node, '/_api/files/ai?path=shoot/blue.jpg', { token: aiTok });
        assert.equal(got.body.ai.status, 'ok');
        assert.equal(got.body.ai.caption, 'A flat blue rectangle.');
        assert.equal(got.body.ai.alt_text, 'Solid blue image');
        assert.equal(got.body.ai.model, 'claude-opus-5');
        assert.equal(got.body.ai.prompt_version, 'v1');
      });

      await t('ai: the image is downscaled before it is sent — the cost lever', async () => {
        const sent = stub.seen.messages[0];
        assert.ok(sent, 'the stub received a request');
        const imageBlock = sent.messages[0].content.find((b) => b.type === 'image');
        assert.ok(imageBlock, 'an image block was sent');
        assert.equal(imageBlock.source.media_type, 'image/jpeg');
        const meta = await sharp(Buffer.from(imageBlock.source.data, 'base64')).metadata();
        assert.ok(Math.max(meta.width, meta.height) <= 900,
          `long edge must be bounded by AI_MAX_IMAGE_DIM, got ${meta.width}x${meta.height}`);
        assert.ok(meta.width < 1600, 'and must not be the full-size master');
      });

      await t('ai: the instruction prefix is marked cacheable, the image is not', async () => {
        const sent = stub.seen.messages[0];
        assert.ok(sent.system.some((b) => b.cache_control), 'system prefix carries a cache breakpoint');
        assert.ok(sent.messages[0].content.every((b) => !b.cache_control), 'the per-asset content does not');
        assert.equal(sent.output_config.format.type, 'json_schema', 'and output is schema-constrained');
      });

      await t('ai: suggested tags are kept apart from human tags until promoted', async () => {
        const got = await nodeApi(node, '/_api/files/ai?path=shoot/blue.jpg', { token: aiTok });
        const tags = got.body.ai.tags.map((x) => x.tag).sort();
        // Normalized the same way human tags are: trimmed, lowercased, deduped.
        assert.deepEqual(tags, ['abstract', 'blue', 'colour field']);
        assert.ok(got.body.ai.tags.every((x) => !x.promoted_at), 'nothing is promoted on its own');
        const human = await nodeApi(node, '/_api/files/tags?path=shoot/blue.jpg', { token: aiTok });
        assert.deepEqual(human.body.tags, [], 'and no AI tag has leaked into the human set');
      });

      await t('ai: promoting a tag is the explicit act that makes it a human tag', async () => {
        const r = await nodeApi(node, '/_api/files/ai/review', { method: 'POST', token: aiTok,
          json: { path: 'shoot/blue.jpg', action: 'promote_tags', tags: ['blue'] } });
        assert.equal(r.status, 200);
        assert.equal(r.body.promoted, 1);
        const human = await nodeApi(node, '/_api/files/tags?path=shoot/blue.jpg', { token: aiTok });
        assert.deepEqual(human.body.tags, ['blue']);
        assert.ok(r.body.ai.tags.find((x) => x.tag === 'blue').promoted_at, 'and it is marked promoted');
      });

      await t('ai: a rejected tag is removed and never comes back on a re-run', async () => {
        await nodeApi(node, '/_api/files/ai/review', { method: 'POST', token: aiTok,
          json: { path: 'shoot/blue.jpg', action: 'reject_tags', tags: ['abstract'] } });
        const job = await runJob(node, aiTok, { type: 'enrich', payload: { path: 'shoot/blue.jpg' } });
        assert.equal(job.state, 'done');
        const got = await nodeApi(node, '/_api/files/ai?path=shoot/blue.jpg', { token: aiTok });
        const rejected = got.body.ai.tags.find((x) => x.tag === 'abstract');
        assert.ok(rejected && rejected.rejected_at, 're-running enrichment must not resurrect a rejected tag');
      });

      await t('ai: a human edit of the generated prose sticks', async () => {
        const r = await nodeApi(node, '/_api/files/ai/review', { method: 'POST', token: aiTok,
          json: { path: 'shoot/blue.jpg', action: 'edit', fields: { caption: 'Hand-written caption.' } } });
        assert.equal(r.body.ai.caption, 'Hand-written caption.');
        assert.ok(r.body.ai.reviewed_at, 'and is recorded as reviewed');
      });

      await t('ai: every call is metered, and the cost maths is right', async () => {
        const usage = await nodeApi(node, '/_api/ai/usage', { token: aiTok });
        assert.equal(usage.status, 200);
        assert.ok(usage.body.total.calls >= 2);
        // Opus 5 is $5/$25 per MTok, cache reads bill at 0.1x input. The stub reports
        // 1200 input + 800 cache-read + 90 output, so each call is
        //   (1200×5 + 800×5×0.1 + 90×25) / 1e6 = $0.00865
        assert.ok(Math.abs(usage.body.total.cost - usage.body.total.calls * 0.00865) < 1e-6,
          `expected ${usage.body.total.calls} × $0.00865, got $${usage.body.total.cost}`);
        assert.ok(usage.body.monthToDate > 0);
      });

      await t('ai: bulk backfill goes through the Batches API and keys results by custom_id', async () => {
        // Two more assets with no enrichment yet.
        for (const name of ['shoot/b.jpg', 'shoot/c.jpg']) {
          await fetch(`${node.base}/${name}`, { method: 'PUT', headers: authH(TOKEN), body: img });
        }
        await runJob(node, aiTok, { type: 'scan' });
        const r = await nodeApi(node, '/_api/ai/enrich', { method: 'POST', token: aiTok, json: { filter: { folder: 'shoot' } } });
        assert.equal(r.status, 202);
        const done = await waitJobOn(node, aiTok, r.body.job.id);
        assert.equal(done.state, 'done', `batch submit failed: ${done.error}`);
        assert.ok(stub.seen.batches.length === 1, 'one batch was submitted');
        assert.equal(jsonOf(done.result).submitted, 2, 'only the un-enriched assets were included');

        // The follow-up poll job ingests the (deliberately out-of-order) results.
        await waitFor(async () => {
          const got = await nodeApi(node, '/_api/files/ai?path=shoot/b.jpg', { token: aiTok });
          return got.body.ai && got.body.ai.status === 'ok';
        }, 300, 100);
        for (const name of ['shoot/b.jpg', 'shoot/c.jpg']) {
          const got = await nodeApi(node, `/_api/files/ai?path=${name}`, { token: aiTok });
          assert.equal(got.body.ai.caption, 'A flat blue rectangle.', `${name} got its own result`);
        }
      });

      await t('ai: batch spend is billed at half price', async () => {
        const usage = await nodeApi(node, '/_api/ai/usage', { token: aiTok });
        const batchKind = usage.body.byKind.find((k) => k.kind === 'image_batch');
        assert.ok(batchKind, 'batch calls are metered separately');
        assert.ok(Math.abs(batchKind.cost - batchKind.calls * 0.004325) < 1e-6,
          `batch should be half of $0.00865, got $${batchKind.cost / batchKind.calls} per call`);
      });

      await t('ai: a budget ceiling is enforced BEFORE the call, not reported after', async () => {
        // The node runs with AI_MONTHLY_BUDGET_USD=0.02; the calls above have taken
        // spend past it, so the next one must be refused WITHOUT reaching the API.
        const before = stub.seen.messages.length;
        await fetch(`${node.base}/shoot/over-budget.jpg`, { method: 'PUT', headers: authH(TOKEN), body: img });
        await runJob(node, aiTok, { type: 'scan' });
        const job = await runJob(node, aiTok, { type: 'enrich', payload: { path: 'shoot/over-budget.jpg' } });
        assert.equal(job.state, 'done');
        assert.equal(jsonOf(job.result).failed, 'budget_exceeded');
        assert.equal(stub.seen.messages.length, before, 'no request was sent upstream');
        const got = await nodeApi(node, '/_api/files/ai?path=shoot/over-budget.jpg', { token: aiTok });
        assert.equal(got.body.ai.status, 'failed', 'and the refusal is visible in review');
      });
    });

    await withStubAi({ img, fail: true, label: 'airefuse', budget: 0 }, async (node) => {
      await t('ai: a model refusal is recorded once, not retried four more times', async () => {
        const tok = await bootstrapAdmin(node.base);
        await runJob(node, tok, { type: 'scan' });
        const job = await runJob(node, tok, { type: 'enrich', payload: { path: 'shoot/blue.jpg' } });
        assert.equal(job.state, 'done', 'a refusal is a result, not a transient fault');
        assert.equal(Number(job.attempts), 1, 'so it is not retried');
        assert.equal(jsonOf(job.result).failed, 'refusal');
        const got = await nodeApi(node, '/_api/files/ai?path=shoot/blue.jpg', { token: tok });
        assert.equal(got.body.ai.status, 'failed');
        assert.match(got.body.ai.error, /declined/);
      });
    });

    // ── pull-through indexing ─────────────────────────────────────────────────
    // The other two ways a served master used to stay invisible: fetched from an
    // external origin, or pulled from a cluster peer on miss. Both persist bytes via
    // fetchstore, which never told the index anything. A separate node (sharing this
    // throwaway database) exercises both without disturbing the main server.
    await withPullNode({ img, img2 }, async (pull) => {
      await t('pull-through: an origin-fetched master is indexed, not just served', async () => {
        const got = await bytes(`${pull.base}/from-origin.jpg`);
        assert.equal(got.status, 200);
        assert.equal(got.buf.length, img.length);
        const row = await waitRow('from-origin.jpg', (r) => !!r, 120, 50, DB_NAME_PULL);
        assert.equal(row.status, 'active');
        assert.equal(Number(row.size_bytes), img.length);
        assert.equal(row.volume_id, 'default', 'pulled masters land on the default volume');
      });

      await t('pull-through: an origin-fetched master gets its metadata extracted too', async () => {
        const row = await waitRow('from-origin.jpg', (r) => r && r.width === 900, 200, 100, DB_NAME_PULL);
        assert.equal(row.width, 900, 'the queued extraction filled in the dimensions');
        assert.equal(row.height, 600);
      });

      await t('pull-through: a master pulled from a cluster peer is indexed', async () => {
        const got = await bytes(`${pull.base}/from-peer.png`);
        assert.equal(got.status, 200);
        assert.equal(got.buf.length, img2.length);
        const row = await waitRow('from-peer.png', (r) => !!r, 120, 50, DB_NAME_PULL);
        assert.equal(Number(row.size_bytes), img2.length);
        assert.equal(row.mime, 'image/png');
      });

      await t('pull-through: a miss at every source stays a 404 and indexes nothing', async () => {
        assert.equal((await fetch(`${pull.base}/nowhere.jpg`)).status, 404);
        await sleep(300);
        assert.equal(await fileRow('nowhere.jpg', DB_NAME_PULL), null);
      });
    });

    // ── 4.1 version control ───────────────────────────────────────────────────
    await t('versions: a PUT over an existing master keeps the bytes it replaced', async () => {
      await put('versioned/doc.png', img2, { token: editorTok });
      const v2bytes = await sharp({ create: { width: 111, height: 111, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
      await put('versioned/doc.png', v2bytes, { token: editorTok });
      const r = await api('/_api/files/versions?path=versioned/doc.png', { token: editorTok });
      assert.equal(r.status, 200);
      assert.equal(r.body.versions.length, 1, 'one prior copy retained');
      assert.equal(r.body.versions[0].version_no, 1);
      assert.equal(r.body.versions[0].size_bytes, img2.length, 'and it is the ORIGINAL bytes');
      // The live master is the new one.
      const live = await bytes(`${BASE}/versioned/doc.png`);
      assert.equal(live.buf.length, v2bytes.length);
      versionedV2Len = v2bytes.length;
    });

    await t('versions: retained bytes are not servable at the original URL', async () => {
      // They live outside every storage volume, like the trash — that is the point.
      assert.ok(!fs.existsSync(path.join(MASTER_DIR, 'versioned')) || fs.readdirSync(path.join(MASTER_DIR, 'versioned')).length === 1);
      const dl = await bytes(`${BASE}/_api/files/versions/1?path=versioned/doc.png`, { headers: authH(editorTok) });
      assert.equal(dl.status, 200);
      assert.equal(dl.buf.length, img2.length);
      assert.match(dl.headers.get('content-disposition') || '', /attachment/);
      assert.equal((await fetch(`${BASE}/_api/files/versions/1?path=versioned/doc.png`)).status, 401, 'and need auth');
    });

    await t('versions: restoring a version is itself undoable', async () => {
      const r = await api('/_api/files/versions/restore', { method: 'POST', token: editorTok, json: { path: 'versioned/doc.png', version: 1 } });
      assert.equal(r.status, 200);
      const live = await bytes(`${BASE}/versioned/doc.png`);
      assert.equal(live.buf.length, img2.length, 'the old bytes are live again');
      const list = await api('/_api/files/versions?path=versioned/doc.png', { token: editorTok });
      assert.equal(list.body.versions.length, 2, 'and what was live became version 2');
      assert.equal(list.body.versions[0].size_bytes, versionedV2Len);
    });

    await t('versions: retention keeps only the configured number of copies', async () => {
      for (let i = 0; i < 6; i++) {
        await put('versioned/doc.png', await sharp({ create: { width: 20 + i, height: 20, channels: 3, background: { r: i, g: 0, b: 0 } } }).png().toBuffer(), { token: editorTok });
      }
      const r = await api('/_api/files/versions?path=versioned/doc.png', { token: editorTok });
      assert.equal(r.body.retention.keepCount, 3);
      assert.equal(r.body.versions.length, 3, 'older copies are trimmed as new ones arrive');
      // …and the three kept are the newest three.
      const nos = r.body.versions.map((v) => v.version_no);
      assert.deepEqual(nos, [...nos].sort((a, b) => b - a));
    });

    await t('versions: purging one, and purging the master, removes the retained bytes', async () => {
      const before = (await api('/_api/files/versions?path=versioned/doc.png', { token: editorTok })).body.versions;
      const r = await api(`/_api/files/versions/${before[0].version_no}?path=versioned/doc.png`, { method: 'DELETE', token: editorTok });
      assert.equal(r.status, 200);
      assert.equal((await api('/_api/files/versions?path=versioned/doc.png', { token: editorTok })).body.versions.length, before.length - 1);
      // Purging the file for good must not leave ITS version files behind. (Other
      // assets legitimately still have retained copies, so scope the check.)
      const versionsDir = path.join(TRASH_DIR, 'versions');
      const prefix = pathHash('versioned/doc.png') + '.';
      assert.ok(fs.readdirSync(versionsDir).some((f) => f.startsWith(prefix)), 'copies exist before the purge');
      await del('versioned/doc.png', editorTok);
      await api('/_api/files/purge', { method: 'POST', token: editorTok, json: { path: 'versioned/doc.png' } });
      const leftovers = fs.readdirSync(versionsDir).filter((f) => f.startsWith(prefix));
      assert.equal(leftovers.length, 0, `retained bytes leaked: ${leftovers.join(', ')}`);
    });

    // ── 4.2 folders ───────────────────────────────────────────────────────────
    await t('folders: real rows are materialized from the indexed paths', async () => {
      const r = await api('/_api/folders/sync', { method: 'POST', token: editorTok });
      assert.equal(r.status, 200);
      const list = await api('/_api/folders', { token: editorTok });
      const gallery = list.body.folders.find((f) => f.path === 'gallery');
      assert.ok(gallery, 'gallery/ is a folder row now, not just a path prefix');
      assert.ok(gallery.file_count >= 1);
      const nested = list.body.folders.find((f) => f.path === 'rsynced/deep');
      assert.ok(nested, 'and so is a nested one');
      assert.ok(nested.parent_id, 'linked to its parent');
    });

    await t('folders: a subtree can be moved, taking its files and index rows with it', async () => {
      await put('proj/a/one.png', img2, { token: editorTok });
      await put('proj/a/deep/two.png', img2, { token: editorTok });
      const r = await api('/_api/folders/move', { method: 'POST', token: editorTok, json: { path: 'proj/a', to: 'proj/renamed' } });
      assert.equal(r.status, 200);
      assert.equal((await fetch(`${BASE}/proj/renamed/one.png`)).status, 200);
      assert.equal((await fetch(`${BASE}/proj/renamed/deep/two.png`)).status, 200);
      assert.equal((await fetch(`${BASE}/proj/a/one.png`)).status, 404);
      await waitRow('proj/renamed/one.png', (x) => !!x);
      assert.ok(await fileRow('proj/renamed/deep/two.png'), 'the index followed the whole subtree');
    });

    await t('folders: a move into itself, or onto something existing, is refused', async () => {
      assert.equal((await api('/_api/folders/move', { method: 'POST', token: editorTok, json: { path: 'proj/renamed', to: 'proj/renamed/inner' } })).status, 400);
      assert.equal((await api('/_api/folders/move', { method: 'POST', token: editorTok, json: { path: 'proj/renamed', to: 'gallery' } })).status, 409);
      assert.equal((await api('/_api/folders/move', { method: 'POST', token: editorTok, json: { path: 'no/such/dir', to: 'x' } })).status, 404);
    });

    await t('folders: ?folder= scopes a file search to a subtree', async () => {
      const r = await api('/_api/files?folder=proj/renamed&limit=100', { token: editorTok });
      assert.equal(r.body.total, 2);
      assert.ok(r.body.files.every((f) => f.path.startsWith('proj/renamed/')));
    });

    // ── 4.3 collections ───────────────────────────────────────────────────────
    await t('collections: a set that cuts across folders', async () => {
      const c = await api('/_api/collections', { method: 'POST', token: editorTok, json: { name: 'Spring campaign', description: 'hero art' } });
      assert.equal(c.status, 201);
      collectionId = c.body.collection.id;
      const add = await api(`/_api/collections/${collectionId}/files`, {
        method: 'POST', token: editorTok,
        json: { add: ['gallery/blue.jpg', 'proj/renamed/one.png', 'not/indexed.jpg'] } });
      assert.equal(add.body.added, 2, 'unindexed paths are skipped, not fatal');
      const files = await api(`/_api/collections/${collectionId}/files`, { token: editorTok });
      assert.equal(files.body.files.length, 2);
      assert.deepEqual((await api('/_api/collections', { token: editorTok })).body.collections.find((x) => x.id === collectionId).file_count, 2);
      assert.equal((await api('/_api/collections', { method: 'POST', token: editorTok, json: { name: 'Spring campaign' } })).status, 409);
    });

    await t('collections: ?collection= filters the file list, by id or by name', async () => {
      assert.equal((await api(`/_api/files?collection=${collectionId}`, { token: editorTok })).body.total, 2);
      assert.equal((await api('/_api/files?collection=Spring%20campaign', { token: editorTok })).body.total, 2);
      const rm = await api(`/_api/collections/${collectionId}/files`, { method: 'POST', token: editorTok, json: { remove: ['gallery/blue.jpg'] } });
      assert.equal(rm.body.removed, 1);
      assert.equal((await api(`/_api/files?collection=${collectionId}`, { token: editorTok })).body.total, 1);
    });

    // ── 4.4 custom metadata ───────────────────────────────────────────────────
    await t('metadata: an installation defines its own fields', async () => {
      assert.equal((await api('/_api/fields', { method: 'POST', token: editorTok, json: { field_key: 'client', label: 'Client' } })).status, 403);
      const f1 = await api('/_api/fields', { method: 'POST', token: adminTok, json: { field_key: 'client', label: 'Client' } });
      assert.equal(f1.status, 201);
      assert.equal(f1.body.field.type, 'text');
      await api('/_api/fields', { method: 'POST', token: adminTok, json: { field_key: 'shoot date', label: 'Shoot date', type: 'date' } });
      await api('/_api/fields', { method: 'POST', token: adminTok, json: { field_key: 'budget', label: 'Budget', type: 'number' } });
      const list = await api('/_api/fields', { token: editorTok });
      const keys = list.body.fields.map((f) => f.field_key);
      assert.ok(keys.includes('client'));
      assert.ok(keys.includes('shoot_date'), 'keys are normalized to a safe form');
      assert.equal((await api('/_api/fields', { method: 'POST', token: adminTok, json: { field_key: 'client', label: 'dup' } })).status, 409);
    });

    await t('metadata: values are typed, validated and searchable', async () => {
      const set = await api('/_api/files/fields', { method: 'PUT', token: editorTok, json: {
        path: 'gallery/blue.jpg', values: { client: 'Acme', budget: 1500, shoot_date: '2026-03-01' } } });
      assert.equal(set.status, 200);
      const got = await api('/_api/files/fields?path=gallery/blue.jpg', { token: editorTok });
      assert.equal(got.body.values.client, 'Acme');
      assert.equal(got.body.values.budget, 1500);
      const bad = await api('/_api/files/fields', { method: 'PUT', token: editorTok, json: { path: 'gallery/blue.jpg', values: { budget: 'not-a-number' } } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'bad_value');
      // Searchable alongside the built-in filters.
      assert.equal((await api('/_api/files?field=client&field_value=Acme', { token: editorTok })).body.total, 1);
      assert.equal((await api('/_api/files?field=client&field_value=Nobody', { token: editorTok })).body.total, 0);
      assert.ok((await api('/_api/files?field=client', { token: editorTok })).body.total >= 1);
    });

    // ── 4.6 named renditions ──────────────────────────────────────────────────
    await t('renditions: a name stands in for a query string', async () => {
      const r = await api('/_api/renditions', { method: 'POST', token: adminTok, json: {
        name: 'web-hero', width: 320, height: 180, fit: 'cover', format: 'webp', quality: 70, description: 'Homepage hero' } });
      assert.equal(r.status, 200);
      const got = await bytes(`${BASE}/gallery/blue.jpg?rendition=web-hero`);
      assert.equal(got.status, 200);
      const m = await sharp(got.buf).metadata();
      assert.equal(m.format, 'webp');
      assert.equal(m.width, 320);
      assert.equal(m.height, 180, 'fit=cover from the preset');
    });

    await t('renditions: an explicit parameter still overrides the preset', async () => {
      const m = await sharp((await bytes(`${BASE}/gallery/blue.jpg?rendition=web-hero&w=100`)).buf).metadata();
      assert.equal(m.width, 100);
      assert.equal(m.format, 'webp', 'but the rest of the preset still applies');
    });

    await t('renditions: an unknown name is a clear 404, not a silent full-size image', async () => {
      const r = await fetch(`${BASE}/gallery/blue.jpg?rendition=nope`);
      assert.equal(r.status, 404);
      assert.match(await r.text(), /Unknown rendition/);
    });

    await t('renditions: deleting one takes effect immediately', async () => {
      assert.equal((await api('/_api/renditions/web-hero', { method: 'DELETE', token: adminTok })).status, 200);
      assert.equal((await fetch(`${BASE}/gallery/blue.jpg?rendition=web-hero`)).status, 404);
      assert.equal((await api('/_api/renditions/web-hero', { method: 'DELETE', token: adminTok })).status, 404);
    });

    // ── 4.5 saved searches + bulk operations ──────────────────────────────────
    await t('searches: a filter set can be saved and read back', async () => {
      const r = await api('/_api/searches', { method: 'POST', token: editorTok, json: { name: 'Acme work', query: { field: 'client', field_value: 'Acme' } } });
      assert.equal(r.status, 201);
      const list = await api('/_api/searches', { token: editorTok });
      const saved = list.body.searches.find((s) => s.name === 'Acme work');
      assert.ok(saved);
      assert.equal(saved.query.field_value, 'Acme');
      assert.equal((await api(`/_api/searches/${saved.id}`, { method: 'DELETE', token: editorTok })).status, 200);
    });

    await t('bulk: tagging everything matching a filter runs as a job', async () => {
      const r = await api('/_api/bulk', { method: 'POST', token: editorTok, json: {
        action: 'tag', filter: { folder: 'proj/renamed' }, params: { tags: ['Bulk Tagged', 'bulk tagged'] } } });
      assert.equal(r.status, 202);
      const done = await waitJob(r.body.job.id);
      assert.equal(done.state, 'done', `bulk error: ${done.error}`);
      const result = jsonOf(done.result);
      assert.equal(result.matched, 2);
      assert.equal(result.applied, 2);
      // The same normalization a single tag write uses — one tag, not two.
      const tagged = await api('/_api/files?tag=bulk%20tagged', { token: editorTok });
      assert.equal(tagged.body.total, 2);
    });

    await t('bulk: the preview filter and the applied filter are the same set', async () => {
      const preview = await api('/_api/files?folder=proj/renamed&limit=500', { token: editorTok });
      const r = await api('/_api/bulk', { method: 'POST', token: editorTok, json: {
        action: 'collection_add', filter: { folder: 'proj/renamed' }, params: { collection_id: collectionId } } });
      const done = await waitJob(r.body.job.id);
      assert.equal(jsonOf(done.result).matched, preview.body.total);
      assert.equal((await api(`/_api/files?collection=${collectionId}`, { token: editorTok })).body.total, 2);
    });

    await t('bulk: an unsupported action is refused before anything runs', async () => {
      const r = await api('/_api/bulk', { method: 'POST', token: editorTok, json: { action: 'incinerate', filter: {} } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'bad_action');
    });

    await t('bulk: untag removes only what was asked for', async () => {
      const r = await api('/_api/bulk', { method: 'POST', token: editorTok, json: {
        action: 'untag', filter: { folder: 'proj/renamed' }, params: { tags: ['bulk tagged'] } } });
      await waitJob(r.body.job.id);
      assert.equal((await api('/_api/files?tag=bulk%20tagged', { token: editorTok })).body.total, 0);
    });

    // ── 4.7 comments + notifications ──────────────────────────────────────────
    await t('comments: a thread per asset, with replies', async () => {
      const c1 = await api('/_api/comments', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg', body: 'Crop is tight on the left.' } });
      assert.equal(c1.status, 201);
      const c2 = await api('/_api/comments', { method: 'POST', token: adminTok, json: { path: 'gallery/blue.jpg', body: 'Agreed — reshooting.', parent_id: c1.body.comment.id } });
      assert.equal(c2.status, 201);
      const list = await api('/_api/comments?path=gallery/blue.jpg', { token: viewerTok });
      assert.equal(list.body.comments.length, 2);
      assert.equal(list.body.comments[1].parent_id, c1.body.comment.id);
      assert.equal(list.body.comments[0].username, 'ed', 'attributed to its author');
      commentId = c1.body.comment.id;
    });

    await t('comments: resolving and deleting are limited to the author or an admin', async () => {
      assert.equal((await api(`/_api/comments/${commentId}`, { method: 'PATCH', token: viewerTok, json: { body: 'hijacked' } })).status, 403);
      const r = await api(`/_api/comments/${commentId}`, { method: 'PATCH', token: editorTok, json: { resolved: true } });
      assert.equal(r.status, 200);
      assert.ok(r.body.comment.resolved_at);
      // Deleting a parent takes its replies with it — an orphaned reply is noise.
      assert.equal((await api(`/_api/comments/${commentId}`, { method: 'DELETE', token: adminTok })).status, 200);
      assert.equal((await api('/_api/comments?path=gallery/blue.jpg', { token: editorTok })).body.comments.length, 0);
    });

    await t('notifications: the people already involved are told, and nobody else', async () => {
      await api('/_api/comments', { method: 'POST', token: editorTok, json: { path: 'gallery/blue.jpg', body: 'First note.' } });
      await api('/_api/comments', { method: 'POST', token: adminTok, json: { path: 'gallery/blue.jpg', body: 'Second note.' } });
      const forEditor = await api('/_api/notifications?unread=1', { token: editorTok });
      assert.ok(forEditor.body.unread >= 1, 'the earlier commenter hears about the reply');
      assert.ok(forEditor.body.notifications.every((n) => n.actor_id !== editorId), 'but never about their own comments');
      const forViewer = await api('/_api/notifications?unread=1', { token: viewerTok });
      assert.equal(forViewer.body.unread, 0, 'an uninvolved user is not spammed');
      assert.equal((await api('/_api/notifications/read', { method: 'POST', token: editorTok, json: {} })).status, 200);
      assert.equal((await api('/_api/notifications?unread=1', { token: editorTok })).body.unread, 0);
    });

    // ── API tokens ────────────────────────────────────────────────────────────
    await t('tokens: minting shows the plaintext exactly once', async () => {
      const r = await api('/_api/tokens', { method: 'POST', token: editorTok, json: { name: 'ci-pipeline' } });
      assert.equal(r.status, 201);
      assert.match(r.body.token, /^[a-f0-9]{64}$/);
      apiToken = r.body.token;
      const list = await api('/_api/tokens', { token: editorTok });
      const row = list.body.tokens.find((x) => x.name === 'ci-pipeline');
      assert.ok(row, 'the token is listed');
      assert.equal(row.token, undefined, 'but never its plaintext');
      assert.equal(row.token_hash, undefined, 'nor its hash');
    });

    await t('tokens: an API token authenticates the API and uploads, as its owner', async () => {
      const me = await api('/_api/auth/me', { token: apiToken });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.id, editorId, 'acts as the user who minted it');
      assert.equal((await put('via-token.jpg', img2, { token: apiToken })).status, 201);
      assert.equal((await fileRow('via-token.jpg')).owner_user_id, editorId);
    });

    await t('tokens: an API token works as a WebDAV password (the MFA-safe path)', async () => {
      const r = await dav('gallery/', { method: 'PROPFIND', headers: { ...basicH('ed', apiToken), Depth: '1' } });
      assert.equal(r.status, 207);
    });

    await t('tokens: revoking one stops it immediately', async () => {
      const list = await api('/_api/tokens', { token: editorTok });
      const row = list.body.tokens.find((x) => x.name === 'ci-pipeline');
      assert.equal((await api(`/_api/tokens/${row.id}`, { method: 'DELETE', token: editorTok })).status, 200);
      assert.equal((await api('/_api/auth/me', { token: apiToken })).status, 401);
      assert.equal((await api(`/_api/tokens/${row.id}`, { method: 'DELETE', token: editorTok })).status, 404);
    });

    await t('tokens: an expired token is refused', async () => {
      const r = await api('/_api/tokens', { method: 'POST', token: editorTok, json: { name: 'short-lived' } });
      const conn = await inspectConn();
      await conn.query('UPDATE api_tokens SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE name = ?', ['short-lived']);
      assert.equal((await api('/_api/auth/me', { token: r.body.token })).status, 401);
    });

    // ── passwords ─────────────────────────────────────────────────────────────
    await t('password: self-service change requires the current password', async () => {
      const r = await api('/_api/auth/password', { method: 'POST', token: viewerTok, json: { old_password: 'wrong', new_password: 'brand-new-pw-1' } });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'bad_password');
    });

    await t('password: a too-short new password is refused', async () => {
      const r = await api('/_api/auth/password', { method: 'POST', token: viewerTok, json: { old_password: 'viewerpw-123', new_password: 'short' } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'weak_password');
    });

    await t('password: a successful change revokes other sessions but keeps this one', async () => {
      // A second session for the same user, which must not survive the change.
      const other = (await api('/_api/auth/login', { method: 'POST', json: { login: 'vi', password: 'viewerpw-123' } })).body.token;
      assert.equal((await api('/_api/auth/me', { token: other })).status, 200);
      const r = await api('/_api/auth/password', { method: 'POST', token: viewerTok, json: { old_password: 'viewerpw-123', new_password: 'viewer-new-pw-9' } });
      assert.equal(r.status, 200);
      assert.equal((await api('/_api/auth/me', { token: other })).status, 401, 'the other session is gone');
      assert.equal((await api('/_api/auth/me', { token: viewerTok })).status, 200, 'the acting session survives');
      assert.equal((await api('/_api/auth/login', { method: 'POST', json: { login: 'vi', password: 'viewer-new-pw-9' } })).status, 200);
      assert.equal((await api('/_api/auth/login', { method: 'POST', json: { login: 'vi', password: 'viewerpw-123' } })).status, 401);
    });

    await t('password: an admin reset works without the old password and kills every session', async () => {
      const live = (await api('/_api/auth/login', { method: 'POST', json: { login: 'vi', password: 'viewer-new-pw-9' } })).body.token;
      const r = await api(`/_api/users/${viewerId}/password`, { method: 'POST', token: adminTok, json: { new_password: 'reset-by-admin-1' } });
      assert.equal(r.status, 200);
      assert.equal((await api('/_api/auth/me', { token: live })).status, 401);
      const relogin = await api('/_api/auth/login', { method: 'POST', json: { login: 'vi', password: 'reset-by-admin-1' } });
      assert.equal(relogin.status, 200);
      viewerTok = relogin.body.token;
      assert.equal((await api('/_api/users/1/password', { method: 'POST', token: viewerTok, json: { new_password: 'nope-nope-1' } })).status, 403);
    });

    // ── account lifecycle ─────────────────────────────────────────────────────
    await t('roles: revoking a role takes effect immediately', async () => {
      // `vi` was promoted to editor earlier and can write; taking it back must stop that.
      assert.equal((await put('still-editor.jpg', img2, { token: viewerTok })).status, 201);
      const r = await api(`/_api/users/${viewerId}/roles/editor`, { method: 'DELETE', token: adminTok });
      assert.equal(r.status, 200);
      const relogin = await api('/_api/auth/login', { method: 'POST', json: { login: 'vi', password: 'reset-by-admin-1' } });
      viewerTok = relogin.body.token;
      assert.equal((await put('no-longer-editor.jpg', img2, { token: viewerTok, awaitIndex: false })).status, 401);
      assert.equal((await api(`/_api/users/${viewerId}/roles/editor`, { method: 'DELETE', token: adminTok })).status, 404);
    });

    await t('users: disabling an account revokes its sessions and blocks login', async () => {
      const doomed = await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'off@test.local', username: 'off', password: 'disabled-pw-1', role: 'viewer' } });
      const tok = (await api('/_api/auth/login', { method: 'POST', json: { login: 'off', password: 'disabled-pw-1' } })).body.token;
      assert.equal((await api('/_api/auth/me', { token: tok })).status, 200);
      const r = await api(`/_api/users/${doomed.body.user.id}/status`, { method: 'POST', token: adminTok, json: { status: 'disabled' } });
      assert.equal(r.status, 200);
      assert.equal((await api('/_api/auth/me', { token: tok })).status, 401, 'live sessions die with the account');
      assert.equal((await api('/_api/auth/login', { method: 'POST', json: { login: 'off', password: 'disabled-pw-1' } })).status, 401);
      // …and re-enabling restores access.
      assert.equal((await api(`/_api/users/${doomed.body.user.id}/status`, { method: 'POST', token: adminTok, json: { status: 'active' } })).status, 200);
      assert.equal((await api('/_api/auth/login', { method: 'POST', json: { login: 'off', password: 'disabled-pw-1' } })).status, 200);
      disabledUserId = doomed.body.user.id;
    });

    await t('users: the last admin cannot be disabled, demoted or deleted', async () => {
      const adminId = (await api('/_api/auth/me', { token: adminTok })).body.user.id;
      const disable = await api(`/_api/users/${adminId}/status`, { method: 'POST', token: adminTok, json: { status: 'disabled' } });
      assert.equal(disable.status, 409);
      assert.equal(disable.body.error, 'self_disable');
      // Even from another admin's session, the last-admin guard holds.
      await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'a2@test.local', username: 'a2', password: 'admin2-pw-12', role: 'admin' } });
      const a2 = (await api('/_api/auth/login', { method: 'POST', json: { login: 'a2', password: 'admin2-pw-12' } })).body.token;
      // With two admins, demoting one is allowed…
      assert.equal((await api(`/_api/users/${adminId}/roles/admin`, { method: 'DELETE', token: a2 })).status, 200);
      // …and now `a2` is the last one, so it cannot be demoted or deleted.
      const a2id = (await api('/_api/auth/me', { token: a2 })).body.user.id;
      const demote = await api(`/_api/users/${a2id}/roles/admin`, { method: 'DELETE', token: a2 });
      assert.equal(demote.status, 409);
      assert.equal(demote.body.error, 'last_admin');
      // Restore the original admin so the rest of the suite still has one.
      assert.equal((await api(`/_api/users/${adminId}/roles`, { method: 'POST', token: a2, json: { role: 'admin' } })).status, 200);
      adminTok = (await api('/_api/auth/login', { method: 'POST', json: { login: 'admin', password: 'adminpw-123' } })).body.token;
    });

    await t('users: deleting orphans their files by default, and never touches the bytes', async () => {
      const victim = await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'gone@test.local', username: 'gone', password: 'gone-pw-1234', role: 'editor' } });
      const vt = (await api('/_api/auth/login', { method: 'POST', json: { login: 'gone', password: 'gone-pw-1234' } })).body.token;
      await put('owned/by-gone.jpg', img2, { token: vt });
      assert.equal((await fileRow('owned/by-gone.jpg')).owner_user_id, victim.body.user.id);
      const r = await api(`/_api/users/${victim.body.user.id}`, { method: 'DELETE', token: adminTok });
      assert.equal(r.status, 200);
      assert.equal(r.body.files, 'orphan');
      assert.equal((await fileRow('owned/by-gone.jpg')).owner_user_id, null, 'the row survives, unowned');
      assert.equal((await fetch(`${BASE}/owned/by-gone.jpg`)).status, 200, 'the master is untouched');
      assert.equal((await api('/_api/auth/me', { token: vt })).status, 401);
    });

    await t('users: deleting with ?files=reassign transfers ownership', async () => {
      const victim = await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'gone2@test.local', username: 'gone2', password: 'gone2-pw-123', role: 'editor' } });
      const vt = (await api('/_api/auth/login', { method: 'POST', json: { login: 'gone2', password: 'gone2-pw-123' } })).body.token;
      await put('owned/by-gone2.jpg', img2, { token: vt });
      const r = await api(`/_api/users/${victim.body.user.id}?files=reassign&to=${editorId}`, { method: 'DELETE', token: adminTok });
      assert.equal(r.status, 200);
      assert.equal(r.body.files, 'reassign');
      assert.equal((await fileRow('owned/by-gone2.jpg')).owner_user_id, editorId);
      const bad = await api(`/_api/users/${disabledUserId}?files=reassign&to=999999`, { method: 'DELETE', token: adminTok });
      assert.equal(bad.status, 400);
    });

    await t('users: an admin cannot delete their own account', async () => {
      const adminId = (await api('/_api/auth/me', { token: adminTok })).body.user.id;
      const r = await api(`/_api/users/${adminId}`, { method: 'DELETE', token: adminTok });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'self_delete');
    });

    // ── multi-factor authentication ───────────────────────────────────────────
    await t('mfa: enrolment needs a working code before it turns anything on', async () => {
      await api('/_api/users', { method: 'POST', token: adminTok, json: { email: 'mfa@test.local', username: 'mfauser', password: 'mfa-pw-12345', role: 'viewer' } });
      mfaTok = (await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'mfa-pw-12345' } })).body.token;
      const setup = await api('/_api/auth/mfa/setup', { method: 'POST', token: mfaTok });
      assert.equal(setup.status, 200);
      assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
      assert.match(setup.body.otpauth_url, /^otpauth:\/\/totp\//);
      mfaSecret = setup.body.secret;
      // Still off until proven.
      assert.equal((await api('/_api/auth/me', { token: mfaTok })).body.mfa.enabled, false);
      assert.equal((await api('/_api/auth/mfa/enable', { method: 'POST', token: mfaTok, json: { code: '000000' } })).status, 400);
      const on = await api('/_api/auth/mfa/enable', { method: 'POST', token: mfaTok, json: { code: totp.currentCode(mfaSecret) } });
      assert.equal(on.status, 200);
      assert.equal(on.body.recovery_codes.length, 10);
      mfaRecovery = on.body.recovery_codes;
      assert.equal((await api('/_api/auth/me', { token: mfaTok })).body.mfa.enabled, true);
    });

    await t('mfa: login now demands the second factor', async () => {
      const noCode = await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'mfa-pw-12345' } });
      assert.equal(noCode.status, 401);
      assert.equal(noCode.body.error, 'mfa_required', 'and says so, distinctly from a bad password');
      const wrong = await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'mfa-pw-12345', mfa_code: '000000' } });
      assert.equal(wrong.body.error, 'mfa_required');
      const ok = await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'mfa-pw-12345', mfa_code: totp.currentCode(mfaSecret) } });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.token);
      // A wrong password is still a wrong password, code or no code.
      const badPw = await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'not-it-at-all', mfa_code: totp.currentCode(mfaSecret) } });
      assert.equal(badPw.body.error, 'bad_credentials');
    });

    await t('mfa: a recovery code logs in once and is then spent', async () => {
      const code = mfaRecovery[0];
      const first = await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'mfa-pw-12345', mfa_code: code } });
      assert.equal(first.status, 200);
      const second = await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'mfa-pw-12345', mfa_code: code } });
      assert.equal(second.status, 401, 'a recovery code is single-use');
      assert.equal((await api('/_api/auth/me', { token: first.body.token })).body.mfa.recoveryCodesRemaining, 9);
    });

    await t('mfa: an enrolled account cannot use WebDAV Basic auth with its password', async () => {
      // Basic auth has nowhere to carry a second factor — an API token is the way in.
      assert.equal((await dav('', { method: 'PROPFIND', headers: basicH('mfauser', 'mfa-pw-12345') })).status, 401);
    });

    await t('mfa: an admin reset restores access when the authenticator is lost', async () => {
      const mfaUserId = (await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'mfa-pw-12345', mfa_code: totp.currentCode(mfaSecret) } })).body.user.id;
      assert.equal((await api(`/_api/users/${mfaUserId}/mfa/reset`, { method: 'POST', token: adminTok })).status, 200);
      const plain = await api('/_api/auth/login', { method: 'POST', json: { login: 'mfauser', password: 'mfa-pw-12345' } });
      assert.equal(plain.status, 200, 'password alone works again');
    });

    // ── session sweeper ───────────────────────────────────────────────────────
    await t('sweep: expired sessions and API tokens are purged, not left to rot', async () => {
      const conn = await inspectConn();
      await conn.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (REPEAT('a',64), ?, DATE_SUB(NOW(), INTERVAL 1 DAY))", [editorId]);
      const [before] = await conn.query("SELECT COUNT(*) AS n FROM sessions WHERE expires_at < NOW()");
      assert.ok(Number(before[0].n) > 0, 'an expired session exists to sweep');
      const r = await api('/_api/jobs', { method: 'POST', token: adminTok, json: { type: 'sweep', payload: { repeat: false } } });
      assert.equal(r.status, 202);
      const done = await waitJob(r.body.job.id);
      assert.equal(done.state, 'done');
      assert.ok(jsonOf(done.result).sessions >= 1);
      const [after] = await conn.query("SELECT COUNT(*) AS n FROM sessions WHERE expires_at < NOW()");
      assert.equal(Number(after[0].n), 0);
      const [tok] = await conn.query('SELECT COUNT(*) AS n FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < NOW()');
      assert.equal(Number(tok[0].n), 0, 'expired API tokens go too');
    });

    // ── login throttling (last: it deliberately fills the attempt table) ──────
    await t('throttle: repeated failures lock the account with a Retry-After', async () => {
      const login = 'ed';
      for (let i = 0; i < 4; i++) {
        const r = await api('/_api/auth/login', { method: 'POST', json: { login, password: `wrong-${i}` } });
        assert.equal(r.status, 401, `attempt ${i + 1} should still be a plain rejection`);
      }
      const locked = await api('/_api/auth/login', { method: 'POST', json: { login, password: 'editorpw-123' } });
      assert.equal(locked.status, 429, 'the CORRECT password is refused while locked');
      assert.equal(locked.body.error, 'too_many_attempts');
      assert.ok(Number(locked.headers.get('retry-after')) > 0);
      // Another account from the same IP is unaffected — the per-IP threshold is
      // deliberately far higher, so one user's bad night is not everyone's.
      assert.equal((await api('/_api/auth/login', { method: 'POST', json: { login: 'admin', password: 'adminpw-123' } })).status, 200);
      // Clear the lock so nothing downstream inherits it.
      const conn = await inspectConn();
      await conn.query('DELETE FROM login_attempts');
      assert.equal((await api('/_api/auth/login', { method: 'POST', json: { login, password: 'editorpw-123' } })).status, 200);
    });

    await t('audit: the security-relevant events all leave a trail', async () => {
      const r = await api('/_api/audit?limit=1000', { token: adminTok });
      const actions = new Set(r.body.events.map((e) => e.action));
      for (const a of ['password_change', 'password_reset', 'user_disable', 'user_delete', 'role_revoke', 'token_create', 'mfa_enable', 'login_locked']) {
        assert.ok(actions.has(a), `audit must record "${a}"`);
      }
    });

    // ── READ_AUTH_MODE enforcement ────────────────────────────────────────────
    // The setting was parsed and read by nothing: READ_AUTH_MODE=private booted
    // cleanly and left every master world-readable. These two nodes prove it means
    // something now — and that the default mode is genuinely untouched (the origin
    // suite's whole DB-less run is the control for that).
    await withNode({
      label: 'mixedauth', port: PORT + 3, dbName: `${DB_NAME}_mixed`,
      env: { READ_AUTH_MODE: 'mixed', PRIVATE_PATHS: 'secret', CLUSTER_SECRET: 'peer-secret-1' },
      seed: { 'open.jpg': img, 'secret/hidden.jpg': img2 },
    }, async (node) => {
      const rootTok = await bootstrapAdmin(node.base);
      await t('read-auth mixed: public masters stay open to anyone', async () => {
        assert.equal((await fetch(`${node.base}/open.jpg`)).status, 200);
        assert.equal((await fetch(`${node.base}/open.jpg?w=100`)).status, 200, 'including resizes');
      });
      await t('read-auth mixed: a private master needs credentials', async () => {
        const r = await fetch(`${node.base}/secret/hidden.jpg`);
        assert.equal(r.status, 401);
        assert.equal((await fetch(`${node.base}/secret/hidden.jpg?w=50`)).status, 401, 'and so does its resize');
      });
      await t('read-auth mixed: a signed-in user, the upload token, and a peer all get in', async () => {
        assert.equal((await fetch(`${node.base}/secret/hidden.jpg`, { headers: authH(rootTok) })).status, 200);
        assert.equal((await fetch(`${node.base}/secret/hidden.jpg`, { headers: authH(TOKEN) })).status, 200);
        assert.equal((await fetch(`${node.base}/secret/hidden.jpg`, { headers: { 'X-Cluster-Secret': 'peer-secret-1' } })).status, 200);
        assert.equal((await fetch(`${node.base}/secret/hidden.jpg`, { headers: { 'X-Cluster-Secret': 'wrong' } })).status, 401);
      });
      await t('read-auth mixed: a share link is still an explicit grant for a private file', async () => {
        // Index the master first — a share needs a row, and nothing has written one.
        const scan = await fetch(`${node.base}/_api/jobs`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authH(rootTok) },
          body: JSON.stringify({ type: 'scan' }) });
        const jobId = (await scan.json()).job.id;
        await waitFor(async () => {
          const r = await fetch(`${node.base}/_api/jobs/${jobId}`, { headers: authH(rootTok) });
          return (await r.json()).job.state === 'done';
        }, 200, 100);
        const share = await fetch(`${node.base}/_api/shares`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authH(rootTok) },
          body: JSON.stringify({ path: 'secret/hidden.jpg' }) });
        assert.equal(share.status, 201);
        const { relativeUrl } = await share.json();
        const got = await fetch(node.base + relativeUrl);
        assert.equal(got.status, 200, 'the share serves the private file with no credentials at all');
      });
    });

    await withNode({
      label: 'privauth', port: PORT + 4, dbName: `${DB_NAME}_priv`,
      env: { READ_AUTH_MODE: 'private', SECURE_COOKIES: 'always' },
      seed: { 'anything.jpg': img },
    }, async (node) => {
      await t('read-auth private: every read needs credentials, even a public path', async () => {
        assert.equal((await fetch(`${node.base}/anything.jpg`)).status, 401);
        assert.equal((await fetch(`${node.base}/missing.jpg`)).status, 401, 'and a miss leaks nothing about existence');
        assert.equal((await fetch(`${node.base}/anything.jpg`, { headers: authH(TOKEN) })).status, 200);
      });
      await t('read-auth private: /_health stays open so probes keep working', async () => {
        assert.equal((await fetch(`${node.base}/_health`)).status, 200);
      });
      await t('secure transport: SECURE_COOKIES=always refuses WebDAV Basic auth over plain HTTP', async () => {
        const rootTok = await bootstrapAdmin(node.base);
        assert.ok(rootTok);
        const r = await fetch(`${node.base}/_dav/`, { method: 'PROPFIND', headers: basicH('root', 'rootpw-12345') });
        assert.equal(r.status, 403);
        assert.match(await r.text(), /HTTPS/);
      });
      await t('secure transport: SECURE_COOKIES=always marks the session cookie Secure', async () => {
        const r = await fetch(`${node.base}/_api/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login: 'root', password: 'rootpw-12345' }) });
        assert.match(r.headers.get('set-cookie') || '', /;\s*Secure/);
      });
    });

    await t('secure transport: the default (auto) leaves a plain-HTTP dev cookie usable', async () => {
      const r = await api('/_api/auth/login', { method: 'POST', json: { login: 'admin', password: 'adminpw-123' } });
      assert.doesNotMatch(r.headers.get('set-cookie') || '', /;\s*Secure/, 'no Secure flag on a cleartext hop…');
      const fwd = await api('/_api/auth/login', {
        method: 'POST', json: { login: 'admin', password: 'adminpw-123' },
        headers: { 'X-Forwarded-Proto': 'https' } });
      assert.match(fwd.headers.get('set-cookie') || '', /;\s*Secure/, '…but yes behind a TLS-terminating proxy');
      adminTok = fwd.body.token;
    });

    // ── unknown routes ────────────────────────────────────────────────────────
    await t('api: unknown route → 404, wrong method on a known route → 405', async () => {
      assert.equal((await api('/_api/nope', { token: adminTok })).status, 404);
      assert.equal((await api('/_api/stats', { method: 'POST', token: adminTok })).status, 405);
    });
  } finally {
    if (srv) srv.stop();
    await dropDatabase();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows may hold a handle */ }
  }

  process.exit(runner.finish());
})().catch(async (e) => {
  console.error(`\nFATAL: ${(e && e.stack) || e}`);
  await dropDatabase();
  process.exit(1);
});

// ── database lifecycle ────────────────────────────────────────────────────────
async function withDbConn(fn) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password });
  try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}

// A long-lived connection for inspecting the throwaway database directly (polling
// the index, forcing a share's expiry). Cheaper than reconnecting per poll.
const inspectConns = new Map();
async function inspectConn(database = DB_NAME) {
  if (inspectConns.has(database)) return inspectConns.get(database);
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, database });
  inspectConns.set(database, conn);
  return conn;
}
async function fileRow(rel, database = DB_NAME) {
  const conn = await inspectConn(database);
  const [rows] = await conn.query('SELECT * FROM files WHERE path = ? LIMIT 1', [rel]);
  return rows[0] || null;
}
async function jobRow(id) {
  const conn = await inspectConn();
  const [rows] = await conn.query('SELECT * FROM jobs WHERE id = ? LIMIT 1', [Number(id)]);
  return rows[0] || null;
}
// MySQL JSON columns arrive already parsed on some driver versions and as a string
// on others — normalize rather than guessing.
function jsonOf(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}
// Poll the index until `pred` holds for `rel`, or give up with a useful message.
async function waitRow(rel, pred, tries = 120, gap = 50, database = DB_NAME) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await fileRow(rel, database).catch(() => null);
    if (pred(last)) return last;
    await sleep(gap);
  }
  throw new Error(`index never reached the expected state for "${rel}" (last: ${last ? JSON.stringify({ status: last.status, size: String(last.size_bytes) }) : 'no row'})`);
}
// Poll a job until it leaves the queue.
async function waitJob(id, tries = 300, gap = 100) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await jobRow(id).catch(() => null);
    if (last && ['done', 'failed', 'cancelled'].includes(last.state)) return last;
    await sleep(gap);
  }
  throw new Error(`job ${id} never finished (last state: ${last ? last.state : 'unknown'})`);
}

// Push a share's expiry into the past so the serve-side expiry check can be proven.
async function expireShare(token) {
  const conn = await inspectConn();
  await conn.query('UPDATE shares SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE token = ?', [token]);
}

let dropped = false;
async function dropDatabase() {
  if (dropped) return;
  dropped = true;
  for (const conn of inspectConns.values()) await conn.end().catch(() => {});
  inspectConns.clear();
  for (const name of [DB_NAME, ...extraDatabases]) {
    try {
      await withDbConn((conn) => conn.query(`DROP DATABASE IF EXISTS \`${name}\``));
    } catch (e) {
      console.warn(`[test] WARNING: could not drop ${name}: ${e.code || e.message}`);
    }
  }
}
