require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const L = require('./lib');
const A = require('./auth');

const ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5173';
// Time zone used to decide which classes fall on an event's date (IANA name, e.g. Asia/Kolkata)
const TZ = process.env.APP_TIMEZONE || 'UTC';
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGIN } });
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Minimal CORS (the Vite proxy normally makes this unnecessary)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-id, x-role');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

// Live updates. A socket must carry a valid sign-in token (see io.use below), and only
// professors and the HOD may listen to a class or event room.
io.on('connection', (socket) => {
  const staff = ['teacher', 'hod'].includes(socket.data.user && socket.data.user.role);
  socket.on('join', (sessionId) => { if (staff) socket.join(`session:${sessionId}`); });
  socket.on('join-event', (eventId) => { if (staff) socket.join(`event:${eventId}`); });
});

// ---- helpers ---------------------------------------------------------------
// Forwards errors from async routes to the error handler instead of crashing.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- sign-in ----------------------------------------------------------------
// After login every request carries "Authorization: Bearer <token>". The token is signed with
// SESSION_SECRET and expires after 12 hours. ALLOW_DEV_LOGIN=1 additionally accepts the old
// x-user-id / x-role headers (anyone can then pretend to be anyone): test machines only.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set: everyone is signed out whenever the server restarts.');
}
const DEV_LOGIN = process.env.ALLOW_DEV_LOGIN === '1';
if (DEV_LOGIN) console.warn('ALLOW_DEV_LOGIN=1: the insecure header login is ON. Never use it on a shared or public server.');

function userFromToken(token) {
  const p = A.verifySession(token, SESSION_SECRET);
  return p ? { id: p.i, role: p.r, uid: p.u } : null;
}

app.use((req, _res, next) => {
  const m = /^Bearer (.+)$/.exec(req.header('authorization') || '');
  let user = m ? userFromToken(m[1]) : null;
  if (!user && DEV_LOGIN) {
    const id = Number(req.header('x-user-id')), role = req.header('x-role');
    if (Number.isInteger(id) && A.LOGIN_ROLES.includes(role)) user = { id, role };
  }
  req.user = user || { id: NaN, role: undefined };
  next();
});

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const user = userFromToken(auth.token) ||
    (DEV_LOGIN && A.LOGIN_ROLES.includes(auth.role) ? { id: Number(auth.id), role: auth.role } : null);
  if (!user) return next(new Error('Please sign in'));
  socket.data.user = user;
  next();
});

const signedIn = (req, res, next) => (req.user.role ? next() : res.status(401).json({ error: 'Please sign in' }));
const only = (role) => (req, res, next) => (!req.user.role
  ? res.status(401).json({ error: 'Please sign in' })
  : req.user.role === role ? next() : res.sendStatus(403));

const DUMMY_HASH = A.hashPassword('not-a-real-password'); // keeps timing the same for unknown IDs

app.post('/api/auth/login', h(async (req, res) => {
  const role = String(req.body.role || '');
  const loginId = String(req.body.login_id || '').trim();
  const password = String(req.body.password || '');
  if (!A.LOGIN_ROLES.includes(role) || !loginId || !password)
    return res.status(400).json({ error: 'Choose your role, then enter your ID and password' });

  const { rows } = await db.query(
    'SELECT * FROM users WHERE role = $1 AND lower(login_id) = lower($2)', [role, loginId]);
  const u = rows[0];
  if (!u) {
    A.verifyPassword(password, DUMMY_HASH);
    return res.status(401).json({ error: 'Wrong ID or password for this role' });
  }
  const wait = A.lockedFor(u.locked_until);
  if (wait > 0) {
    return res.status(429).json({
      error: `Too many wrong tries. Try again in ${Math.ceil(wait / 60000)} minute(s).`, retry_after_ms: wait });
  }
  if (!A.verifyPassword(password, u.password_hash)) {
    const f = A.afterFailedLogin(u.failed_attempts);
    await db.query('UPDATE users SET failed_attempts = $2, locked_until = $3 WHERE id = $1',
      [u.id, f.failed, f.lockedUntil]);
    return res.status(401).json({
      error: f.lockedUntil ? 'Too many wrong tries. This account is locked for 15 minutes.'
                           : 'Wrong ID or password for this role' });
  }
  await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [u.id]);
  const token = A.signSession({ r: u.role, i: u.actor_id, u: u.id }, SESSION_SECRET);
  res.json({ token, expires_in_ms: A.SESSION_TTL_MS, user: { role: u.role, id: u.actor_id, name: u.name } });
}));

app.get('/api/auth/me', signedIn, h(async (req, res) => {
  if (!req.user.uid) return res.json({ role: req.user.role, id: req.user.id, name: `${req.user.role} #${req.user.id}` });
  const { rows } = await db.query('SELECT role, actor_id AS id, name FROM users WHERE id = $1', [req.user.uid]);
  if (!rows[0]) return res.status(401).json({ error: 'Please sign in' });
  res.json(rows[0]);
}));

app.post('/api/auth/change-password', signedIn, h(async (req, res) => {
  if (!req.user.uid) return res.status(400).json({ error: 'Password changes need a real account' });
  const { current_password, new_password } = req.body;
  const err = A.passwordError(new_password);
  if (err) return res.status(400).json({ error: err });
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.uid]);
  if (!rows[0] || !A.verifyPassword(String(current_password || ''), rows[0].password_hash))
    return res.status(403).json({ error: 'Your current password is wrong' });
  if (new_password === current_password) return res.status(400).json({ error: 'Choose a different password' });
  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.uid, A.hashPassword(new_password)]);
  res.json({ ok: true });
}));

