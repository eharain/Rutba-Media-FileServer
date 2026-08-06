'use strict';

/**
 * Persistence for AI enrichment output, and the review actions on top of it.
 *
 * Separated from ai.js so the provider stays a provider: ai.js knows about Claude,
 * this knows about the database, and the job handlers wire them together.
 *
 * The rule this file exists to enforce: **nothing a model produced is
 * indistinguishable from what a person asserted.** AI tags land in `file_ai_tags`,
 * never in `file_tags`, until somebody explicitly promotes them.
 */

const { pathKey } = require('./util');

function createAiStore({ db }) {
  const on = () => db && db.enabled;

  async function fileIdFor(rel) {
    const row = await db.one('SELECT id FROM files WHERE path_hash = ? LIMIT 1', [pathKey(rel)]);
    return row ? row.id : null;
  }

  return {
    fileIdFor,

    /** Write one asset's enrichment, replacing any previous run for that asset. */
    async save(fileId, result, { model, promptVersion, cost = 0 }) {
      if (!on()) return;
      const usage = result.usage || {};
      await db.query(
        `INSERT INTO file_ai (file_id, status, caption, alt_text, description, detected_text, summary,
                              entities, suggested_fields, confidence, model, prompt_version,
                              input_tokens, output_tokens, cost_usd, error)
         VALUES (?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON DUPLICATE KEY UPDATE
           status='ok', caption=VALUES(caption), alt_text=VALUES(alt_text), description=VALUES(description),
           detected_text=VALUES(detected_text), summary=VALUES(summary), entities=VALUES(entities),
           suggested_fields=VALUES(suggested_fields), confidence=VALUES(confidence), model=VALUES(model),
           prompt_version=VALUES(prompt_version), input_tokens=VALUES(input_tokens),
           output_tokens=VALUES(output_tokens), cost_usd=VALUES(cost_usd), error=NULL,
           reviewed_by=NULL, reviewed_at=NULL`,
        [fileId, result.caption, result.altText, result.description, result.detectedText, result.summary,
         result.entities ? JSON.stringify(result.entities) : null,
         result.suggestedFields ? JSON.stringify(result.suggestedFields) : null,
         result.confidence, model, promptVersion,
         Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0, cost]);

      // Replace the suggestion set, but keep anything a human already ruled on —
      // re-running enrichment must not resurrect a tag a reviewer rejected.
      await db.query('DELETE FROM file_ai_tags WHERE file_id = ? AND promoted_at IS NULL AND rejected_at IS NULL', [fileId]);
      for (const tag of result.tags || []) {
        await db.query(
          'INSERT IGNORE INTO file_ai_tags (file_id, tag, confidence, model) VALUES (?, ?, ?, ?)',
          [fileId, tag, result.confidence, model]);
      }
    },

    /** Record a failure so it is visible in review rather than silently absent. */
    async saveFailure(fileId, message, { model = null, promptVersion = null } = {}) {
      if (!on()) return;
      await db.query(
        `INSERT INTO file_ai (file_id, status, model, prompt_version, error)
         VALUES (?, 'failed', ?, ?, ?)
         ON DUPLICATE KEY UPDATE status='failed', error=VALUES(error), model=VALUES(model), prompt_version=VALUES(prompt_version)`,
        [fileId, model, promptVersion, String(message).slice(0, 4000)]).catch(() => {});
    },

    /** Everything AI knows about one asset, for the review surface. */
    async get(rel) {
      if (!on()) return null;
      const row = await db.one(
        `SELECT a.* FROM file_ai a JOIN files f ON f.id = a.file_id WHERE f.path_hash = ? LIMIT 1`, [pathKey(rel)]);
      if (!row) return null;
      const tags = await db.query(
        `SELECT tag, confidence, promoted_at, rejected_at FROM file_ai_tags WHERE file_id = ? ORDER BY tag`, [row.file_id]);
      return {
        ...row,
        confidence: row.confidence != null ? Number(row.confidence) : null,
        cost_usd: Number(row.cost_usd),
        entities: parseJson(row.entities),
        suggested_fields: parseJson(row.suggested_fields),
        tags: tags.map((t) => ({ ...t, confidence: t.confidence != null ? Number(t.confidence) : null })),
      };
    },

    /**
     * Promote AI tags to human tags. This is the one path by which a model's output
     * becomes indistinguishable from a person's — and it is deliberately an explicit,
     * audited act rather than something enrichment does on its own.
     */
    async promoteTags(fileId, tags, userId) {
      if (!on()) return 0;
      let n = 0;
      for (const raw of tags) {
        const tag = String(raw).trim().toLowerCase();
        if (!tag) continue;
        await db.query('INSERT IGNORE INTO tags (name) VALUES (?)', [tag]);
        const t = await db.one('SELECT id FROM tags WHERE name = ?', [tag]);
        if (!t) continue;
        await db.query('INSERT IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)', [fileId, t.id]);
        const r = await db.query(
          'UPDATE file_ai_tags SET promoted_at = NOW(), rejected_at = NULL WHERE file_id = ? AND tag = ?', [fileId, tag]);
        if (r && r.affectedRows) n++;
      }
      await db.query('UPDATE file_ai SET reviewed_by = ?, reviewed_at = NOW() WHERE file_id = ?', [userId, fileId]).catch(() => {});
      return n;
    },

    async rejectTags(fileId, tags, userId) {
      if (!on()) return 0;
      let n = 0;
      for (const raw of tags) {
        const tag = String(raw).trim().toLowerCase();
        const r = await db.query(
          'UPDATE file_ai_tags SET rejected_at = NOW(), promoted_at = NULL WHERE file_id = ? AND tag = ?', [fileId, tag]);
        if (r && r.affectedRows) n++;
        // A rejected tag must also leave the human set if it had been promoted before.
        await db.query(
          'DELETE ft FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = ? AND t.name = ?', [fileId, tag]);
      }
      await db.query('UPDATE file_ai SET reviewed_by = ?, reviewed_at = NOW() WHERE file_id = ?', [userId, fileId]).catch(() => {});
      return n;
    },

    /** Edit the generated prose. A human edit is authoritative — it is not re-run. */
    async edit(fileId, fields, userId) {
      if (!on()) return false;
      const sets = [], args = [];
      for (const k of ['caption', 'alt_text', 'description', 'summary']) {
        if (fields[k] !== undefined) { sets.push(`${k} = ?`); args.push(fields[k] == null ? null : String(fields[k])); }
      }
      if (!sets.length) return false;
      args.push(userId, fileId);
      const r = await db.query(
        `UPDATE file_ai SET ${sets.join(', ')}, reviewed_by = ?, reviewed_at = NOW() WHERE file_id = ?`, args);
      return !!(r && r.affectedRows);
    },

    /** Discard an asset's enrichment entirely (a bad prompt version, say). */
    async reject(fileId, userId) {
      if (!on()) return false;
      const r = await db.query(
        `UPDATE file_ai SET status='rejected', reviewed_by=?, reviewed_at=NOW() WHERE file_id=?`, [userId, fileId]);
      await db.query('UPDATE file_ai_tags SET rejected_at = NOW() WHERE file_id = ? AND promoted_at IS NULL', [fileId]);
      return !!(r && r.affectedRows);
    },

    /** Spend and volume, by day and in total — what makes bulk runs budgetable. */
    async usage({ days = 30 } = {}) {
      if (!on()) return { total: null, daily: [], byKind: [] };
      const total = await db.one(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost,
                COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens
           FROM ai_usage`);
      const month = await db.one(
        `SELECT COALESCE(SUM(cost_usd),0) AS cost FROM ai_usage WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`);
      const daily = await db.query(
        `SELECT DATE(created_at) AS day, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost
           FROM ai_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${Math.max(1, Math.min(365, days))} DAY)
          GROUP BY DATE(created_at) ORDER BY day DESC`);
      const byKind = await db.query(
        `SELECT kind, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM ai_usage GROUP BY kind`);
      return {
        total: { ...total, calls: Number(total.calls), cost: Number(total.cost) },
        monthToDate: Number(month.cost),
        daily: daily.map((d) => ({ ...d, calls: Number(d.calls), cost: Number(d.cost) })),
        byKind: byKind.map((k) => ({ ...k, calls: Number(k.calls), cost: Number(k.cost) })),
      };
    },
  };
}

function parseJson(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }

module.exports = { createAiStore };
