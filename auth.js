// Sign-in helpers (no database), unit-tested with `npm test`.
const crypto = require('crypto');

const LOGIN_ROLES = ['student', 'teacher', 'hod', 'other'];
const SESSION_TTL_MS = 12 * 3600e3; // a sign-in lasts 12 hours
const MAX_FAILED = 5;               // wrong passwords allowed in a row
const LOCK_MS = 15 * 60e3;          // then the account is locked for 15 minutes

// Passwords are never stored. We keep "scrypt$cost$salt$hash" (a salted, slow hash).
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[3], 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(parts[2], 'hex'), expected.length,
      { N: Number(parts[1]), r: 8, p: 1 });
  } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A sign-in token: base64url(payload) + "." + HMAC signature. It carries an expiry time.
function signSession(payload, secret, ttlMs = SESSION_TTL_MS, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Returns the payload, or null if the token is forged, damaged or expired.
function verifySession(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url'));
  const given = Buffer.from(parts[1]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp <= now) return null;
  return p;
}

// Milliseconds an account is still locked for (0 when it isn't).
function lockedFor(lockedUntil, now = Date.now()) {
  const t = lockedUntil ? new Date(lockedUntil).getTime() : 0;
  return Math.max(0, t - now);
}

// What to store after one more wrong password.
function afterFailedLogin(failedAttempts, now = Date.now()) {
  const failed = failedAttempts + 1;
  return failed >= MAX_FAILED
    ? { failed: 0, lockedUntil: new Date(now + LOCK_MS) }
    : { failed, lockedUntil: null };
}

function passwordError(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters';
  if (pw.length > 100) return 'Use at most 100 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number';
  return null;
}

module.exports = {
  LOGIN_ROLES, SESSION_TTL_MS, MAX_FAILED, LOCK_MS,
  hashPassword, verifyPassword, signSession, verifySession, lockedFor, afterFailedLogin, passwordError,
};