// Everything below needs a signed-in user.
app.use('/api', signedIn);

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const randomSecret = () => crypto.randomBytes(32).toString('hex');
// Master key for students' personal QR codes (set STUDENT_QR_SECRET in .env)
const MASTER_SECRET = process.env.STUDENT_QR_SECRET || randomSecret();
if (!process.env.STUDENT_QR_SECRET) {
  console.warn('STUDENT_QR_SECRET is not set: students\' personal QR codes stop working when the server restarts.');
}

// Tells open Live Roster screens about records changed in bulk
function emitRows(rows, status, reason) {
  for (const r of rows) {
    io.to(`session:${r.session_id}`).emit('attendance', {
      studentId: r.student_id, status, method: status === 'ABSENT' ? null : 'MANUAL_OVERRIDE',
      excuse_reason: reason });
  }
}

// ---- class QR + check-in ---------------------------------------------------
app.get('/api/sessions/:id/qr', only('teacher'), h(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, qr_secret, is_open, starts_at, ends_at FROM class_sessions WHERE id=$1', [req.params.id]);
  const s = rows[0];
  if (!s) return bad(res, 'Class not found', 404);
  if (!s.is_open || s.ends_at < new Date()) return bad(res, 'This class has ended', 403);
  if (s.starts_at > new Date()) return bad(res, 'This class has not started yet', 403);
  res.json(L.currentToken(String(s.id), s.qr_secret));
}));

app.post('/api/attendance/scan', only('student'), h(async (req, res) => {
  const { token, lat, lng } = req.body;
  const idPart = String(token || '').split('.')[0];
  if (!/^\d+$/.test(idPart)) return bad(res, 'Malformed token');

  const { rows } = await db.query('SELECT * FROM class_sessions WHERE id=$1', [idPart]);
  const s = rows[0];
  if (!s) return bad(res, 'Class not found', 404);
  if (!s.is_open || s.ends_at < new Date()) return bad(res, 'This class has ended', 403);
  if (s.starts_at > new Date()) return bad(res, 'This class has not started yet', 403);

  const tokenErr = L.checkToken(token, s.qr_secret);
  if (tokenErr) return bad(res, tokenErr);
  const geoErr = L.geofenceError(lat, lng, s.room_lat, s.room_lng, s.radius_m);
  if (geoErr) return bad(res, geoErr, geoErr === 'Location required' ? 400 : 403);

  const enr = await db.query(
    'SELECT 1 FROM enrollments WHERE student_id=$1 AND course_id=$2', [req.user.id, s.course_id]);
  if (!enr.rowCount) return bad(res, 'Not enrolled', 403);

  await db.query(
    `INSERT INTO attendance_records (session_id, student_id, status, method, marked_at, lat, lng)
     VALUES ($1,$2,'PRESENT','QR',now(),$3,$4)
     ON CONFLICT (session_id, student_id)
     DO UPDATE SET status='PRESENT', method='QR', marked_at=now(), lat=$3, lng=$4,
                   excuse_reason=NULL, excuse_note=NULL, excuse_source=NULL, manual_reason=NULL`,
    [s.id, req.user.id, lat, lng]);

  io.to(`session:${s.id}`).emit('attendance',
    { studentId: req.user.id, status: 'PRESENT', method: 'QR', excuse_reason: null });
  res.json({ status: 'PRESENT' });
}));

// ---- teacher: manual override + excused absence ----------------------------
app.put('/api/sessions/:id/attendance/:studentId', only('teacher'), h(async (req, res) => {
  const { status } = req.body;
  if (!['PRESENT', 'ABSENT', 'LATE'].includes(status))
    return bad(res, 'Status must be PRESENT, ABSENT or LATE (use the excuse route for excused)');
  // Why the student was marked by hand (their phone or the app failed). Only for present/late.
  const why = ['PRESENT', 'LATE'].includes(status) && L.MANUAL_REASONS.includes(req.body.reason)
    ? req.body.reason : null;
  await db.query(
    `INSERT INTO attendance_records (session_id, student_id, status, method, marked_at, marked_by, manual_reason)
     VALUES ($1,$2,$3,'MANUAL_OVERRIDE',now(),$4,$5)
     ON CONFLICT (session_id, student_id)
     DO UPDATE SET status=$3, method='MANUAL_OVERRIDE', marked_at=now(), marked_by=$4, manual_reason=$5,
                   excuse_reason=NULL, excuse_note=NULL, excuse_source=NULL`,
    [req.params.id, req.params.studentId, status, req.user.id, why]);
  io.to(`session:${req.params.id}`).emit('attendance',
    { studentId: Number(req.params.studentId), status, method: 'MANUAL_OVERRIDE', excuse_reason: null, manual_reason: why });
  res.json({ ok: true });
}));

