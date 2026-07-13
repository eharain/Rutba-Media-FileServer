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

const { STATEMENTS } = require('./schema');

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
        const boot = await mysql.createConnection({
          host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, multipleStatements: false,
        });
        await boot.query(
          `CREATE DATABASE IF NOT EXISTS \`${cfg.database.replace(/`/g, '')}\` ` +
          `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
        await boot.end();

        pool = mysql.createPool({
          host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
          waitForConnections: true, connectionLimit: cfg.connectionLimit, queueLimit: 0, namedPlaceholders: false,
        });
        // Apply schema in order (each statement is idempotent).
        for (const stmt of STATEMENTS) await pool.query(stmt);
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
