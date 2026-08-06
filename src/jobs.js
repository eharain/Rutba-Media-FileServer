'use strict';

/**
 * Background job queue + in-process worker.
 *
 * The one place asynchronous work runs: filesystem scans, metadata extraction,
 * transcodes, enrichment, integrity scrubs, expiry sweeps. Nothing that can be done
 * in the background is allowed to hold a request open, and nothing here is required
 * for the request path to work.
 *
 * Gated twice over, like every other optional layer:
 *   no database        ⇒ `enabled` is false, `enqueue()` is a no-op returning null
 *   JOBS_ENABLED=0     ⇒ the queue accepts jobs but no worker in THIS process runs
 *                        them (useful when a separate worker process owns the queue)
 *
 * Claiming is safe across processes without any lock table: a worker writes a
 * unique `lease_owner` under a conditional UPDATE ... ORDER BY ... LIMIT 1, then
 * reads back the row it won. A worker that dies mid-job leaves `lease_until` in the
 * past; the sweeper returns the job to `queued` (or fails it once attempts run out).
 * Failures back off exponentially rather than hot-looping.
 *
 * Handlers are registered per type. A job whose type has no handler in this process
 * is simply never claimed here — so a deployment without ffmpeg leaves transcode
 * jobs queued for a node that has it, instead of failing them.
 *
 * SCOPE: workers sharing a queue are assumed to share a view of the storage volumes.
 * Clustering (src/cluster.js) replicates FILES between nodes, not database rows —
 * each node runs its own database and therefore its own queue. Pointing two nodes
 * with different disks at one database is not a supported topology.
 */

const crypto = require('crypto');

const DEFAULT_LEASE_SECONDS = 300;