app.put('/api/sessions/:id/excuse/:studentId', only('teacher'), h(async (req, res) => {
  const { reason, note } = req.body;
  if (!L.EXCUSE_REASONS.includes(reason)) return bad(res, 'Choose a valid reason');
  const cleanNote = String(note || '').trim().slice(0, 80) || null;
  await db.query(
    `INSERT INTO attendance_records
       (session_id, student_id, status, method, marked_at, marked_by, excuse_reason, excuse_note)
     VALUES ($1,$2,'EXCUSED','MANUAL_OVERRIDE',now(),$3,$4,$5)
     ON CONFLICT (session_id, student_id)
     DO UPDATE SET status='EXCUSED', method='MANUAL_OVERRIDE', marked_at=now(), marked_by=$3,
                   excuse_reason=$4, excuse_note=$5, excuse_source=NULL, manual_reason=NULL`,
    [req.params.id, req.params.studentId, req.user.id, reason, cleanNote]);
  // The note is deliberately not broadcast; only the category is.
  io.to(`session:${req.params.id}`).emit('attendance',
    { studentId: Number(req.params.studentId), status: 'EXCUSED', method: 'MANUAL_OVERRIDE', excuse_reason: reason });
  res.json({ ok: true });
}));

app.get('/api/sessions/:id/roster', only('teacher'), h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT st.id, st.roll_no, st.name,
            COALESCE(a.status::text, 'ABSENT') AS status,
            a.method::text AS method,
            a.excuse_reason, a.excuse_note, a.marked_at, a.manual_reason
       FROM class_sessions cs
       JOIN enrollments e  ON e.course_id = cs.course_id
       JOIN students st    ON st.id = e.student_id
  LEFT JOIN attendance_records a ON a.session_id = cs.id AND a.student_id = st.id
      WHERE cs.id = $1
      ORDER BY st.roll_no`, [req.params.id]);
  res.json(rows);
}));

// ---- teacher: start, list and end classes ----------------------------------
app.get('/api/sessions', only('teacher'), h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT cs.id, c.code, c.title, cs.starts_at, cs.ends_at,
            (cs.is_open AND cs.ends_at >= now()) AS is_open,
            (cs.starts_at > now()) AS upcoming,
            (SELECT COUNT(*)::int FROM attendance_records a
              WHERE a.session_id = cs.id AND a.status IN ('PRESENT','LATE')) AS present,
            (SELECT COUNT(*)::int FROM enrollments e WHERE e.course_id = cs.course_id) AS enrolled
       FROM class_sessions cs JOIN courses c ON c.id = cs.course_id
      WHERE c.teacher_id = $1
      ORDER BY cs.starts_at DESC
      LIMIT 20`, [req.user.id]);
  res.json(rows);
}));

