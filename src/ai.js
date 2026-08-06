'use strict';

/**
 * AI enrichment provider — the Claude client, the prompts, and the spend guard.
 *
 * Follows the same graceful-degrade pattern as sharp.js and ffmpeg.js: the SDK is an
 * OPTIONAL dependency and the key is optional configuration, so
 *
 *   no `@anthropic-ai/sdk`  ⇒ `enabled` is false
 *   no ANTHROPIC_API_KEY    ⇒ `enabled` is false
 *   AI_ENABLED=0            ⇒ `enabled` is false
 *
 * and with it false, no enrichment job type is registered, no column is populated,
 * and the console tab is absent. Turning the key on is the only thing that changes
 * behavior.
 *
 * **Masters are never modified.** Everything this module produces is metadata about
 * an asset, written to `file_ai` / `file_ai_tags` — never to the bytes on disk.
 *
 * ── Cost, which is the whole design constraint ────────────────────────────────
 *
 *  - **Send a resized variant, not the master.** The origin already generates them,
 *    and bounding the long edge is the single biggest lever there is: an image is
 *    billed by area, so a 4000px photo sent whole costs ~4x a 1568px one for
 *    tagging quality that does not differ.
 *  - **Cache the instruction prefix.** The taxonomy and output rules are identical
 *    on every call, so they sit before the last cache breakpoint and the per-asset
 *    image sits after it. Cache reads are ~0.1x input price.
 *  - **Structured output.** `output_config.format` validates the shape at the API,
 *    so there is no parse-retry loop burning tokens on malformed JSON.
 *  - **Every call is metered** into `ai_usage` before its result is used, and a
 *    monthly ceiling is checked before every call. An unbudgeted bulk run is how a
 *    library of 50k assets turns into a surprise invoice.
 */

const PROMPT_VERSION = 'v1';

// Prices in USD per million tokens, keyed by model. Cache writes bill at 1.25x
// input, cache reads at 0.1x. Kept here (not fetched) so cost accounting works
// offline and deterministically; update alongside the model list.
const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const DEFAULT_PRICE = { input: 5, output: 25 };

// The instruction prefix every image call shares — cached, so it is paid for once
// per five minutes rather than once per asset.
const IMAGE_SYSTEM = `You are cataloguing assets for a digital asset management system.

For each image produce:
- caption: one factual sentence describing what is depicted. No preamble, no "This image shows".
- alt_text: a short accessible description for a screen reader, under 125 characters.
- description: two or three sentences with the detail a searcher would use — setting, subjects, activity, mood, notable objects.
- tags: 5 to 15 lowercase keywords a person would plausibly search for. Concrete nouns and activities, not adjectives about quality. No duplicates, no hyphenated compounds where a plain word exists.
- detected_text: any text legibly visible in the image, verbatim. Empty string if none.
- confidence: your confidence in the above, 0 to 1.

Describe only what is actually visible. Do not guess at identities, locations, brands, or dates that are not shown. An empty field is better than an invented one.`;

const DOCUMENT_SYSTEM = `You are cataloguing documents for a digital asset management system.

For each document produce:
- summary: three to five sentences covering what the document is and what it says.
- description: one sentence naming the document type and subject.
- tags: 5 to 15 lowercase keywords a person would search for.
- entities: the notable named entities — people, organizations, places, products.
- detected_text: the first ~2000 characters of the document's body text, verbatim, so it becomes searchable.
- confidence: your confidence in the above, 0 to 1.

Report only what the document contains. Do not infer facts it does not state.`;

const IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    caption: { type: 'string' },
    alt_text: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    detected_text: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['caption', 'alt_text', 'description', 'tags', 'detected_text', 'confidence'],
  additionalProperties: false,
};

const DOCUMENT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    entities: { type: 'array', items: { type: 'string' } },
    detected_text: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['summary', 'description', 'tags', 'entities', 'detected_text', 'confidence'],
  additionalProperties: false,
};

function loadSdk() {
  try {
    const mod = require('@anthropic-ai/sdk');
    return mod && (mod.default || mod);
  } catch { return null; }
}

