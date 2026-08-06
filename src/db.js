'use strict';

/**
 * Optional MySQL layer. Degrades exactly like `sharp`: if `mysql2` isn't installed
 * or no DB is configured (`config.db == null`), `createDb()` returns a disabled stub
 * whose `enabled` is false and whose helpers no-op / return empty. Every caller
 * checks `db.enabled` (or relies on the no-op) so the server runs unchanged without
 * a database.
 *
 * `init()` pings the pool, ensures the target database exists, then applies the
 * idempotent schema (schema.js). It resolves to the same `db` object either way;
 * `db.enabled` reflects whether the layer actually came up. A failed init logs a
 * warning and leaves the layer disabled rather than crashing the server — masters
 * still serve.
 */

const { STATEMENTS, MIGRATIONS } = require('./schema');

let mysql = null;
try { mysql = require('mysql2/promise'); } catch { /* dependency absent → layer stays off */ }

function createDb(config) {
  const cfg = config.db;
  if (!cfg || !mysql) {
    return disabledDb(cfg && !mysql ? 'mysql2 not installed' : null);
  }

  let pool = null;
  const db = {
    enabled: false,
    config: cfg,

    // Acquire a connection and run `fn(conn)`; always releases.
    async withConn(fn) {
      const conn = await pool.getConnection();
      try { return await fn(conn); } finally { conn.release(); }
    },

    // Parameterized query → rows (SELECT) or ResultSetHeader (INSERT/UPDATE/DELETE).
    async query(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },

    // First row of a SELECT, or null.
    async one(sql, params = []) {
      const rows = await db.query(sql, params);
      return rows.length ? rows[0] : null;
    },

    async close() { if (pool) await pool.end().catch(() => {}); pool = null; db.enabled = false; },

    // Stand up the pool + schema. Never throws — returns db with enabled true/false.
    async init() {
      try {
        // Connect without selecting a database first so we can create it if absent.
        // DB_CONNECT_RETRIES lets the server wait out a database that is still
        // booting alongside it (docker compose); 0 (default) fails fast as before.
        const boot = await connectWithRetry(cfg);
        await boot.query(
          `CREATE DATABASE IF NOT EXISTS \`${cfg.database.replace(/`/g, '')}\` ` +
          `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
        await boot.end();

        pool = mysql.createPool({
          host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
          waitForConnections: true, connectionLimit: cfg.connectionLimit, queueLimit: 0, namedPlaceholders: false,
        });
        // Apply schema in order (each statement is idempotent), then reshape any
        // table an older version of this file created.
        for (const stmt of STATEMENTS) await pool.query(stmt);
        await applyMigrations(pool, cfg.database);
        db.enabled = true;
        console.log(`[media] db on — ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
      } catch (err) {
        console.warn(`[media] WARNING: db init failed (${err.code || err.message}) — running without the DB layer`);
        if (pool) await pool.end().catch(() => {});
        pool = null;
        db.enabled = false;
      }
      return db;
    },
  };
  return db;
}

/**
 * Run the schema.js MIGRATIONS whose condition currently holds. Conditions are read
 * from information_schema, so this is idempotent: on a database already in the
 * target shape nothing runs and nothing is logged.
 */
async function applyMigrations(pool, database) {
  const has = {
    async column(table, column) {
      const [r] = await pool.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',
        [database, table, column]);
      return r.length > 0;
    },
    async index(table, index) {
      const [r] = await pool.query(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1',
        [database, table, index]);
      return r.length > 0;
    },
    async typeContains(table, column, token) {
      const [r] = await pool.query(
        'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',
        [database, table, column]);
      return r.length > 0 && String(r[0].t).includes(token);
    },
  };

  async function holds(cond) {
    if (cond.columnMissing) return !(await has.column(...cond.columnMissing));
    if (cond.indexMissing) return !(await has.index(...cond.indexMissing));
    if (cond.indexPresent) return has.index(...cond.indexPresent);
    if (cond.columnTypeLacks) {
      const [table, column, token] = cond.columnTypeLacks;
      // A column that doesn't exist yet is handled by its own columnMissing entry.
      if (!(await has.column(table, column))) return false;
      return !(await has.typeContains(table, column, token));
    }
    return false;
  }

  for (const m of MIGRATIONS) {
    let due;
    try { due = await holds(m.if); } catch (e) { console.warn(`[media] migration ${m.id}: condition check failed (${e.code || e.message})`); continue; }
    if (!due) continue;
    try {
      for (const sql of m.sql) await pool.query(sql);
      console.log(`[media] db migration applied: ${m.id}`);
    } catch (e) {
      // A failed migration must not take the server down — it degrades a feature,
      // and the condition will still hold next boot so it retries.
      console.warn(`[media] WARNING: migration ${m.id} failed: ${e.code || e.message}`);
    }
  }
}

// Open the bootstrap connection, retrying up to `cfg.connectRetries` times (1s
// apart) so a co-scheduled database container has time to accept connections.
// With the default 0 retries this is a single attempt — identical to before.
async function connectWithRetry(cfg) {
  const attempts = Math.max(0, cfg.connectRetries || 0) + 1;
  for (let i = 1; ; i++) {
    try {
      return await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, multipleStatements: false,
      });
    } catch (err) {
      if (i >= attempts) throw err;
      if (i === 1) console.log(`[media] db not ready (${err.code || err.message}) — retrying up to ${attempts - 1}×`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// A fully inert DB used when the feature is off, so callers need no null checks.
function disabledDb(reason) {
  if (reason) console.warn(`[media] db layer off: ${reason}`);
  return {
    enabled: false,
    config: null,
    async withConn() { return null; },
    async query() { return []; },
    async one() { return null; },
    async close() {},
    async init() { return this; },
  };
}

module.exports = { createDb };