// Starts a class now. The room location comes from the teacher's device; if it isn't
// sent, the course's previous room is reused. Any other open class of the same course
// is closed first, so only one QR code is live per course.
app.post('/api/sessions', only('teacher'), h(async (req, res) => {
  const courseId = Number(req.body.course_id);
  // The teacher types the class's from and to times (sent as full timestamps by their device)
  const start = req.body.starts_at ? new Date(req.body.starts_at) : new Date();
  const end = new Date(req.body.ends_at);
  const timeErr = L.classTimeError(start, end);
  if (timeErr) return bad(res, timeErr);
  const own = await db.query('SELECT id FROM courses WHERE id=$1 AND teacher_id=$2', [courseId, req.user.id]);
  if (!own.rowCount) return bad(res, 'Course not found', 404);

  let { lat, lng } = req.body;
  let radius = Number(req.body.radius_m) || null;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
    const prev = await db.query(
      `SELECT room_lat, room_lng, radius_m FROM class_sessions
        WHERE course_id=$1 ORDER BY starts_at DESC LIMIT 1`, [courseId]);
    if (!prev.rowCount) return bad(res, 'Share your location to start the first class of this course');
    lat = prev.rows[0].room_lat;
    lng = prev.rows[0].room_lng;
    radius = radius || prev.rows[0].radius_m;
  }
  radius = Math.min(500, Math.max(20, radius || 50));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // a class starting now replaces the course's other open class; a later one doesn't
    await client.query(
      'UPDATE class_sessions SET is_open=false WHERE course_id=$1 AND is_open AND $2::timestamptz <= now()',
      [courseId, start]);
    const { rows } = await client.query(
      `INSERT INTO class_sessions
         (course_id, starts_at, ends_at, room_lat, room_lng, radius_m, qr_secret, is_open)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING id`, [courseId, start, end, lat, lng, radius, randomSecret()]);
    await client.query('COMMIT');
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// The teacher edits the from and/or to time of a class that hasn't ended. An ended class
// can't be reopened (start a new one instead).
app.put('/api/sessions/:id/time', only('teacher'), h(async (req, res) => {
  const cur = await db.query(
    `SELECT cs.starts_at, cs.ends_at FROM class_sessions cs
       JOIN courses c ON c.id = cs.course_id
      WHERE cs.id = $1 AND c.teacher_id = $2 AND cs.is_open AND cs.ends_at >= now()`,
    [req.params.id, req.user.id]);
  if (!cur.rowCount) return bad(res, 'Only a class that has not ended can be changed', 409);
  const start = req.body.starts_at ? new Date(req.body.starts_at) : cur.rows[0].starts_at;
  const end = req.body.ends_at ? new Date(req.body.ends_at) : cur.rows[0].ends_at;
  const timeErr = L.classTimeError(start, end);
  if (timeErr) return bad(res, timeErr);
  await db.query('UPDATE class_sessions SET starts_at=$2, ends_at=$3 WHERE id=$1',
    [req.params.id, start, end]);
  res.json({ starts_at: start, ends_at: end });
}));

app.post('/api/sessions/:id/end', only('teacher'), h(async (req, res) => {
  const { rowCount } = await db.query(
    `UPDATE class_sessions cs SET is_open=false, ends_at=LEAST(cs.ends_at, now())
       FROM courses c
      WHERE cs.id=$1 AND c.id=cs.course_id AND c.teacher_id=$2`, [req.params.id, req.user.id]);
  if (!rowCount) return bad(res, 'Class not found', 404);
  res.json({ ok: true });
}));

// ---- attendance summary (excused days are not counted against students) ----
async function summary(courseId, studentId = null) {
  const { rows } = await db.query(
    `SELECT st.id, st.roll_no, st.name,
            COUNT(*) FILTER (WHERE a.status IN ('PRESENT','LATE'))::int AS present,
            COUNT(*) FILTER (WHERE a.status = 'EXCUSED')::int            AS excused,
            COUNT(cs.id)::int                                            AS held
       FROM class_sessions cs
       JOIN enrollments e ON e.course_id = cs.course_id
       JOIN students st   ON st.id = e.student_id
  LEFT JOIN attendance_records a ON a.session_id = cs.id AND a.student_id = st.id
      WHERE cs.course_id = $1 AND cs.starts_at <= now()
        AND ($2::int IS NULL OR st.id = $2)
      GROUP BY st.id
      ORDER BY st.roll_no`, [courseId, studentId]);
  return rows.map((r) => {
    const pct = L.attendancePct(r.present, r.excused, r.held);
    return { ...r, pct, low: pct < 75 };
  });
}

app.get('/api/courses', h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, code, title FROM courses
      WHERE $1::text IN ('teacher', 'hod')
         OR ($1::text = 'student' AND id IN (SELECT course_id FROM enrollments WHERE student_id = $2))
      ORDER BY code`, [req.user.role, req.user.id]);
  res.json(rows);
}));

app.get('/api/courses/:id/attendance-summary', only('teacher'), h(async (req, res) => {
  res.json(await summary(req.params.id));
}));

// ---- one scanner for the whole class ----------------------------------------
// The student's phone shows this rotating personal QR; the teacher's device scans it.
app.get('/api/me/qr', only('student'), h(async (req, res) => {
  res.json(L.currentToken(`st${req.user.id}`, L.studentSecret(MASTER_SECRET, req.user.id)));
}));

app.post('/api/sessions/:id/scan-student', only('teacher'), h(async (req, res) => {
  const token = String(req.body.token || '');
  const m = /^st(\d+)$/.exec(token.split('.')[0]);
  if (!m) return bad(res, 'Not a student QR code');
  const studentId = Number(m[1]);
  const tokenErr = L.checkToken(token, L.studentSecret(MASTER_SECRET, studentId));
  if (tokenErr) return bad(res, tokenErr);

  const sess = await db.query('SELECT course_id, is_open, starts_at, ends_at FROM class_sessions WHERE id=$1', [req.params.id]);
  if (!sess.rows[0]) return bad(res, 'Class not found', 404);
  if (!sess.rows[0].is_open || sess.rows[0].ends_at < new Date()) return bad(res, 'This class has ended', 403);
  if (sess.rows[0].starts_at > new Date()) return bad(res, 'This class has not started yet', 403);

  const { rows } = await db.query(
    `SELECT s.id, s.name, s.roll_no,
            (SELECT a.status::text FROM attendance_records a
              WHERE a.session_id = $1 AND a.student_id = s.id) AS prev
       FROM students s
       JOIN enrollments e ON e.student_id = s.id AND e.course_id = $2
      WHERE s.id = $3`, [req.params.id, sess.rows[0].course_id, studentId]);
  const st = rows[0];
  if (!st) return bad(res, 'This student is not enrolled in this class', 403);

  const already = ['PRESENT', 'LATE'].includes(st.prev);
  if (!already) {
    await db.query(
      `INSERT INTO attendance_records (session_id, student_id, status, method, marked_at)
       VALUES ($1,$2,'PRESENT','QR',now())
       ON CONFLICT (session_id, student_id)
       DO UPDATE SET status='PRESENT', method='QR', marked_at=now(),
                     excuse_reason=NULL, excuse_note=NULL, excuse_source=NULL, manual_reason=NULL`,
      [req.params.id, studentId]);
    io.to(`session:${req.params.id}`).emit('attendance',
      { studentId, status: 'PRESENT', method: 'QR', excuse_reason: null });
  }
  res.json({ id: st.id, name: st.name, roll_no: st.roll_no, already });
}));

app.get('/api/me/summary', only('student'), h(async (req, res) => {
  const rows = await summary(req.query.courseId, req.user.id);
  res.json(rows[0] || null);
}));

// ---- exam schedule ---------------------------------------------------------
app.get('/api/exams', h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT x.id, c.code, c.title, x.room,
            to_char(x.exam_date, 'YYYY-MM-DD') AS exam_date,
            to_char(x.start_time, 'HH24:MI')   AS start_time
       FROM exams x JOIN courses c ON c.id = x.course_id
      WHERE $1::text IN ('teacher', 'hod', 'other')
         OR ($1::text = 'student' AND x.course_id IN (SELECT course_id FROM enrollments WHERE student_id = $2))
      ORDER BY x.exam_date, x.start_time`, [req.user.role, req.user.id]);
  res.json(rows);
}));