function createJobs({ db, config }) {
  const on = () => !!(db && db.enabled);
  const handlers = new Map();          // type -> { fn, leaseSeconds }
  const running = new Map();           // job id -> promise
  const workerId = `${hostLabel()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

  const concurrency = Math.max(1, parseInt(config.jobsConcurrency, 10) || 2);
  const pollMs = Math.max(100, parseInt(config.jobsPollMs, 10) || 1000);
  const defaultMaxAttempts = Math.max(1, parseInt(config.jobsMaxAttempts, 10) || 5);
  const workerEnabled = config.jobsEnabled !== false;

  let timer = null;
  let stopped = false;
  let ticking = false;

  const jobs = {
    get enabled() { return on(); },
    get workerRunning() { return !!timer; },
    workerId,
    concurrency,
    types: () => [...handlers.keys()].sort(),

    /** Register a handler for a job type. `fn(payload, ctx)` may return a JSON result. */
    register(type, fn, { leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
      handlers.set(type, { fn, leaseSeconds });
      return jobs;
    },

    /**
     * Queue a job. Returns its id, or null when the queue is off.
     *
     * `dedupeKey` is unique among live jobs, so re-queuing the same work while it is
     * still pending returns the EXISTING job rather than piling up duplicates — the
     * difference between one scan and four hundred.
     */
    async enqueue(type, payload = {}, { priority = 5, dedupeKey = null, runAfterMs = 0, maxAttempts = defaultMaxAttempts, createdBy = null } = {}) {
      if (!on()) return null;
      try {
        if (dedupeKey) {
          const live = await db.one(
            "SELECT id FROM jobs WHERE dedupe_key = ? AND state IN ('queued','running') LIMIT 1", [dedupeKey]);
          if (live) return Number(live.id);
        }
        const res = await db.query(
          `INSERT INTO jobs (type, payload, priority, dedupe_key, max_attempts, created_by, run_after)
           VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
          [type, JSON.stringify(payload || {}), priority, dedupeKey, maxAttempts, createdBy,
           Math.max(0, Math.round(runAfterMs / 1000))]);
        return Number(res.insertId);
      } catch (e) {
        // A duplicate-key race just means someone else queued the same work.
        if (e && e.code === 'ER_DUP_ENTRY' && dedupeKey) {
          const live = await db.one('SELECT id FROM jobs WHERE dedupe_key = ? LIMIT 1', [dedupeKey]).catch(() => null);
          if (live) return Number(live.id);
        }
        console.warn(`[media] jobs.enqueue(${type}) failed: ${e.code || e.message}`);
        return null;
      }
    },

    async get(id) {
      if (!on()) return null;
      const row = await db.one('SELECT * FROM jobs WHERE id = ?', [Number(id)]).catch(() => null);
      return row ? shape(row) : null;
    },

    async list({ state = null, type = null, limit = 50, offset = 0 } = {}) {
      if (!on()) return { jobs: [], total: 0 };
      const where = [], args = [];
      if (state) { where.push('state = ?'); args.push(state); }
      if (type) { where.push('type = ?'); args.push(type); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = await db.one(`SELECT COUNT(*) AS n FROM jobs ${clause}`, args);
      const rows = await db.query(
        `SELECT * FROM jobs ${clause} ORDER BY id DESC LIMIT ${Math.min(500, Math.max(1, limit))} OFFSET ${Math.max(0, offset)}`, args);
      return { jobs: rows.map(shape), total: total ? Number(total.n) : rows.length };
    },

    /** Summary counts by state — what the console's jobs panel shows at a glance. */
    async summary() {
      if (!on()) return {};
      const rows = await db.query('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').catch(() => []);
      const out = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
      for (const r of rows) out[r.state] = Number(r.n);
      return out;
    },

    /** Cancel a job that has not finished. A running job is cancelled cooperatively. */
    async cancel(id) {
      if (!on()) return false;
      const res = await db.query(
        "UPDATE jobs SET state='cancelled', dedupe_key=NULL, finished_at=NOW() WHERE id=? AND state IN ('queued','running')",
        [Number(id)]).catch(() => null);
      return !!(res && res.affectedRows);
    },

    /** Re-queue a failed/cancelled job with its attempt count reset. */
    async retry(id) {
      if (!on()) return false;
      const res = await db.query(
        "UPDATE jobs SET state='queued', attempts=0, error=NULL, run_after=NOW(), lease_until=NULL, lease_owner=NULL " +
        "WHERE id=? AND state IN ('failed','cancelled','done')", [Number(id)]).catch(() => null);
      return !!(res && res.affectedRows);
    },

    /** Start the worker loop. Safe to call when disabled — it just does nothing. */
    start() {
      if (!on() || !workerEnabled || timer || !handlers.size) return jobs;
      stopped = false;
      timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
      if (timer.unref) timer.unref(); // never hold the process open
      console.log(`[media] jobs: worker on — ${concurrency} slot(s), types: ${jobs.types().join(', ')}`);
      return jobs;
    },

    async stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      await Promise.allSettled([...running.values()]);
    },

    /** Run one claim/execute pass. Exposed so tests can drive the queue directly. */
    tick,
  };

  return jobs;

  // ── worker loop ─────────────────────────────────────────────────────────────
  async function tick() {
    if (!on() || stopped || ticking) return;
    ticking = true;
    try {
      await reclaimExpired();
      while (!stopped && running.size < concurrency) {
        const job = await claim();
        if (!job) break;
        const p = execute(job).finally(() => running.delete(job.id));
        running.set(job.id, p);
      }
    } catch (e) {
      console.warn(`[media] jobs: worker tick failed: ${e.code || e.message}`);
    } finally {
      ticking = false;
    }
  }

  // Return jobs whose worker died (lease expired) to the queue, or fail them for good.
  async function reclaimExpired() {
    await db.query(
      `UPDATE jobs SET state='queued', lease_until=NULL, lease_owner=NULL,
              error=CONCAT('lease expired after attempt ', attempts)
       WHERE state='running' AND lease_until IS NOT NULL AND lease_until < NOW() AND attempts < max_attempts`).catch(() => {});
    await db.query(
      `UPDATE jobs SET state='failed', dedupe_key=NULL, finished_at=NOW(), lease_until=NULL, lease_owner=NULL,
              error=COALESCE(NULLIF(error,''), 'lease expired and attempts exhausted')
       WHERE state='running' AND lease_until IS NOT NULL AND lease_until < NOW() AND attempts >= max_attempts`).catch(() => {});
  }

  // Atomically take the next runnable job of a type this process can handle.
  async function claim() {
    const types = [...handlers.keys()];
    if (!types.length) return null;
    const ticket = `${workerId}#${crypto.randomBytes(6).toString('hex')}`;
    const placeholders = types.map(() => '?').join(',');
    const lease = Math.max(...types.map((t) => handlers.get(t).leaseSeconds));
    const res = await db.query(
      `UPDATE jobs
          SET state='running', lease_owner=?, lease_until=DATE_ADD(NOW(), INTERVAL ? SECOND),
              attempts=attempts+1, started_at=COALESCE(started_at, NOW())
        WHERE state='queued' AND run_after <= NOW() AND type IN (${placeholders})
        ORDER BY priority ASC, id ASC
        LIMIT 1`,
      [ticket, lease, ...types]);
    if (!res || !res.affectedRows) return null;
    const row = await db.one("SELECT * FROM jobs WHERE lease_owner = ? AND state='running' LIMIT 1", [ticket]);
    return row ? shape(row) : null;
  }

  async function execute(job) {
    const h = handlers.get(job.type);
    if (!h) { await finish(job.id, 'queued', null, 'no handler in this process'); return; }
    const ctx = {
      id: job.id,
      attempts: job.attempts,
      // Whatever the previous attempt recorded — how a long job resumes instead of
      // starting over after a crash or a lease expiry.
      initialProgress: job.progress,
      // Long jobs renew their lease so the sweeper doesn't reclaim live work.
      async heartbeat(progress) {
        await db.query(
          'UPDATE jobs SET lease_until = DATE_ADD(NOW(), INTERVAL ? SECOND), progress = COALESCE(?, progress) WHERE id = ?',
          [h.leaseSeconds, progress ? JSON.stringify(progress) : null, job.id]).catch(() => {});
      },
      // Cooperative cancellation: a long job checks this between units of work.
      async cancelled() {
        const r = await db.one('SELECT state FROM jobs WHERE id = ?', [job.id]).catch(() => null);
        return !r || r.state === 'cancelled';
      },
      log(msg) { console.log(`[media] job ${job.id} (${job.type}): ${msg}`); },
    };

    try {
      const result = await h.fn(job.payload || {}, ctx);
      // A job cancelled while it ran keeps the cancelled state.
      const cur = await db.one('SELECT state FROM jobs WHERE id = ?', [job.id]).catch(() => null);
      if (cur && cur.state === 'cancelled') return;
      await finish(job.id, 'done', result);
    } catch (e) {
      const msg = String((e && e.stack) || e).slice(0, 4000);
      if (job.attempts >= job.maxAttempts) {
        await finish(job.id, 'failed', null, msg);
        console.warn(`[media] job ${job.id} (${job.type}) failed permanently: ${(e && e.message) || e}`);
      } else {
        // Exponential backoff: 2^attempts seconds, capped at 10 minutes.
        const delay = Math.min(600, Math.pow(2, job.attempts));
        await db.query(
          `UPDATE jobs SET state='queued', lease_until=NULL, lease_owner=NULL, error=?,
                  run_after=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=?`,
          [msg, delay, job.id]).catch(() => {});
        console.warn(`[media] job ${job.id} (${job.type}) attempt ${job.attempts} failed, retrying in ${delay}s: ${(e && e.message) || e}`);
      }
    }
  }

  // Terminal transition. `dedupe_key` is released so equivalent work can be queued
  // again later (NULLs don't collide in a MySQL unique index).
  async function finish(id, state, result, error) {
    await db.query(
      `UPDATE jobs SET state=?, result=?, error=?, dedupe_key=NULL, lease_until=NULL, lease_owner=NULL,
              finished_at=NOW() WHERE id=?`,
      [state, result != null ? JSON.stringify(result) : null, error || null, id]).catch(() => {});
  }
}

// Normalize a DB row: JSON columns arrive parsed on some drivers and as strings on
// others, and BIGINTs as strings.
function shape(row) {
  return {
    ...row,
    id: Number(row.id),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    payload: parseJson(row.payload) || {},
    progress: parseJson(row.progress),
    result: parseJson(row.result),
  };
}
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}
function hostLabel() {
  try { return require('os').hostname().slice(0, 40); } catch { return 'node'; }
}

module.exports = { createJobs };
