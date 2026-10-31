const assert = require('assert');
const A = require('./auth');
const t0 = 1_800_000_000_000;

// passwords
const h = A.hashPassword('Hod@12345');
assert.ok(h.startsWith('scrypt$'), 'stores a hash, not the password');
assert.ok(!h.includes('Hod@12345'));
assert.ok(A.verifyPassword('Hod@12345', h), 'right password accepted');
assert.ok(!A.verifyPassword('Hod@12346', h), 'wrong password refused');
assert.ok(!A.verifyPassword('', h), 'empty password refused');
assert.notStrictEqual(A.hashPassword('Hod@12345'), h, 'each hash has its own salt');
assert.ok(!A.verifyPassword('x', 'not-a-hash'), 'damaged hash never verifies');
assert.ok(!A.verifyPassword('x', null));

// sign-in tokens
const secret = 'session-secret';
const tok = A.signSession({ r: 'teacher', i: 1, u: 7 }, secret, A.SESSION_TTL_MS, t0);
let p = A.verifySession(tok, secret, t0 + 1000);
assert.deepStrictEqual({ r: p.r, i: p.i, u: p.u }, { r: 'teacher', i: 1, u: 7 });
assert.strictEqual(A.verifySession(tok, 'other-secret', t0), null, 'wrong secret refused');
assert.strictEqual(A.verifySession(tok, secret, t0 + A.SESSION_TTL_MS), null, 'expired after 12 hours');
assert.ok(A.verifySession(tok, secret, t0 + A.SESSION_TTL_MS - 1), 'valid until then');
const [body, sig] = tok.split('.');
const forged = Buffer.from(JSON.stringify({ r: 'hod', i: 1, u: 7, exp: t0 + 1e9 })).toString('base64url');
assert.strictEqual(A.verifySession(`${forged}.${sig}`, secret, t0), null, 'cannot change the role inside a token');
assert.strictEqual(A.verifySession(`${body}.${sig.slice(0, -2)}xx`, secret, t0), null, 'tampered signature refused');
assert.strictEqual(A.verifySession('garbage', secret, t0), null);
assert.strictEqual(A.verifySession('', secret, t0), null);
assert.strictEqual(A.verifySession(undefined, secret, t0), null);

// lockout after 5 wrong passwords
let f = { failed: 0, lockedUntil: null };
for (let i = 1; i <= 4; i++) { f = A.afterFailedLogin(f.failed, t0); assert.strictEqual(f.lockedUntil, null, `try ${i} does not lock`); }
assert.strictEqual(f.failed, 4);
f = A.afterFailedLogin(f.failed, t0);
assert.strictEqual(f.lockedUntil.getTime(), t0 + A.LOCK_MS, '5th wrong try locks for 15 minutes');
assert.strictEqual(f.failed, 0, 'counter restarts after the lock');
assert.strictEqual(A.lockedFor(f.lockedUntil, t0 + 60e3), A.LOCK_MS - 60e3);
assert.strictEqual(A.lockedFor(f.lockedUntil, t0 + A.LOCK_MS + 1), 0, 'unlocks after 15 minutes');
assert.strictEqual(A.lockedFor(null, t0), 0);

// new passwords
assert.strictEqual(A.passwordError('Hod@12345'), null);
assert.match(A.passwordError('short1'), /at least 8/);
assert.match(A.passwordError('onlyletters'), /letters and at least one number/);
assert.match(A.passwordError('12345678'), /letters and at least one number/);
assert.match(A.passwordError('a1'.repeat(60)), /at most 100/);
assert.match(A.passwordError(undefined), /at least 8/);

assert.deepStrictEqual(A.LOGIN_ROLES, ['student', 'teacher', 'hod', 'other']);
console.log('auth tests passed');
