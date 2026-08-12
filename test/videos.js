'use strict';
/**
 * Video control-plane suite (`/_api/videos`) — no database, no server process.
 *
 * The platform suite (platform.js) covers these routes end-to-end over real HTTP
 * against real MySQL, and that is where the wire behaviour is proven. This suite
 * exists because the parts most likely to be WRONG need no database to test:
 *
 *   - folder derivation and the ancestor roll-up (pure arithmetic over paths);
 *   - duration, which has no column and has to be dug out of a JSON blob whose shape
 *     depends on which build wrote the row;
 *   - the auth rule, which is the whole reason this namespace exists — a machine
 *     holding only the UPLOAD_TOKEN must get in, an anonymous caller must not;
 *   - the SQL the filter builds, asserted as clause + bound args, so "every value is
 *     bound" is a checked property rather than a convention.
 *
 * The real `createApiHandler` is constructed over stub services and driven through
 * its real dispatcher, so route registration in api.js is exercised too — a handler
 * that works but was never wired up is the failure this catches.
 *
 *   node test/videos.js
 */

const assert = require('assert');
const { Readable } = require('stream');
const { Runner } = require('./harness');
const { createApiHandler } = require('../src/handlers/api');
const { videoFilter, foldersFromPaths, durationFromRaw, dirOf, videoUrl } = require('../src/handlers/videos');

const TOKEN = 'service-upload-token';

// ── fixtures ──────────────────────────────────────────────────────────────────
const VIDEOS = [
  row(1, 'clips/2026/a.mp4', 1000, { width: 1920, height: 1080 }),
  row(2, 'clips/2026/b.mov', 2000, { width: null, height: null }),   // dims only in metadata
  row(3, 'root.mp4', 300, { width: 640, height: 360 }),              // volume root → folder ''
  row(4, 'clips/old/c.webm', 500, { width: 1280, height: 720 }),
  row(5, 'clips/2026/my clip.mp4', 700, { width: 640, height: 480 }),
];

// One row per shape `raw` is known to arrive in. mysql2 hands a JSON column back
// parsed on some drivers and as text on others, so both are represented.
const METADATA = [
  { file_id: 1, width: null, height: null, raw: JSON.stringify({ durationSec: 12.5, videoCodec: 'h264', fps: 25 }) },
  { file_id: 2, width: 640, height: 480, raw: { format: { duration: '8.25' } } },
  { file_id: 4, width: null, height: null, raw: JSON.stringify({ streams: [{ codec_type: 'audio' }, { duration: '3' }] }) },
  { file_id: 5, width: null, height: null, raw: 'not json at all' },
  // file 3 has no metadata row at all.
];

// file 1 carries two tags, file 2 one, the rest none — so a page mixes tagged and
// untagged clips, which is where a JOIN-based implementation would drop rows.
const FILE_TAGS = [
  { file_id: 1, name: 'b-roll' },
  { file_id: 1, name: 'wedding' },
  { file_id: 2, name: 'b-roll' },
];

function row(id, path, size, { width, height }) {
  return {
    id, path, name: path.slice(path.lastIndexOf('/') + 1), ext: path.slice(path.lastIndexOf('.')),
    mime: 'video/mp4', size_bytes: size, width, height,
    visibility: 'public', status: 'active',
    created_at: '2026-08-01 10:00:00', updated_at: '2026-08-02 11:00:00',
  };
}

// ── stub services ─────────────────────────────────────────────────────────────
/**
 * A database that answers the four shapes these handlers issue and records every
 * call, so a test can assert on the SQL and its bound arguments.
 */