function createAi({ config, db = null }) {
  const Anthropic = loadSdk();
  const key = config.aiApiKey;
  const reason = !config.aiEnabled ? 'AI_ENABLED=0'
    : !key ? 'no ANTHROPIC_API_KEY'
    : !Anthropic ? '@anthropic-ai/sdk not installed'
    : null;
  const enabled = !reason;
  if (reason && config.aiApiKey) console.warn(`[media] ai layer off: ${reason}`);

  const model = config.aiModel;
  const client = enabled ? new Anthropic({ apiKey: key, maxRetries: 2 }) : null;

  const price = PRICING[model] || DEFAULT_PRICE;

  /** Dollar cost of one call from its `usage` block. */
  function costOf(usage, { batch = false } = {}) {
    if (!usage) return 0;
    const inTok = Number(usage.input_tokens || 0);
    const outTok = Number(usage.output_tokens || 0);
    const cWrite = Number(usage.cache_creation_input_tokens || 0);
    const cRead = Number(usage.cache_read_input_tokens || 0);
    const usd = (inTok * price.input + cWrite * price.input * 1.25 + cRead * price.input * 0.1 + outTok * price.output) / 1e6;
    // The Batches API is half price across the board.
    return Math.round((batch ? usd / 2 : usd) * 1e6) / 1e6;
  }

  async function record(kind, usage, { fileId = null, userId = null, batchId = null, batch = false } = {}) {
    const cost = costOf(usage, { batch });
    if (db && db.enabled) {
      await db.query(
        `INSERT INTO ai_usage (kind, model, file_id, user_id, batch_id, input_tokens, output_tokens,
                               cache_write_tokens, cache_read_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [kind, model, fileId, userId, batchId,
         Number(usage && usage.input_tokens) || 0, Number(usage && usage.output_tokens) || 0,
         Number(usage && usage.cache_creation_input_tokens) || 0,
         Number(usage && usage.cache_read_input_tokens) || 0, cost]).catch(() => {});
    }
    return cost;
  }

  const ai = {
    get enabled() { return enabled; },
    disabledReason: reason,
    model,
    promptVersion: PROMPT_VERSION,
    pricing: price,
    costOf,
    record,

    /** Spend so far this calendar month, in USD. */
    async monthlySpend() {
      if (!db || !db.enabled) return 0;
      const row = await db.one(
        `SELECT COALESCE(SUM(cost_usd),0) AS s FROM ai_usage
          WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`).catch(() => null);
      return row ? Number(row.s) || 0 : 0;
    },

    /**
     * The hard ceiling, checked before every call rather than after. Returns null
     * when there is room, or a refusal describing the overage. A budget enforced
     * only in reporting is not a budget.
     */
    async budgetCheck() {
      const cap = config.aiMonthlyBudgetUsd;
      if (!cap || cap <= 0) return null;
      const spent = await ai.monthlySpend();
      if (spent < cap) return null;
      return { error: 'budget_exceeded', message: `Monthly AI budget of $${cap} is exhausted (spent $${spent.toFixed(2)})`, spent, cap };
    },

    /**
     * Enrich one image. `image` is { data: Buffer, mediaType } — the CALLER supplies
     * a bounded-size variant, not the master (see the cost note in the header).
     */
    async enrichImage({ data, mediaType }, { fileId = null, userId = null, hint = '' } = {}) {
      const blocked = await ai.budgetCheck();
      if (blocked) { const e = new Error(blocked.message); e.error = blocked.error; e.statusCode = 429; throw e; }

      const res = await client.messages.create({
        model,
        max_tokens: 2000,
        // The cached prefix. Everything volatile (the image) comes after it.
        system: [{ type: 'text', text: IMAGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: IMAGE_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } },
            { type: 'text', text: hint ? `Catalogue this asset. Filename for context: ${hint}` : 'Catalogue this asset.' },
          ],
        }],
      });
      const cost = await record('image', res.usage, { fileId, userId });
      return { ...parseResult(res), usage: res.usage, cost, model, promptVersion: PROMPT_VERSION };
    },

    /** Enrich one PDF (or other document the API accepts as a `document` block). */
    async enrichDocument({ data, mediaType = 'application/pdf' }, { fileId = null, userId = null, hint = '' } = {}) {
      const blocked = await ai.budgetCheck();
      if (blocked) { const e = new Error(blocked.message); e.error = blocked.error; e.statusCode = 429; throw e; }

      const res = await client.messages.create({
        model,
        max_tokens: 4000,
        system: [{ type: 'text', text: DOCUMENT_SYSTEM, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: DOCUMENT_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } },
            { type: 'text', text: hint ? `Catalogue this document. Filename for context: ${hint}` : 'Catalogue this document.' },
          ],
        }],
      });
      const cost = await record('document', res.usage, { fileId, userId });
      return { ...parseResult(res), usage: res.usage, cost, model, promptVersion: PROMPT_VERSION };
    },

    // ── Bulk backfill via the Message Batches API (half price) ────────────────
    /** Build one batch request entry for an image. */
    imageBatchRequest(customId, { data, mediaType }, hint = '') {
      return {
        custom_id: customId,
        params: {
          model,
          max_tokens: 2000,
          system: [{ type: 'text', text: IMAGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: IMAGE_SCHEMA } },
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } },
              { type: 'text', text: hint ? `Catalogue this asset. Filename for context: ${hint}` : 'Catalogue this asset.' },
            ],
          }],
        },
      };
    },

    async submitBatch(requests) {
      // The ceiling applies here too — bulk is precisely where an unbudgeted run
      // does damage, and a batch commits every one of its requests at once.
      const blocked = await ai.budgetCheck();
      if (blocked) { const e = new Error(blocked.message); e.error = blocked.error; e.statusCode = 429; throw e; }
      const batch = await client.messages.batches.create({ requests });
      return { id: batch.id, state: batch.processing_status };
    },

    async batchStatus(batchId) {
      const b = await client.messages.batches.retrieve(batchId);
      return { id: b.id, state: b.processing_status, counts: b.request_counts };
    },

    /** Stream a finished batch's results. Order is arbitrary — key by custom_id. */
    async *batchResults(batchId) {
      for await (const item of await client.messages.batches.results(batchId)) yield item;
    },

    parseResult,
  };

  return ai;
}

/**
 * Pull the structured object out of a response. With `output_config.format` the
 * content is schema-valid JSON, so this is a parse and not a rescue operation — but
 * a refusal or a `max_tokens` stop still has to be caught rather than parsed.
 */
function parseResult(res) {
  if (res.stop_reason === 'refusal') {
    const e = new Error(`The model declined this asset${res.stop_details && res.stop_details.category ? ` (${res.stop_details.category})` : ''}`);
    e.error = 'refusal';
    throw e;
  }
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) {
    const e = new Error(`No output (stop_reason: ${res.stop_reason})`);
    e.error = 'empty_output';
    throw e;
  }
  try { return normalize(JSON.parse(text)); }
  catch (err) {
    const e = new Error(`Unparseable output: ${String(err.message).slice(0, 200)}`);
    e.error = 'bad_output';
    throw e;
  }
}

// Clamp everything to what the columns can hold, and normalize tags the same way
// human tags are normalized so the two vocabularies actually line up.
function normalize(o) {
  const str = (v, max) => (v == null ? null : String(v).slice(0, max) || null);
  return {
    caption: str(o.caption, 1024),
    altText: str(o.alt_text, 512),
    description: str(o.description, 60000),
    summary: str(o.summary, 60000),
    detectedText: str(o.detected_text, 60000),
    entities: Array.isArray(o.entities) ? o.entities.map((x) => String(x).slice(0, 191)).slice(0, 50) : null,
    suggestedFields: o.suggested_fields && typeof o.suggested_fields === 'object' ? o.suggested_fields : null,
    tags: [...new Set((Array.isArray(o.tags) ? o.tags : [])
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => t && t.length <= 64))].slice(0, 30),
    confidence: Number.isFinite(Number(o.confidence)) ? Math.max(0, Math.min(1, Number(o.confidence))) : null,
  };
}

module.exports = { createAi, PRICING, PROMPT_VERSION };
