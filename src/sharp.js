'use strict';

/**
 * Optional `sharp` dependency. Resolved once at load; if it is unavailable the
 * service degrades gracefully to serving masters unresized. Exports the sharp
 * function (or null). sharp's internal pixel cache is disabled — we do our own
 * on-disk LRU caching of finished variants.
 */

let sharp = null;
try {
  sharp = require('sharp');
  if (sharp.cache) sharp.cache(false);
} catch {
  console.warn('[media] sharp unavailable — resize disabled, serving masters as-is. Run: npm install sharp');
}

module.exports = sharp;