app.post('/api/exams', only('teacher'), h(async (req, res) => {
  const { course_id, exam_date, start_time, room } = req.body;
  const r = String(room || '').trim().slice(0, 40);
  if (!Number.isInteger(course_id) || !/^\d{4}-\d{2}-\d{2}$/.test(exam_date || '') ||
      !/^\d{2}:\d{2}$/.test(start_time || '') || !r)
    return bad(res, 'Fill in course, date, time and room');
  try {
    const { rows } = await db.query(
      'INSERT INTO exams (course_id, exam_date, start_time, room) VALUES ($1,$2,$3,$4) RETURNING id',
      [course_id, exam_date, start_time, r]);
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'That room is already booked at that time', 409);
    if (e.code === '23503') return bad(res, 'Unknown course');
    if (e.code === '22007' || e.code === '22008') return bad(res, 'Invalid date or time');
    throw e;
  }
}));

app.delete('/api/exams/:id', only('teacher'), h(async (req, res) => {
  await db.query('DELETE FROM exams WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---- college events (cultural, sports, workshops...) -----------------------
app.get('/api/events', h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ev.id, ev.name, ev.type,
            to_char(ev.event_date, 'YYYY-MM-DD') AS event_date,
            (ev.room_lat IS NOT NULL) AS has_location,
            (SELECT COUNT(*)::int FROM event_attendance ea WHERE ea.event_id = ev.id) AS attended_count,
            (SELECT COUNT(*)::int FROM event_participants ep WHERE ep.event_id = ev.id) AS participant_count,
            EXISTS (SELECT 1 FROM event_participants ep
                     WHERE ep.event_id = ev.id AND ep.student_id = $1) AS going,
            EXISTS (SELECT 1 FROM event_attendance ea
                     WHERE ea.event_id = ev.id AND ea.student_id = $1) AS attended
       FROM events ev
      ORDER BY ev.event_date, ev.id`, [req.user.role === 'student' ? req.user.id : 0]);
  res.json(rows);
}));

app.post('/api/events', only('teacher'), h(async (req, res) => {
  const { name, type, event_date, room_lat, room_lng, radius_m } = req.body;
  const n = String(name || '').trim().slice(0, 60);
  if (!n || !L.EVENT_TYPES.includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(event_date || ''))
    return bad(res, 'Enter the event name, type and date');
  const hasLoc = typeof room_lat === 'number' && typeof room_lng === 'number' &&
                 isFinite(room_lat) && isFinite(room_lng);
  const radius = Math.min(2000, Math.max(20, Number(radius_m) || 150));
  try {
    const { rows } = await db.query(
      `INSERT INTO events (name, type, event_date, room_lat, room_lng, radius_m, qr_secret, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [n, type, event_date, hasLoc ? room_lat : null, hasLoc ? room_lng : null,
       radius, randomSecret(), req.user.id]);
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '22007' || e.code === '22008') return bad(res, 'Invalid date');
    throw e;
  }
}));

app.delete('/api/events/:id', only('teacher'), h(async (req, res) => {
  await db.query('DELETE FROM events WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/events/:id/qr', only('teacher'), h(async (req, res) => {
  const { rows } = await db.query('SELECT id, qr_secret FROM events WHERE id=$1', [req.params.id]);
  if (!rows[0]) return bad(res, 'Event not found', 404);
  res.json(L.currentToken(`ev${rows[0].id}`, rows[0].qr_secret));
}));

app.post('/api/events/scan', only('student'), h(async (req, res) => {
  const { token, lat, lng } = req.body;
  const m = /^ev(\d+)$/.exec(String(token || '').split('.')[0]);
  if (!m) return bad(res, 'Malformed token');

  const { rows } = await db.query('SELECT * FROM events WHERE id=$1', [m[1]]);
  const ev = rows[0];
  if (!ev) return bad(res, 'Event not found', 404);

  const tokenErr = L.checkToken(token, ev.qr_secret);
  if (tokenErr) return bad(res, tokenErr);
  const geoErr = L.geofenceError(lat, lng, ev.room_lat, ev.room_lng, ev.radius_m);
  if (geoErr) return bad(res, geoErr, geoErr === 'Location required' ? 400 : 403);

  await db.query(
    `INSERT INTO event_attendance (event_id, student_id, method) VALUES ($1,$2,'QR')
     ON CONFLICT (event_id, student_id) DO NOTHING`, [ev.id, req.user.id]);
  io.to(`event:${ev.id}`).emit('event-attendance', { studentId: req.user.id, attended: true });
  res.json({ status: 'ATTENDED' });
}));

app.get('/api/events/:id/attendance', only('teacher'), h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT st.id, st.roll_no, st.name, (ea.student_id IS NOT NULL) AS attended
       FROM students st
  LEFT JOIN event_attendance ea ON ea.student_id = st.id AND ea.event_id = $1
      ORDER BY st.roll_no`, [req.params.id]);
  res.json(rows);
}));

app.put('/api/events/:id/attendance/:studentId', only('teacher'), h(async (req, res) => {
  const { attended } = req.body;
  if (typeof attended !== 'boolean') return bad(res, 'attended must be true or false');
  if (attended) {
    await db.query(
      `INSERT INTO event_attendance (event_id, student_id, method) VALUES ($1,$2,'MANUAL_OVERRIDE')
       ON CONFLICT (event_id, student_id) DO NOTHING`, [req.params.id, req.params.studentId]);
  } else {
    await db.query('DELETE FROM event_attendance WHERE event_id=$1 AND student_id=$2',
      [req.params.id, req.params.studentId]);
  }
  io.to(`event:${req.params.id}`).emit('event-attendance',
    { studentId: Number(req.params.studentId), attended });
  res.json({ ok: true });
}));

// ---- on-duty: students going to an event for the college -------------------
app.get('/api/events/:id/participants', only('teacher'), h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT st.id, st.roll_no, st.name, (ep.student_id IS NOT NULL) AS going
       FROM students st
  LEFT JOIN event_participants ep ON ep.student_id = st.id AND ep.event_id = $1
      ORDER BY st.roll_no`, [req.params.id]);
  res.json(rows);
}));

