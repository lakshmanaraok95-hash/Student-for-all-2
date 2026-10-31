// DEV ONLY: wipes the database and loads test data.
// Usage: npm run seed   (requires the --reset flag, already in the npm script)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const A = require('./auth');

// TEST ACCOUNTS ONLY. Change or remove these before any real use.
const PASSWORDS = { student: 'Student@123', teacher: 'Teach@123', hod: 'Hod@12345', other: 'Guest@123' };

const secret = () => crypto.randomBytes(32).toString('hex');

// One letter per past class, oldest first: P = present, A = absent, E = excused
const PAST = { 1: 'PPPPPP', 2: 'PPAPPP', 3: 'PPPPPP', 4: 'AAEEAP', 5: 'PPPPEP' };

(async () => {
  if (!process.argv.includes('--reset')) {
    console.error('Refusing to run: this DROPS all tables. Re-run with --reset.');
    process.exit(1);
  }
  const lat = parseFloat(process.env.ROOM_LAT);
  const lng = parseFloat(process.env.ROOM_LNG);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    console.error('Set ROOM_LAT and ROOM_LNG in .env first (the geofence needs a classroom location).');
    process.exit(1);
  }
  const radius = parseInt(process.env.ROOM_RADIUS || '100', 10);

  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

    const names = ['Asha Reddy', 'Ravi Kumar', 'Meena Iyer', 'Imran Khan', 'Sneha Rao'];
    for (let i = 0; i < names.length; i++) {
      await db.query('INSERT INTO students (roll_no, name, email) VALUES ($1,$2,$3)',
        [`CS2026${String(i + 1).padStart(2, '0')}`, names[i], `student${i + 1}@example.edu`]);
    }

    // Accounts for signing in. actor_id is the id the rest of the app uses for the person.
    const addUser = (role, loginId, name, actorId) => db.query(
      'INSERT INTO users (role, login_id, name, password_hash, actor_id) VALUES ($1,$2,$3,$4,$5)',
      [role, loginId, name, A.hashPassword(PASSWORDS[role]), actorId]);
    for (let i = 0; i < names.length; i++)
      await addUser('student', `CS2026${String(i + 1).padStart(2, '0')}`, names[i], i + 1);
    await addUser('teacher', 'EMP001', 'Professor A', 1);   // 1 = courses.teacher_id
    await addUser('hod', 'HOD001', 'Head of Department', 2);
    await addUser('other', 'GUEST01', 'Guest', 3);

    // teacher_id 1 is just a number: it is the professor's actor_id above
    await db.query("INSERT INTO courses (code, title, teacher_id) VALUES ('CS101','Intro to Programming',1)");
    await db.query("INSERT INTO courses (code, title, teacher_id) VALUES ('MA102','Engineering Maths',1)");
    for (let sid = 1; sid <= names.length; sid++) {
      await db.query('INSERT INTO enrollments (student_id, course_id) VALUES ($1,1)', [sid]);
      await db.query('INSERT INTO enrollments (student_id, course_id) VALUES ($1,2)', [sid]);
    }

    // Session 1 = today's open class (the one the web app uses by default)
    await db.query(
      `INSERT INTO class_sessions (course_id, starts_at, ends_at, room_lat, room_lng, radius_m, qr_secret)
       VALUES (1, now(), now() + interval '2 hours', $1, $2, $3, $4)`,
      [lat, lng, radius, secret()]);

    // Six earlier classes so the analytics have history
    for (let n = 1; n <= 6; n++) {
      const { rows } = await db.query(
        `INSERT INTO class_sessions
           (course_id, starts_at, ends_at, room_lat, room_lng, radius_m, qr_secret, is_open)
         VALUES (1, now() - make_interval(days => $1),
                 now() - make_interval(days => $1) + interval '1 hour', $2, $3, $4, $5, false)
         RETURNING id`,
        [n, lat, lng, radius, secret()]);
      const sessionId = rows[0].id;
      const col = 6 - n; // n=6 is the oldest class, so it uses the first letter
      for (let sid = 1; sid <= names.length; sid++) {
        const c = PAST[sid][col];
        const status = { P: 'PRESENT', A: 'ABSENT', E: 'EXCUSED' }[c];
        await db.query(
          `INSERT INTO attendance_records
             (session_id, student_id, status, method, marked_at, marked_by, excuse_reason)
           VALUES ($1,$2,$3,$4, now() - make_interval(days => $5), $6, $7)`,
          [sessionId, sid, status,
           c === 'P' ? 'QR' : c === 'E' ? 'MANUAL_OVERRIDE' : null,
           n, c === 'E' ? 1 : null, c === 'E' ? 'Medical' : null]);
      }
    }

    await db.query(
      `INSERT INTO exams (course_id, exam_date, start_time, room) VALUES
         (1, current_date + 14, '10:00', 'Room 204'),
         (2, current_date + 16, '14:00', 'Hall A')`);

    // Weekly timetable (1 = Monday). One slot falls on a Saturday so there is always
    // something to fill in from, even at the weekend.
    await db.query(
      `INSERT INTO timetable_slots (course_id, day_of_week, start_time, end_time, room) VALUES
         (1, 1, '10:00', '10:50', 'Room 204'),
         (1, 3, '10:00', '10:50', 'Room 204'),
         (1, 5, '10:00', '10:50', 'Room 204'),
         (1, 6, '09:00', '09:50', 'Room 204'),
         (2, 2, '11:00', '11:50', 'Hall A'),
         (2, 4, '11:00', '11:50', 'Hall A'),
         (2, 5, '14:00', '14:50', 'Hall A')`);

    await db.query(
      `INSERT INTO events (name, type, event_date, room_lat, room_lng, radius_m, qr_secret, created_by) VALUES
         ('Annual Cultural Fest', 'Cultural', current_date + 7,  $1, $2, 200, $3, 1),
         ('Inter-College Cricket', 'Sports',  current_date + 10, $1, $2, 200, $4, 1)`,
      [lat, lng, secret(), secret()]);
    await db.query(
      `INSERT INTO event_attendance (event_id, student_id, method) VALUES (1,1,'QR'),(1,3,'QR')`);

    // An away event happening today, so you can try "apply on-duty" on today's class.
    // No venue location: it's held off campus, so there is no QR distance check.
    await db.query(
      `INSERT INTO events (name, type, event_date, qr_secret, created_by)
       VALUES ('Inter-College Quiz', 'Other', current_date, $1, 1)`, [secret()]);
    await db.query(`INSERT INTO event_participants (event_id, student_id) VALUES (3,2),(3,5)`);

    // Sample leave requests: two waiting for a decision, one already rejected
    await db.query(
      `INSERT INTO leave_requests (student_id, from_date, to_date, category, reason, status, decided_by, decided_at) VALUES
         (3, current_date,     current_date,     'Medical',          'Not feeling well',            'PENDING',  NULL, NULL),
         (4, current_date - 3, current_date - 2, 'Family emergency', 'Family function out of town', 'PENDING',  NULL, NULL),
         (5, current_date - 5, current_date - 5, 'Other',            'Document verification',       'REJECTED', 1, now())`);

    console.log('Test accounts (choose the role, then enter the ID and password):');
    console.log(`  Student    CS202601 ... CS202605   ${PASSWORDS.student}`);
    console.log(`  Professor  EMP001                  ${PASSWORDS.teacher}`);
    console.log(`  HOD        HOD001                  ${PASSWORDS.hod}`);
    console.log(`  Others     GUEST01                 ${PASSWORDS.other}`);
    console.log('Seeded: 5 students (ids 1-5), teacher id 1, courses CS101 + MA102,');
    console.log('        open session id 1 plus 6 past classes, 2 exams, 3 events (one today, 2 students going), 3 leave requests, 7 timetable periods.');
  } catch (e) {
    console.error('Seed failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
})();