function makeDb({ enabled = true } = {}) {
  const calls = [];
  const query = async (sql, args = []) => {
    calls.push({ sql, args });
    if (/audit_log/.test(sql)) return { affectedRows: 1 };
    // Before the generic COUNT branch below: the tag facet is itself a
    // `COUNT(*) AS n … FROM files` (in its subquery) and would be swallowed by it.
    if (/GROUP BY t\.name/.test(sql)) return [{ name: 'b-roll', n: 2 }, { name: 'wedding', n: 1 }];
    if (/SUM\(size_bytes\),0\) AS bytes/.test(sql)) return [{ n: VIDEOS.length, bytes: 4500 }];
    if (/COUNT\(\*\) AS n[\s\S]*FROM files/.test(sql)) return [{ n: VIDEOS.length }];
    if (/SELECT id, path, name, ext, mime/.test(sql)) return VIDEOS;
    if (/FROM file_metadata WHERE file_id IN/.test(sql)) return METADATA.filter((m) => args.includes(m.file_id));
    if (/FROM file_tags ft/.test(sql)) return FILE_TAGS.filter((t) => args.includes(t.file_id));
    if (/SELECT path, size_bytes FROM files/.test(sql)) return VIDEOS.map((v) => ({ path: v.path, size_bytes: v.size_bytes }));
    if (/MAX\(finished_at\)/.test(sql)) return [{ at: '2026-08-02 09:00:00' }];
    if (/FROM jobs WHERE type = \?/.test(sql)) {
      return [{ id: 77, type: 'scan', state: 'running', created_at: 'c', started_at: 's', finished_at: null, error: null, live: 1 }];
    }
    return [];
  };
  return { enabled, calls, query, one: async (s, a) => { const r = await query(s, a); return Array.isArray(r) && r.length ? r[0] : null; } };
}

// Bearer `user:<role>` resolves to a platform user with that role; anything else
// (including the upload token) is not a user, which is exactly the case that must
// still be allowed through by the service rule.
function makeAuth() {
  return {
    async authenticate(req) {
      const h = req.headers.authorization || '';
      const m = /^Bearer\s+user:(\w+)$/i.exec(h);
      if (!m) return null;
      return { user: { id: 9, username: 'someone' }, roles: [m[1]] };
    },
  };
}

function makeJobs({ enabled = true } = {}) {
  const enqueued = [];
  return {
    enabled,
    enqueued,
    async enqueue(type, payload, opts) { enqueued.push({ type, payload, opts }); return 4242; },
    async get(id) { return { id, type: 'scan', state: 'queued' }; },
  };
}

