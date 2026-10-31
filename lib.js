// Pure helpers (no database), so they can be unit-tested: `npm test`
const crypto = require('crypto');

const WINDOW_MS = 15_000; // QR token lifetime

const EXCUSE_REASONS = ['Medical', 'Family emergency', 'College event / sports', 'Other'];
const EVENT_TYPES = ['Cultural', 'Sports', 'Workshop', 'Other'];
// Leave requests exclude 'College event / sports': that is handled by on-duty.
const LEAVE_CATEGORIES = ['Medical', 'Family emergency', 'Other'];
// Why a professor marked a student present by hand (their phone or the app failed, etc.)
const MANUAL_REASONS = ['Technical issue', 'Other'];

// In-app feedback: each person can send FEEDBACK_LIMIT messages in any 48-hour window.
const FEEDBACK_CATEGORIES = ['App problem', 'Suggestion', 'Other'];
const FEEDBACK_LIMIT = 2;
const FEEDBACK_WINDOW_MS = 48 * 3600e3;

// idPart is "12" for a class session or "ev3" for an event.
function tokenFor(idPart, secret, windowIdx) {
  const sig = crypto.createHmac('sha256', secret)
    .update(`${idPart}:${windowIdx}`).digest('hex').slice(0, 16);
  return `${idPart}.${windowIdx}.${sig}`;
}

function currentToken(idPart, secret, now = Date.now()) {
  const w = Math.floor(now / WINDOW_MS);
  return { token: tokenFor(idPart, secret, w), expiresInMs: WINDOW_MS - (now % WINDOW_MS) };
}

// Returns an error message, or null when the token is valid.
// Accepts the current window plus the previous one (grace for network lag).
function checkToken(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return 'Malformed token';
  const w = Number(parts[1]);
  if (!Number.isInteger(w)) return 'Malformed token';
  const nowIdx = Math.floor(now / WINDOW_MS);
  if (w !== nowIdx && w !== nowIdx - 1) return 'QR expired, scan again';
  const expected = tokenFor(parts[0], secret, w);
  const a = Buffer.from(expected), b = Buffer.from(String(token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'Invalid QR';
  return null;
}

// Each student gets their own signing key, derived from one master secret, so a QR
// made for one student can't be altered into another student's.
function studentSecret(master, studentId) {
  return crypto.createHmac('sha256', master).update(`student:${studentId}`).digest('hex');
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Returns an error message, or null when the student is inside the radius.
// A place with no saved coordinates has no location check.
function geofenceError(lat, lng, roomLat, roomLng, radius) {
  if (roomLat == null || roomLng == null) return null;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng))
    return 'Location required';
  const d = haversineMeters(lat, lng, roomLat, roomLng);
  return d > radius ? `Too far from the venue (${Math.round(d)} m)` : null;
}

// Rules for a class's from/to times. Returns an error message, or null when fine.
function classTimeError(start, end, now = Date.now()) {
  if (!(start instanceof Date) || !(end instanceof Date) || isNaN(start) || isNaN(end))
    return 'Enter the from and to times';
  if (end <= start) return 'The end time must be after the start time';
  if (end.getTime() <= now) return 'The end time has already passed';
  if (end - start > 8 * 3600e3) return 'A class can be at most 8 hours long';
  return null;
}

// ---- timetable ----
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));

// day: 1 = Monday ... 7 = Sunday; start/end: zero-padded 24-hour "HH:MM".
// Returns an error message, or null when the period is fine.
function slotError({ day, start, end, room }) {
  if (!Number.isInteger(day) || day < 1 || day > 7) return 'Choose a day';
  if (!HHMM.test(start || '') || !HHMM.test(end || '')) return 'Set the from and to times';
  if (minutesOf(end) <= minutesOf(start)) return 'The end time must be after the start time';
  if (minutesOf(end) - minutesOf(start) > 480) return 'A period can be at most 8 hours long';
  if (!String(room || '').trim()) return 'Enter the room';
  return null;
}

// zero-padded "HH:MM" strings compare correctly as text
const slotsOverlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// times: when this person sent their earlier feedback. Returns how many messages they
// have left and, if none, when they can send again (ISO time).
function feedbackQuota(times, now = Date.now()) {
  const recent = times.map((t) => new Date(t).getTime())
    .filter((t) => t > now - FEEDBACK_WINDOW_MS).sort((a, b) => a - b);
  const remaining = Math.max(0, FEEDBACK_LIMIT - recent.length);
  const nextAt = remaining === 0
    ? new Date(recent[recent.length - FEEDBACK_LIMIT] + FEEDBACK_WINDOW_MS).toISOString() : null;
  return { used: recent.length, remaining, next_at: nextAt };
}

function feedbackError(category, message) {
  if (!FEEDBACK_CATEGORIES.includes(category)) return 'Choose what your feedback is about';
  const m = String(message || '').trim();
  if (m.length < 5) return 'Write a little more so we can understand (at least 5 characters)';
  if (m.length > 500) return 'Please keep it under 500 characters';
  return null;
}

// Excused days are left out of the total, so they never count against a student.
function attendancePct(present, excused, held) {
  const base = held - excused;
  return base > 0 ? Math.round((present / base) * 100) : 100;
}

module.exports = {
  WINDOW_MS, EXCUSE_REASONS, EVENT_TYPES, LEAVE_CATEGORIES, MANUAL_REASONS,
  FEEDBACK_CATEGORIES, FEEDBACK_LIMIT, FEEDBACK_WINDOW_MS, feedbackQuota, feedbackError,
  tokenFor, currentToken, checkToken, studentSecret, haversineMeters, geofenceError, attendancePct, classTimeError, slotError, slotsOverlap,
};
