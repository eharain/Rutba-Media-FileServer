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

// Upload a master as a platform user (session/API bearer token) or with UPLOAD_TOKEN.
async function put(rel, buf, { token = TOKEN, headers = {} } = {}) {
  const res = await fetch(`${BASE}/${rel}`, { method: 'PUT', headers: { ...authH(token), ...headers }, body: buf });
  return { status: res.status, body: await res.text().then((s) => { try { return JSON.parse(s); } catch { return s; } }) };
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
      const del = await fetch(`${BASE}/trashme/doc.jpg`, { method: 'DELETE', headers: authH(editorTok) });
      assert.equal(del.status, 204);
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
      await fetch(`${BASE}/trashme/doc.jpg`, { method: 'DELETE', headers: authH(editorTok) });
      assert.equal((await api('/_api/files/purge', { method: 'POST', token: editorTok, json: { path: 'trashme/doc.jpg' } })).status, 200);
      const gone = (await api('/_api/files?status=all&q=trashme', { token: adminTok })).body.files;
      assert.ok(!gone.some((f) => f.path === 'trashme/doc.jpg'), 'row is gone');
      const r = await api('/_api/files/restore', { method: 'POST', token: editorTok, json: { path: 'trashme/doc.jpg' } });
      assert.equal(r.status, 404, 'nothing left to restore');
    });

    await t('trash: empty-trash is admin-only and purges everything trashed', async () => {
      await put('bulk/a.jpg', img, { token: editorTok });
      await put('bulk/b.jpg', img2, { token: editorTok });
      for (const p of ['bulk/a.jpg', 'bulk/b.jpg']) await fetch(`${BASE}/${p}`, { method: 'DELETE', headers: authH(editorTok) });
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
      assert.equal((await fetch(`${BASE}/archive/old.jpg`, { method: 'DELETE', headers: authH(editorTok) })).status, 204);
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
      // …and it is indexed like any other write.
      assert.ok((await api('/_api/files?q=dav/new.png', { token: adminTok })).body.files.length === 1);
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

// Push a share's expiry into the past so the serve-side expiry check can be proven.
async function expireShare(token) {
  await withDbConn(async (conn) => {
    await conn.query(`USE \`${DB_NAME}\``);
    await conn.query('UPDATE shares SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE token = ?', [token]);
  });
}

let dropped = false;
async function dropDatabase() {
  if (dropped) return;
  dropped = true;
  try {
    await withDbConn((conn) => conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``));
  } catch (e) {
    console.warn(`[test] WARNING: could not drop ${DB_NAME}: ${e.code || e.message}`);
  }
}