app.put('/api/events/:id/participants/:studentId', only('teacher'), h(async (req, res) => {
  const { going } = req.body;
  if (typeof going !== 'boolean') return bad(res, 'going must be true or false');
  if (going) {
    await db.query(
      `INSERT INTO event_participants (event_id, student_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [req.params.id, req.params.studentId]);
  } else {
    await db.query('DELETE FROM event_participants WHERE event_id=$1 AND student_id=$2',
      [req.params.id, req.params.studentId]);
  }
  res.json({ ok: true });
}));

// Marks every class on the event's date as EXCUSED ("College event / sports") for the
// students who are going. Students who actually attended class (PRESENT or LATE) are
// left alone. Safe to run again after adding more students.
app.post('/api/events/:id/on-duty', only('teacher'), h(async (req, res) => {
  const ev = await db.query('SELECT name FROM events WHERE id=$1', [req.params.id]);
  if (!ev.rows[0]) return bad(res, 'Event not found', 404);
  const note = `On duty: ${ev.rows[0].name}`.slice(0, 80);
  const { rows } = await db.query(
    `INSERT INTO attendance_records
       (session_id, student_id, status, method, marked_at, marked_by,
        excuse_reason, excuse_note, excuse_source)
     SELECT cs.id, ep.student_id, 'EXCUSED'::attendance_status, 'MANUAL_OVERRIDE'::checkin_method,
            now(), $2::int, 'College event / sports', $3::text, 'event:' || ev.id
       FROM events ev
       JOIN event_participants ep ON ep.event_id = ev.id
       JOIN enrollments en        ON en.student_id = ep.student_id
       JOIN class_sessions cs     ON cs.course_id = en.course_id
                                 AND (cs.starts_at AT TIME ZONE $4::text)::date = ev.event_date
      WHERE ev.id = $1
     ON CONFLICT (session_id, student_id) DO UPDATE
        SET status='EXCUSED', method='MANUAL_OVERRIDE', marked_at=now(), marked_by=$2,
            excuse_reason='College event / sports', excuse_note=$3,
            excuse_source=EXCLUDED.excuse_source, manual_reason=NULL
      WHERE attendance_records.status NOT IN ('PRESENT','LATE')
     RETURNING session_id, student_id`,
    [req.params.id, req.user.id, note, TZ]);
  emitRows(rows, 'EXCUSED', 'College event / sports');
  res.json({ updated: rows.length });
}));

// Undo: puts back to ABSENT only the records this event's on-duty created. Anything the
// teacher changed by hand afterwards (it no longer carries the event's source) is kept.
app.delete('/api/events/:id/on-duty', only('teacher'), h(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE attendance_records
        SET status='ABSENT', method=NULL, marked_at=NULL, marked_by=NULL,
            excuse_reason=NULL, excuse_note=NULL, excuse_source=NULL, manual_reason=NULL
      WHERE status='EXCUSED' AND excuse_source = 'event:' || $1::text
      RETURNING session_id, student_id`, [req.params.id]);
  emitRows(rows, 'ABSENT', null);
  res.json({ updated: rows.length });
}));

// ---- leave requests --------------------------------------------------------
app.get('/api/leave-requests', h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT lr.id, lr.student_id, st.name, st.roll_no, lr.category, lr.reason, lr.status,
            to_char(lr.from_date, 'YYYY-MM-DD') AS from_date,
            to_char(lr.to_date,   'YYYY-MM-DD') AS to_date
       FROM leave_requests lr JOIN students st ON st.id = lr.student_id
      WHERE $1::text = 'teacher' OR ($1::text = 'student' AND lr.student_id = $2)
      ORDER BY (lr.status = 'PENDING') DESC, lr.from_date DESC, lr.id DESC`,
    [req.user.role, req.user.id]);
  res.json(rows);
}));

app.post('/api/leave-requests', only('student'), h(async (req, res) => {
  const { from_date, to_date, category, reason } = req.body;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(from_date || '') || !iso.test(to_date || '')) return bad(res, 'Enter the from and to dates');
  if (!L.LEAVE_CATEGORIES.includes(category)) return bad(res, 'Choose a reason type');
  if (from_date > to_date) return bad(res, 'The end date is before the start date');
  const days = (new Date(to_date) - new Date(from_date)) / 86400000 + 1;
  if (days > 31) return bad(res, 'A single request can cover at most 31 days');
  try {
    const { rows } = await db.query(
      `INSERT INTO leave_requests (student_id, from_date, to_date, category, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.user.id, from_date, to_date, category, String(reason || '').trim().slice(0, 200) || null]);
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '22007' || e.code === '22008') return bad(res, 'Invalid date');
    if (e.code === '23503') return bad(res, 'Unknown student', 403);
    throw e;
  }
}));

