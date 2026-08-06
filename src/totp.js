'use strict';

/**
 * TOTP (RFC 6238) with the Node built-in `crypto` — no dependency, same reason
 * passwords use scrypt rather than a native bcrypt module.
 *
 * Deliberately the boring, interoperable configuration every authenticator app
 * (Google Authenticator, 1Password, Aegis, Authy…) assumes: HMAC-SHA1, 6 digits,
 * a 30-second step, base32 secret. Anything else quietly fails to enrol for some
 * fraction of users.
 *
 * `verify` accepts a ±1 step window, which is the standard allowance for clock skew
 * and for the user typing the last digit as the code rolls over.
 */

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte secret (the SHA1 block size) as base32. */
function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

/** The 6-digit code for a counter value (unix time / step). */
function codeFor(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code a correctly-configured authenticator is showing right now. */
function currentCode(secretB32, now = Date.now()) {
  return codeFor(secretB32, Math.floor(now / 1000 / STEP_SECONDS));
}

/**
 * Verify a user-supplied code against the secret, allowing `window` steps either
 * side. Compared in constant time so a wrong code leaks nothing through timing.
 */
function verify(secretB32, code, { now = Date.now(), window = 1 } = {}) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== DIGITS) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const supplied = Buffer.from(clean);
  for (let i = -window; i <= window; i++) {
    const expected = Buffer.from(codeFor(secretB32, counter + i));
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) return true;
  }
  return false;
}

/** The `otpauth://` URI authenticator apps scan as a QR code. */
function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * One-time recovery codes, for the phone that fell in the sea. Returned in
 * plaintext exactly once; only their hashes are ever stored.
 */
function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

const normalizeRecovery = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashRecovery = (c) => crypto.createHash('sha256').update(normalizeRecovery(c)).digest('hex');

module.exports = {
  generateSecret, currentCode, verify, otpauthUrl, codeFor,
  generateRecoveryCodes, hashRecovery, normalizeRecovery,
  base32Encode, base32Decode, STEP_SECONDS, DIGITS,
};