// ── request/response doubles ──────────────────────────────────────────────────
function makeReq({ method = 'GET', headers = {}, body = null } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.headers = { host: 'media.test', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function makeRes() {
  const res = {
    status: null, body: null, headers: {},
    setHeader(k, v) { res.headers[k] = v; },
    writeHead(code, h) { res.status = code; Object.assign(res.headers, h || {}); return res; },
    end(payload) { try { res.body = payload ? JSON.parse(payload) : null; } catch { res.body = payload; } },
  };
  return res;
}

// Drive a request through the REAL dispatcher, so route registration counts.
async function call(handler, pathname, opts = {}) {
  const url = new URL(pathname, 'http://media.test');
  const res = makeRes();
  await handler(makeReq(opts), res, url);
  return res;
}

function build({ db = makeDb(), jobs = makeJobs() } = {}) {
  const handler = createApiHandler({
    config: { uploadToken: TOKEN, sessionTtlDays: 30, secureCookies: 'never' },
    db, auth: makeAuth(), trash: {}, storage: {}, jobs,
  });
  return { handler, db, jobs };
}

// ── the suite ─────────────────────────────────────────────────────────────────
const runner = new Runner('video control-plane suite (no database — stubbed services)');
const t = runner.t.bind(runner);

(async () => {
  // ── folder derivation & aggregation ────────────────────────────────────────
  await t('folder is the directory portion of the path, and empty at the volume root', () => {
    assert.equal(dirOf('clips/2026/a.mp4'), 'clips/2026');
    assert.equal(dirOf('root.mp4'), '');
    assert.equal(dirOf(''), '');
  });

  await t('folders roll counts and bytes up through every ancestor', () => {
    const folders = foldersFromPaths(VIDEOS.map((v) => ({ path: v.path, size_bytes: v.size_bytes })));
    const at = (p) => folders.find((f) => f.path === p);
    // clips/ holds 2026 (3 clips) + old (1); root.mp4 belongs to no folder at all.
    assert.deepEqual(folders.map((f) => f.path), ['clips', 'clips/2026', 'clips/old']);
    assert.equal(at('clips').videos, 4);
    assert.equal(at('clips').bytes, 1000 + 2000 + 700 + 500);
    assert.equal(at('clips/2026').videos, 3);
    assert.equal(at('clips/2026').bytes, 1000 + 2000 + 700);
    assert.equal(at('clips/old').videos, 1);
  });

  await t('folders carry name and parent, with null parent at the top level', () => {
    const folders = foldersFromPaths([{ path: 'a/b/c/x.mp4', size_bytes: 1 }]);
    assert.deepEqual(folders.map((f) => [f.path, f.name, f.parent]),
      [['a', 'a', null], ['a/b', 'b', 'a'], ['a/b/c', 'c', 'a/b']]);
  });

  await t('GET /_api/videos/folders returns the aggregate', async () => {
    const { handler } = build();
    const res = await call(handler, '/_api/videos/folders', { headers: { 'x-upload-token': TOKEN } });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.folders[0].path, 'clips');
  });

  // ── duration extraction ────────────────────────────────────────────────────
  await t('duration reads durationSec — the shape metadata.js normalizeProbe writes', () => {
    assert.equal(durationFromRaw(JSON.stringify({ durationSec: 12.5 })), 12.5);
    assert.equal(durationFromRaw({ durationSec: 4 }), 4);           // already-parsed JSON column
  });

  await t('duration falls back through format.duration and streams[].duration', () => {
    assert.equal(durationFromRaw({ format: { duration: '8.25' } }), 8.25);
    assert.equal(durationFromRaw({ streams: [{ codec_type: 'audio' }, { duration: '3' }] }), 3);
    assert.equal(durationFromRaw({ duration: 60 }), 60);
  });

  await t('duration is null when absent, empty, unparseable or not a number', () => {
    assert.equal(durationFromRaw(null), null);
    assert.equal(durationFromRaw('not json at all'), null);
    assert.equal(durationFromRaw({}), null);
    assert.equal(durationFromRaw({ durationSec: '' }), null);
    assert.equal(durationFromRaw({ durationSec: 'N/A' }), null);
    assert.equal(durationFromRaw({ format: { duration: -1 } }), null);
  });

  await t('GET /_api/videos projects duration, folder, url and the dimension fallback', async () => {
    const { handler } = build();
    const res = await call(handler, '/_api/videos', { headers: { 'x-upload-token': TOKEN } });
    assert.equal(res.status, 200);
    const by = (id) => res.body.videos.find((v) => v.id === id);
    assert.equal(res.body.total, VIDEOS.length);
    assert.equal(by(1).duration, 12.5);
    assert.equal(by(2).duration, 8.25);
    assert.equal(by(4).duration, 3);
    assert.equal(by(3).duration, null, 'no metadata row at all');
    assert.equal(by(5).duration, null, 'unparseable raw');
    assert.equal(by(1).folder, 'clips/2026');
    assert.equal(by(3).folder, '', 'root file');
    // files.width wins; the file_metadata value is only a fallback.
    assert.equal(by(1).width, 1920);
    assert.equal(by(2).width, 640, 'fell back to file_metadata');
    assert.equal(by(2).height, 480);
    assert.equal(by(1).url, '/clips/2026/a.mp4');
    assert.equal(by(5).url, '/clips/2026/my%20clip.mp4', 'url is percent-encoded');
  });

  // ── auth: the whole reason this namespace exists ───────────────────────────
  await t('an anonymous caller is refused with 401', async () => {
    const { handler } = build();
    for (const p of ['/_api/videos', '/_api/videos/folders', '/_api/videos/scan']) {
      const res = await call(handler, p);
      assert.equal(res.status, 401, `${p} must not be readable anonymously`);
      assert.equal(res.body.error, 'unauthorized');
    }
  });

  await t('the upload token is accepted, as a bearer and as X-Upload-Token', async () => {
    const { handler } = build();
    assert.equal((await call(handler, '/_api/videos', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
    assert.equal((await call(handler, '/_api/videos', { headers: { 'x-upload-token': TOKEN } })).status, 200);
  });

  await t('a wrong token of the SAME length is refused (timing-safe compare, not a crash)', async () => {
    const { handler } = build();
    const wrong = 'x'.repeat(TOKEN.length);
    assert.equal(wrong.length, TOKEN.length);
    assert.equal((await call(handler, '/_api/videos', { headers: { 'x-upload-token': wrong } })).status, 401);
    assert.equal((await call(handler, '/_api/videos', { headers: { 'x-upload-token': 'short' } })).status, 401);
  });

  await t('any authenticated user may read', async () => {
    const { handler } = build();
    assert.equal((await call(handler, '/_api/videos', { headers: { authorization: 'Bearer user:viewer' } })).status, 200);
  });

  await t('with no upload token configured, the token path grants nothing', async () => {
    const handler = createApiHandler({
      config: { uploadToken: '' }, db: makeDb(), auth: makeAuth(), trash: {}, storage: {}, jobs: makeJobs(),
    });
    const res = await call(handler, '/_api/videos', { headers: { 'x-upload-token': '' } });
    assert.equal(res.status, 401);
  });

  // ── scan trigger ───────────────────────────────────────────────────────────
  await t('POST /_api/videos/scan queues the EXISTING scan job under the boot dedupe key', async () => {
    const { handler, jobs } = build();
    const res = await call(handler, '/_api/videos/scan',
      { method: 'POST', headers: { 'x-upload-token': TOKEN }, body: { folder: '/clips/2026/' } });
    assert.equal(res.status, 202);
    assert.equal(res.body.queued, true);
    assert.equal(res.body.job.type, 'scan');
    assert.equal(jobs.enqueued.length, 1);
    assert.equal(jobs.enqueued[0].type, 'scan', 'reuses the registered scan job, never a new scanner');
    assert.equal(jobs.enqueued[0].payload.folder, 'clips/2026', 'folder is normalized and recorded');
    // Same key server.js uses for the boot scan, so a live scan is returned rather
    // than a second walk of the disk being started behind it.
    assert.equal(jobs.enqueued[0].opts.dedupeKey, 'scan:all');
  });

  await t('scan is an execution surface: a signed-in viewer gets 403, an admin 202', async () => {
    const { handler } = build();
    const viewer = await call(handler, '/_api/videos/scan', { method: 'POST', headers: { authorization: 'Bearer user:viewer' } });
    assert.equal(viewer.status, 403);
    assert.equal(viewer.body.error, 'forbidden');
    const admin = await call(handler, '/_api/videos/scan', { method: 'POST', headers: { authorization: 'Bearer user:admin' } });
    assert.equal(admin.status, 202);
  });

  await t('with the queue unavailable the scan trigger says so (503), never throws', async () => {
    const { handler } = build({ jobs: makeJobs({ enabled: false }) });
    const res = await call(handler, '/_api/videos/scan', { method: 'POST', headers: { 'x-upload-token': TOKEN } });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'jobs_disabled');
  });

  await t('GET /_api/videos/scan reports the live job plus library totals', async () => {
    const { handler } = build();
    const res = await call(handler, '/_api/videos/scan', { headers: { 'x-upload-token': TOKEN } });
    assert.equal(res.status, 200);
    assert.equal(res.body.job.id, 77);
    assert.equal(res.body.job.state, 'running');
    assert.equal(res.body.videos, VIDEOS.length);
    assert.equal(res.body.bytes, 4500);
    assert.equal(res.body.lastCompletedAt, '2026-08-02 09:00:00');
  });

  // ── the SQL these routes build ─────────────────────────────────────────────
  await t('the filter pins status=active and mime video/, and binds both', () => {
    const { clause, args } = videoFilter({});
    assert.ok(/status = \?/.test(clause));
    assert.ok(/mime LIKE \?/.test(clause));
    assert.deepEqual(args, ['active', 'video/%']);
  });

  await t('recursive=0 lists a folder\'s immediate children; recursive=1 the whole subtree', () => {
    const direct = videoFilter({ folder: 'clips/2026', recursive: false });
    assert.deepEqual(direct.args.slice(2), ['clips/2026/%', 'clips/2026/%/%']);
    assert.ok(/NOT LIKE/.test(direct.clause), 'a deeper path is excluded');
    const under = videoFilter({ folder: 'clips/2026', recursive: true });
    assert.deepEqual(under.args.slice(2), ['clips/2026/%']);
    assert.ok(!/NOT LIKE/.test(under.clause));
  });

  await t('a folder prefix is escaped, so my_videos cannot match myXvideos', () => {
    const { clause, args } = videoFilter({ folder: '/my_videos/50%/', recursive: true });
    assert.deepEqual(args.slice(2), ['my!_videos/50!%/%']);
    assert.ok(/ESCAPE '!'/.test(clause));
  });

  await t('q searches path and name, and no caller value is ever interpolated', () => {
    const { clause, args } = videoFilter({ q: "wed'ding", folder: 'clips', recursive: true });
    assert.deepEqual(args, ['active', "%wed'ding%", "%wed'ding%", 'video/%', 'clips/%']);
    for (const v of args) assert.ok(!clause.includes(v), `"${v}" leaked into the SQL text`);
  });

  await t('tag filters through the shared subquery, bound and never interpolated', () => {
    const { clause, args } = videoFilter({ tag: "b-roll'; DROP" });
    assert.ok(/file_tags/.test(clause) && /t\.name = \?/.test(clause));
    assert.deepEqual(args, ['active', 'video/%', "b-roll'; DROP"]);
    for (const v of args) assert.ok(!clause.includes(v), `"${v}" leaked into the SQL text`);
  });

  await t('the date window is created_at, so a re-tagged clip does not look new', () => {
    const { clause, args } = videoFilter({ since: '2026-08-01 00:00:00', until: '2026-08-12 23:59:59' });
    assert.ok(/created_at >= \?/.test(clause), 'lower bound is created_at');
    assert.ok(/created_at <= \?/.test(clause), 'upper bound is created_at');
    assert.ok(!/updated_at/.test(clause), 'updated_at must not answer an "uploaded between" question');
    assert.deepEqual(args.slice(2), ['2026-08-01 00:00:00', '2026-08-12 23:59:59']);
  });

  await t('each listed clip carries its tags, and an untagged one carries []', async () => {
    const { handler } = build();
    const res = await call(handler, '/_api/videos', { headers: { 'x-upload-token': TOKEN } });
    assert.equal(res.status, 200);
    const byId = new Map(res.body.videos.map((v) => [v.id, v]));
    assert.deepEqual(byId.get(1).tags, ['b-roll', 'wedding']);
    assert.deepEqual(byId.get(2).tags, ['b-roll']);
    assert.deepEqual(byId.get(3).tags, [], 'an untagged clip is [], never undefined');
    // A JOIN would have multiplied file 1 by its two tags and broken the page.
    assert.equal(res.body.videos.length, VIDEOS.length);
  });

  await t('the tag facet counts video only, and is scoped to the folder in view', async () => {
    const { handler, db } = build();
    const res = await call(handler, '/_api/videos/tags?folder=clips/2026&recursive=1',
      { headers: { 'x-upload-token': TOKEN } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.tags, [{ name: 'b-roll', count: 2 }, { name: 'wedding', count: 1 }]);
    const q = db.calls.find((c) => /GROUP BY t\.name/.test(c.sql));
    assert.ok(/FROM files WHERE/.test(q.sql.replace(/\s+/g, ' ')), 'counted over the video filter, not every file');
    assert.ok(q.args.includes('video/%'), 'video-only');
    assert.ok(q.args.includes('clips/2026/%'), 'folder-scoped');
  });

  await t('an anonymous caller cannot read the tag facet', async () => {
    const { handler } = build();
    const res = await call(handler, '/_api/videos/tags');
    assert.equal(res.status, 401);
  });

  await t('limit/offset are clamped integers, never caller text', async () => {
    const { handler, db } = build();
    await call(handler, '/_api/videos?limit=99999&offset=-5&sort=DROP%20TABLE',
      { headers: { 'x-upload-token': TOKEN } });
    const page = db.calls.find((c) => /SELECT id, path, name/.test(c.sql));
    assert.ok(/LIMIT 500 OFFSET 0/.test(page.sql), page.sql);
    assert.ok(/ORDER BY created_at DESC, id DESC/.test(page.sql), 'an unknown sort falls back, never interpolates');
  });

  await t('each sort maps to a whitelisted ORDER BY', async () => {
    for (const [sort, expected] of [['name', 'name ASC'], ['size', 'size_bytes DESC'], ['oldest', 'created_at ASC']]) {
      const { handler, db } = build();
      await call(handler, `/_api/videos?sort=${sort}`, { headers: { 'x-upload-token': TOKEN } });
      const page = db.calls.find((c) => /SELECT id, path, name/.test(c.sql));
      assert.ok(page.sql.includes(`ORDER BY ${expected}`), `${sort} → ${page.sql}`);
    }
  });

  // ── the DB-less deployment ─────────────────────────────────────────────────
  await t('without a database every video route returns the standard 503', async () => {
    const { handler } = build({ db: makeDb({ enabled: false }) });
    for (const [p, method] of [['/_api/videos', 'GET'], ['/_api/videos/folders', 'GET'], ['/_api/videos/scan', 'POST'], ['/_api/videos/scan', 'GET']]) {
      const res = await call(handler, p, { method, headers: { 'x-upload-token': TOKEN } });
      assert.equal(res.status, 503, `${method} ${p}`);
      assert.equal(res.body.error, 'db_disabled');
    }
  });

  await t('videoUrl leaves the path relative — the caller owns the origin', () => {
    assert.equal(videoUrl('a/b.mp4'), '/a/b.mp4');
    assert.equal(videoUrl('a/b c.mp4'), '/a/b%20c.mp4');
  });

  process.exit(runner.finish());
})().catch((e) => { console.error(e); process.exit(1); });