// Approving excuses the student's classes in the date range (never overwrites PRESENT/LATE).
// Only classes that already exist are changed, so approve after the dates have classes.
app.put('/api/leave-requests/:id/decision', only('teacher'), h(async (req, res) => {
  const { decision } = req.body;
  if (!['APPROVED', 'REJECTED'].includes(decision)) return bad(res, 'Decision must be APPROVED or REJECTED');
  const client = await db.connect();
  let rows = [];
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE leave_requests SET status=$2, decided_by=$3, decided_at=now()
        WHERE id=$1 AND status='PENDING' RETURNING id`,
      [req.params.id, decision, req.user.id]);
    if (!upd.rowCount) {
      await client.query('ROLLBACK');
      return bad(res, 'Request not found or already decided', 409);
    }
    if (decision === 'APPROVED') {
      ({ rows } = await client.query(
        `INSERT INTO attendance_records
           (session_id, student_id, status, method, marked_at, marked_by,
            excuse_reason, excuse_note, excuse_source)
         SELECT cs.id, lr.student_id, 'EXCUSED'::attendance_status, 'MANUAL_OVERRIDE'::checkin_method,
                now(), $2::int, lr.category, 'Approved leave', 'leave:' || lr.id
           FROM leave_requests lr
           JOIN enrollments en    ON en.student_id = lr.student_id
           JOIN class_sessions cs ON cs.course_id = en.course_id
                                 AND (cs.starts_at AT TIME ZONE $3::text)::date
                                     BETWEEN lr.from_date AND lr.to_date
          WHERE lr.id = $1
         ON CONFLICT (session_id, student_id) DO UPDATE
            SET status='EXCUSED', method='MANUAL_OVERRIDE', marked_at=now(), marked_by=$2,
                excuse_reason=EXCLUDED.excuse_reason, excuse_note=EXCLUDED.excuse_note,
                excuse_source=EXCLUDED.excuse_source, manual_reason=NULL
          WHERE attendance_records.status NOT IN ('PRESENT','LATE')
         RETURNING session_id, student_id, excuse_reason`,
        [req.params.id, req.user.id, TZ]));
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  for (const r of rows) {
    io.to(`session:${r.session_id}`).emit('attendance', {
      studentId: r.student_id, status: 'EXCUSED', method: 'MANUAL_OVERRIDE', excuse_reason: r.excuse_reason });
  }
  res.json({ ok: true, updated: rows.length });
}));

// ---- HOD (head of department) ---------------------------------------------
// One screen for the whole department: every course's attendance, the students who are
// below 75% anywhere, and the classes held in the last 24 hours.
app.get('/api/hod/overview', only('hod'), h(async (req, res) => {
  const { rows: courses } = await db.query(
    `SELECT c.id, c.code, c.title, c.teacher_id,
            (SELECT COUNT(*)::int FROM enrollments e WHERE e.course_id = c.id) AS enrolled
       FROM courses c ORDER BY c.code`);
  const out = [];
  for (const c of courses) {
    const rows = await summary(c.id);
    out.push({
      ...c,
      avg_pct: rows.length ? Math.round(rows.reduce((a, r) => a + r.pct, 0) / rows.length) : null,
      low: rows.filter((r) => r.low).map((r) => ({ id: r.id, name: r.name, roll_no: r.roll_no, pct: r.pct })),
    });
  }
  const { rows: recent } = await db.query(
    `SELECT cs.id, c.code, cs.starts_at, cs.ends_at,
            (cs.is_open AND cs.ends_at >= now()) AS is_open,
            (SELECT COUNT(*)::int FROM attendance_records a
              WHERE a.session_id = cs.id AND a.status IN ('PRESENT','LATE')) AS present,
            (SELECT COUNT(*)::int FROM enrollments e WHERE e.course_id = cs.course_id) AS enrolled
       FROM class_sessions cs JOIN courses c ON c.id = cs.course_id
      WHERE cs.starts_at >= now() - interval '24 hours'
      ORDER BY cs.starts_at DESC`);
  res.json({ courses: out, recent });
}));

// ---- timetable -------------------------------------------------------------
// The HOD sets it (with its own from/to time for every period); teachers and students
// read it. Students only see their own courses, teachers only theirs.
const SLOT_SELECT = `
  SELECT t.id, t.course_id, c.code, c.title, c.teacher_id, t.day_of_week AS day,
         to_char(t.start_time, 'HH24:MI') AS start_time,
         to_char(t.end_time,   'HH24:MI') AS end_time, t.room
    FROM timetable_slots t JOIN courses c ON c.id = t.course_id`;

// Returns a message if the period clashes with another one, else null. A clash is an
// overlapping period on the same day in the same room, or for the same professor.
async function slotConflict(courseId, day, start, end, room, ignoreId = 0) {
  const { rows } = await db.query(
    `SELECT c.code, t.room, (lower(t.room) = lower($5)) AS same_room
       FROM timetable_slots t JOIN courses c ON c.id = t.course_id
      WHERE t.day_of_week = $2 AND t.id <> $6
        AND t.start_time < $4::time AND $3::time < t.end_time
        AND (lower(t.room) = lower($5)
             OR c.teacher_id = (SELECT teacher_id FROM courses WHERE id = $1))
      ORDER BY (lower(t.room) = lower($5)) DESC
      LIMIT 1`, [courseId, day, start, end, room, ignoreId]);
  if (!rows.length) return null;
  return rows[0].same_room
    ? `${rows[0].room} is already booked then (${rows[0].code})`
    : `That professor already has ${rows[0].code} at that time`;
}

app.get('/api/timetable', h(async (req, res) => {
  const { rows } = await db.query(
    `${SLOT_SELECT}
      WHERE $1::text IN ('hod', 'other')
         OR ($1::text = 'teacher' AND c.teacher_id = $2)
         OR ($1::text = 'student'
             AND t.course_id IN (SELECT course_id FROM enrollments WHERE student_id = $2))
      ORDER BY t.day_of_week, t.start_time`, [req.user.role, req.user.id]);
  res.json(rows);
}));

app.post('/api/timetable', only('hod'), h(async (req, res) => {
  const { course_id, day, start_time, end_time } = req.body;
  const room = String(req.body.room || '').trim().slice(0, 40);
  const err = L.slotError({ day, start: start_time, end: end_time, room });
  if (err) return bad(res, err);
  if (!Number.isInteger(course_id)) return bad(res, 'Choose a course');
  const course = await db.query('SELECT id FROM courses WHERE id=$1', [course_id]);
  if (!course.rowCount) return bad(res, 'Choose a course');
  const conflict = await slotConflict(course_id, day, start_time, end_time, room);
  if (conflict) return bad(res, conflict, 409);
  const { rows } = await db.query(
    `INSERT INTO timetable_slots (course_id, day_of_week, start_time, end_time, room)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [course_id, day, start_time, end_time, room]);
  res.status(201).json({ id: rows[0].id });
}));

