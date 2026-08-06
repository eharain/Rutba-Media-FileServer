'use strict';

/**
 * Shared test harness for the suites in this folder.
 *
 * Two things live here that both suites need and neither should re-invent:
 *
 *  - `spawnServer()` / `waitHealth()` — start `server.js` with a given env and wait
 *    for `/_health`. **Waiting HARD-FAILS on timeout.** The original suite waited up
 *    to 5s and then ran every assertion anyway, so a slow/cold start reported dozens
 *    of misleading assertion failures instead of the one real fact ("the server never
 *    came up"). The budget is also generous enough for a cold Windows/CI start and
 *    overridable with MEDIA_TEST_BOOT_MS.
 *
 *  - `Runner` — the pass/fail counter and the summary line. The total is PRINTED FROM
 *    THE RUNNER, never hardcoded, so no comment, README line or CI step can drift
 *    away from the real number of checks.
 */

const { spawn } = require('child_process');

const BOOT_TIMEOUT_MS = parseInt(process.env.MEDIA_TEST_BOOT_MS, 10) || 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll an async predicate until truthy (for fire-and-forget background work).
async function waitFor(fn, tries = 50, gap = 50) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch { /* keep polling */ }
    await sleep(gap);
  }
  return false;
}

/**
 * Wait for `<base>/_health` to answer 200. Throws (rather than returning) when the
 * budget runs out — the caller is expected to let that abort the suite.
 */
async function waitHealth(base, { timeoutMs = BOOT_TIMEOUT_MS, label = 'server' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/_health')).ok) return; } catch (e) { lastErr = e; }
    await sleep(100);
  }
  throw new Error(
    `${label} never became healthy at ${base} within ${timeoutMs}ms` +
    (lastErr ? ` (last error: ${lastErr.code || lastErr.message})` : '') +
    ` — raise MEDIA_TEST_BOOT_MS if this machine is just slow`);
}

/**
 * Spawn `server.js` with `env` merged over the current environment and wait for it
 * to report healthy. Returns { proc, base, stop() }. Stderr is echoed under DEBUG,
 * and always captured so a boot failure can be reported with the server's own words.
 */
async function spawnServer({ env, port, label = 'server', cwd = null } = {}) {
  const path = require('path');
  const serverPath = path.join(__dirname, '..', 'server.js');
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: cwd || undefined,
  });
  const tail = [];
  const keep = (d) => { tail.push(d.toString()); if (tail.length > 40) tail.shift(); };
  proc.stdout.on('data', (d) => { keep(d); if (process.env.DEBUG) console.error(`[${label}]`, d.toString().trimEnd()); });
  proc.stderr.on('data', (d) => { keep(d); if (process.env.DEBUG) console.error(`[${label}]`, d.toString().trimEnd()); });

  let exited = null;
  proc.on('exit', (code, sig) => { exited = { code, sig }; });

  try {
    await waitHealth(base, { label });
  } catch (e) {
    proc.kill();
    const why = exited ? ` (process exited: code=${exited.code} signal=${exited.sig})` : '';
    throw new Error(`${e.message}${why}\n--- ${label} output ---\n${tail.join('')}`);
  }

  return {
    proc,
    base,
    output: () => tail.join(''),
    stop() { try { proc.kill(); } catch { /* already gone */ } },
  };
}

/** Pass/fail counter + summary. `runner.total` is the single source of the count. */
class Runner {
  constructor(title) {
    this.title = title;
    this.pass = 0;
    this.fail = 0;
    this.skipped = 0;
    this.failures = [];
    if (title) console.log(title);
  }

  get total() { return this.pass + this.fail; }

  /** Record a check that could not run (e.g. no ffmpeg binary on this machine). */
  skip(name, why) {
    this.skipped++;
    console.log(`  – ${name} (skipped: ${why})`);
  }

  async t(name, fn) {
    try {
      await fn();
      this.pass++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      this.fail++;
      this.failures.push(name);
      console.error(`  ✗ ${name}: ${(e && e.message) || e}`);
    }
  }

  /** Print the summary and return the process exit code (0 = all green). */
  finish() {
    const skipped = this.skipped ? `, ${this.skipped} skipped` : '';
    console.log(`\n${this.pass} passed, ${this.fail} failed${skipped} (${this.total} checks)`);
    return this.fail ? 1 : 0;
  }
}

module.exports = { Runner, spawnServer, waitHealth, waitFor, sleep, BOOT_TIMEOUT_MS };
