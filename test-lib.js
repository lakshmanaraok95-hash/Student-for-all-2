const assert = require('assert');
const L = require('./lib');
const t0 = 1_800_000_000_000;

// tokens
const { token } = L.currentToken('7', 's3cret', t0);
assert.strictEqual(L.checkToken(token, 's3cret', t0), null, 'fresh token valid');
assert.strictEqual(L.checkToken(token, 's3cret', t0 + 15_000), null, 'previous window still valid');
assert.strictEqual(L.checkToken(token, 's3cret', t0 + 31_000), 'QR expired, scan again', 'old token expired');
assert.strictEqual(L.checkToken(token, 'other', t0), 'Invalid QR', 'wrong secret rejected');
assert.strictEqual(L.checkToken(token.slice(0, -1) + 'x', 's3cret', t0), 'Invalid QR', 'tampered rejected');
assert.strictEqual(L.checkToken('garbage', 's3cret', t0), 'Malformed token');
assert.strictEqual(L.checkToken('7.abc.def', 's3cret', t0), 'Malformed token');
assert.notStrictEqual(L.currentToken('7', 'k', t0).token, L.currentToken('ev7', 'k', t0).token, 'session and event tokens differ');
assert.ok(L.currentToken('7', 'k', t0).expiresInMs <= L.WINDOW_MS);

// student personal QR (one scanner scans every student)
const master = 'master-key';
const s1 = L.currentToken('st1', L.studentSecret(master, 1), t0).token;
assert.strictEqual(L.checkToken(s1, L.studentSecret(master, 1), t0), null, 'student 1 QR valid');
assert.strictEqual(L.checkToken(s1.replace('st1.', 'st2.'), L.studentSecret(master, 2), t0), 'Invalid QR', 'cannot turn student 1 QR into student 2');
assert.notStrictEqual(L.studentSecret(master, 1), L.studentSecret(master, 2));
assert.strictEqual(L.checkToken(s1, L.studentSecret(master, 1), t0 + 31_000), 'QR expired, scan again', 'student QR expires');

// geofence
assert.strictEqual(L.geofenceError(12.0, 78.0, 12.0, 78.0, 50), null, 'inside');
assert.match(L.geofenceError(12.01, 78.0, 12.0, 78.0, 50), /Too far/, 'outside (~1.1 km)');
assert.strictEqual(L.geofenceError(undefined, undefined, 12.0, 78.0, 50), 'Location required');
assert.strictEqual(L.geofenceError(undefined, undefined, null, null, 50), null, 'no venue coords = no check');

// attendance percentage with excused days
assert.strictEqual(L.attendancePct(12, 5, 21), 75);
assert.strictEqual(L.attendancePct(9, 6, 21), 60);
assert.strictEqual(L.attendancePct(0, 3, 3), 100, 'all excused is not a failure');
assert.strictEqual(L.attendancePct(0, 0, 0), 100);

// class from/to times
const D = (h, m) => new Date(t0 + h * 3600e3 + m * 60e3);
assert.strictEqual(L.classTimeError(D(0, 0), D(0, 50), t0 - 1000), null, '10:00-10:50 style range is fine');
assert.strictEqual(L.classTimeError(D(0, 0), D(0, 50), t0 + 3600e3), 'The end time has already passed');
assert.strictEqual(L.classTimeError(D(1, 0), D(0, 30), t0), 'The end time must be after the start time');
assert.strictEqual(L.classTimeError(D(0, 0), D(0, 0), t0), 'The end time must be after the start time');
assert.strictEqual(L.classTimeError(D(0, 0), D(9, 0), t0), 'A class can be at most 8 hours long');
assert.strictEqual(L.classTimeError(D(-3, 0), D(1, 0), t0), null, 'a class that started earlier and is still running is fine');
assert.strictEqual(L.classTimeError(new Date('x'), D(1, 0), t0), 'Enter the from and to times');
assert.strictEqual(L.classTimeError(D(1, 0), undefined, t0), 'Enter the from and to times');

// timetable periods
const ok1 = { day: 1, start: '10:00', end: '10:50', room: 'Room 204' };
assert.strictEqual(L.slotError(ok1), null);
assert.strictEqual(L.slotError({ ...ok1, day: 0 }), 'Choose a day');
assert.strictEqual(L.slotError({ ...ok1, day: 8 }), 'Choose a day');
assert.strictEqual(L.slotError({ ...ok1, day: '1' }), 'Choose a day', 'day must be a number');
assert.strictEqual(L.slotError({ ...ok1, start: '' }), 'Set the from and to times');
assert.strictEqual(L.slotError({ ...ok1, end: '9:5' }), 'Set the from and to times');
assert.strictEqual(L.slotError({ ...ok1, end: '25:00' }), 'Set the from and to times');
assert.strictEqual(L.slotError({ ...ok1, end: '10:00' }), 'The end time must be after the start time');
assert.strictEqual(L.slotError({ ...ok1, start: '11:00' }), 'The end time must be after the start time');
assert.strictEqual(L.slotError({ ...ok1, start: '08:00', end: '16:30' }), 'A period can be at most 8 hours long');
assert.strictEqual(L.slotError({ ...ok1, room: '   ' }), 'Enter the room');
assert.ok(L.slotsOverlap('10:00', '10:50', '10:30', '11:20'), 'partial overlap');
assert.ok(L.slotsOverlap('10:00', '11:00', '10:10', '10:20'), 'contained');
assert.ok(!L.slotsOverlap('10:00', '10:50', '10:50', '11:40'), 'back-to-back is not an overlap');
assert.ok(!L.slotsOverlap('09:00', '09:50', '10:00', '10:50'), 'separate periods');

// feedback limit: 2 messages per 48 hours
const H = 3600e3, now0 = 1_800_000_000_000;
let q = L.feedbackQuota([], now0);
assert.deepStrictEqual(q, { used: 0, remaining: 2, next_at: null });
q = L.feedbackQuota([now0 - 1 * H], now0);
assert.strictEqual(q.remaining, 1);
q = L.feedbackQuota([now0 - 10 * H, now0 - 1 * H], now0);
assert.strictEqual(q.remaining, 0, 'two in 48h uses up the limit');
assert.strictEqual(q.next_at, new Date(now0 - 10 * H + 48 * H).toISOString(), 'next slot opens when the older one ages out');
q = L.feedbackQuota([now0 - 49 * H, now0 - 1 * H], now0);
assert.strictEqual(q.remaining, 1, 'messages older than 48 hours do not count');
q = L.feedbackQuota([now0 - 49 * H, now0 - 50 * H], now0);
assert.strictEqual(q.remaining, 2);
q = L.feedbackQuota([new Date(now0 - 5 * H).toISOString(), new Date(now0 - 2 * H)], now0);
assert.strictEqual(q.remaining, 0, 'accepts dates and ISO strings');
assert.strictEqual(L.feedbackError('App problem', 'The QR is slow to load'), null);
assert.strictEqual(L.feedbackError('Bug', 'The QR is slow to load'), 'Choose what your feedback is about');
assert.match(L.feedbackError('Other', ' hi '), /at least 5/);
assert.match(L.feedbackError('Other', 'x'.repeat(501)), /under 500/);
assert.deepStrictEqual(L.MANUAL_REASONS, ['Technical issue', 'Other']);

// every leave category must be a valid excuse reason (the database enforces this too)
assert.ok(L.LEAVE_CATEGORIES.every((c) => L.EXCUSE_REASONS.includes(c)));

console.log('lib tests passed');