// Edit any part of a period (typically its from/to time); fields left out stay as they were.
app.put('/api/timetable/:id', only('hod'), h(async (req, res) => {
  const cur = await db.query(
    `SELECT course_id, day_of_week AS day, to_char(start_time,'HH24:MI') AS start_time,
            to_char(end_time,'HH24:MI') AS end_time, room
       FROM timetable_slots WHERE id=$1`, [req.params.id]);
  if (!cur.rowCount) return bad(res, 'Period not found', 404);
  const c = cur.rows[0];
  const next = {
    course_id: req.body.course_id ?? c.course_id,
    day: req.body.day ?? c.day,
    start_time: req.body.start_time ?? c.start_time,
    end_time: req.body.end_time ?? c.end_time,
    room: String(req.body.room ?? c.room).trim().slice(0, 40),
  };
  const err = L.slotError({ day: next.day, start: next.start_time, end: next.end_time, room: next.room });
  if (err) return bad(res, err);
  if (!Number.isInteger(next.course_id)) return bad(res, 'Choose a course');
  const conflict = await slotConflict(next.course_id, next.day, next.start_time, next.end_time,
                                      next.room, Number(req.params.id));
  if (conflict) return bad(res, conflict, 409);
  await db.query(
    `UPDATE timetable_slots SET course_id=$2, day_of_week=$3, start_time=$4, end_time=$5, room=$6
      WHERE id=$1`,
    [req.params.id, next.course_id, next.day, next.start_time, next.end_time, next.room]);
  res.json({ ok: true });
}));

app.delete('/api/timetable/:id', only('hod'), h(async (req, res) => {
  await db.query('DELETE FROM timetable_slots WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---- feedback about the app --------------------------------------------------
// Anyone can send it from the menu, at most FEEDBACK_LIMIT messages per 48 hours. The HOD reads it.
app.get('/api/feedback/mine', h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, category, message, created_at FROM feedback
      WHERE role = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 20`, [req.user.role, req.user.id]);
  res.json({ items: rows, limit: L.FEEDBACK_LIMIT, window_hours: 48,
             ...L.feedbackQuota(rows.map((r) => r.created_at)) });
}));

app.post('/api/feedback', h(async (req, res) => {
  if (!['student', 'teacher', 'hod', 'other'].includes(req.user.role) || !Number.isInteger(req.user.id))
    return bad(res, 'Please sign in first', 401);
  const err = L.feedbackError(req.body.category, req.body.message);
  if (err) return bad(res, err);
  const { rows } = await db.query(
    `SELECT created_at FROM feedback
      WHERE role = $1 AND user_id = $2 AND created_at > now() - interval '48 hours'`,
    [req.user.role, req.user.id]);
  const quota = L.feedbackQuota(rows.map((r) => r.created_at));
  if (quota.remaining < 1) {
    return res.status(429).json({
      error: `You have already sent ${L.FEEDBACK_LIMIT} feedback messages in the last 2 days. Please try again later.`,
      next_at: quota.next_at });
  }
  await db.query('INSERT INTO feedback (user_id, role, category, message) VALUES ($1,$2,$3,$4)',
    [req.user.id, req.user.role, req.body.category, String(req.body.message).trim()]);
  res.status(201).json({ ok: true, remaining: quota.remaining - 1 });
}));

app.get('/api/feedback', only('hod'), h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, role, user_id, category, message, created_at FROM feedback
      ORDER BY created_at DESC LIMIT 100`);
  res.json(rows);
}));

// ---- errors ----------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

server.listen(3000, () => console.log('API on :3000'));
