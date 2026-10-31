# College Attendance System: the total prompt

Two versions are below. **Part A** is a short prompt for a quick start. **Part B** is the full specification, the version to paste when you want the whole project rebuilt. Paste Part B in one go, then follow the "How to build it" order at the bottom so the AI builds it piece by piece instead of all at once.

---

## Part A: short prompt

> Build a web-based college attendance system. Backend: Node.js, Express, PostgreSQL and socket.io. Frontend: React (Vite) and Tailwind CSS. There are four roles: student, professor, head of department (HOD) and others (staff and guests). The app first asks who you are, then shows the sign-in page for that role. A professor starts a class by choosing the course and typing their own From and To times, then selects it and shows one QR code that changes every 15 seconds. Every student scans that same code on their own phone, and the server checks the code, the time window, enrollment and the student's distance from the classroom before marking them present. The professor sees a live roster with manual override. Include excused absences (health or other reasons, excluded from the attendance percentage), leave requests, exam schedules, college events with on-duty attendance, a weekly timetable set by the HOD, a HOD overview, a menu, and offline mind games. Explain everything simply, because I am building this from a tablet.

---

## Part B: full specification

### 1. Goal and context
Build a web app for a college where students mark class attendance with one QR code shown by the professor. The builder works from a tablet with no laptop, so the project must run in a GitHub Codespace, with simple setup scripts and plain-language explanations. Camera and GPS need HTTPS, so testing uses the Codespace's forwarded HTTPS link.

### 2. Tech stack
- **Backend:** Node.js (CommonJS), Express 4, `pg`, `socket.io`, `dotenv`.
- **Database:** PostgreSQL.
- **Frontend:** React 18 with Vite, Tailwind CSS 4 (`@tailwindcss/vite`), `html5-qrcode` (scanner), `qrcode.react` (QR display), `socket.io-client`.
- Vite proxies `/api` and `/socket.io` (with websockets) to the backend on port 3000, so the browser only needs one address. `allowedHosts` must be `true` so tunnel hostnames work.
- Put the pure logic (tokens, geofence, percentage and time rules) in a `lib.js` with unit tests (`npm test`).

### 3. Roles
- **Student:** scans the class QR, sees their own attendance, leave, events, exams and timetable.
- **Professor (teacher):** starts and manages classes, sees the live roster, marks excused absences, approves leave, runs events and exams.
- **HOD (head of department):** sees department overview and sets the timetable.
- **Others:** staff and guests. They see only the timetable and exam schedule, and can send feedback.
- **Sign-in:** the first screen asks "Who are you?" (Student, Professor, HOD, Others). The next screen is the sign-in page for that role: roll number for students, employee ID for staff, plus a password. The role chosen must match the account.
- Passwords are stored only as salted scrypt hashes. A successful sign-in returns a signed token (HMAC, expires after 12 hours) that every later request and every socket carries. After 5 wrong passwords in a row an account is locked for 15 minutes. Anyone can change their own password from the menu. Accounts come from the seed script or a small command-line tool (`create-user.js`).
- Keep the token in `sessionStorage` (forgotten when the tab closes, safer on a shared tablet). An optional `ALLOW_DEV_LOGIN=1` setting accepts the old `x-user-id` / `x-role` headers on test machines only; it must stay off anywhere shared.

### 4. Database (PostgreSQL)
Tables: `students`, `courses` (with `teacher_id`), `enrollments`, `class_sessions` (course, `starts_at`, `ends_at`, room latitude and longitude, `radius_m`, `qr_secret`, `is_open`), `attendance_records`, `leave_requests`, `exams`, `events`, `event_attendance`, `event_participants`, `timetable_slots`, `feedback`, `users` (login ID, role, password hash, failed-attempt counter and lock time).

Key rules:
- `feedback` (user, role, category, message, time). `attendance_records`: also stores `manual_reason` (Technical issue or Other) for students marked present by hand. Status is `PRESENT`, `ABSENT`, `LATE` or `EXCUSED`. The method is `QR` or `MANUAL_OVERRIDE`. It is unique on `(session_id, student_id)`. It also stores `marked_by`, the student's reported lat/lng for QR check-ins, `excuse_reason` (one of Medical, Family emergency, College event / sports, Other), `excuse_note` and `excuse_source` (`event:<id>` or `leave:<id>`) and `manual_reason` (Technical issue or Other, set when the professor marks a student present by hand). A CHECK constraint says the three excuse columns may only be set when the status is `EXCUSED`.
- `exams`: a unique index on `(lower(room), exam_date, start_time)` so a room can't be double-booked.
- `events`: type is Cultural, Sports, Workshop or Other. The venue location is optional; without it there is no distance check.
- `timetable_slots`: `day_of_week` 1 to 7 (1 = Monday), `start_time` before `end_time`.
- `leave_requests`: category is Medical, Family emergency or Other. Status is PENDING, APPROVED or REJECTED. `from_date` must be on or before `to_date`.
- A seed script (`npm run seed`) wipes the database and loads test data. It must refuse to run without a `--reset` flag. Seed 5 students, 2 courses, one open class, 6 past classes with mixed attendance, 2 exams, 3 events (one today with 2 students going), 3 leave requests and 7 timetable periods (including one on a Saturday).

### 5. Core feature: one QR for the whole class
**The professor's flow:**
1. Open the **Classes** tab and pick a course.
2. Set **From** and **To** times with the time selector (see section 11). There are no preset lengths such as 45 or 60 minutes.
3. Optionally tap "Use my location as the classroom"; if skipped, reuse the course's previous room and radius. The first class of a course requires a location.
4. Tap **Start class**. The app opens the **Class QR** screen.
5. The professor can select any of their classes, **Edit time** (From and To) on a class that hasn't ended, or **End class**.

**Rules:**
- A class can be at most 8 hours long. The end time must be after the start time and must not already have passed.
- Starting a class whose From time is now or earlier closes that course's other open class. A class that starts later does not.
- The class closes automatically at its To time. An ended class cannot be reopened.
- The QR and student check-in work only between From and To.

**QR token:** `<sessionId>.<windowIndex>.<signature>`. The window index is `floor(now / 15 seconds)`. The signature is the first 16 hex characters of HMAC-SHA256 of `"<id>:<window>"` with the session's secret. The server accepts the current and previous window and compares with a timing-safe check.

**Student scan** (`POST /api/attendance/scan`) checks, in order:
- The token is well formed.
- The class exists, is open, has started and has not ended.
- The token signature is valid and not expired.
- The geofence passes: Haversine distance within `radius_m` (default 50 m, clamped 20 to 500).
- The student is enrolled in the course.

It then upserts PRESENT with method QR, clears any excuse fields, and emits a socket event to the professor's roster.

**The professor's attendance screen** (the Class QR tab) opens with two options:
- **Scan attendance:** shows the one QR code and an **Open scanner** button that opens the scan-students mode described in section 6. The class list is split into **Present** and **Not present yet**. If a student's phone or the app isn't working, the professor taps **Mark present** next to them and chooses a reason (Technical issue or Other); it is recorded and shown as "Present (manual: technical issue)". Below it, a live "Class list" shows the total in the class (with each student's roll number) split into **Present** (with the scan time) and **Not present yet** (with an **Absent** heading once the class has ended), plus **Excused** if any. Each not-present student has a **Mark present** button, so the professor can mark a student present by hand when their phone or the app failed. It asks for a reason (**Technical issue** or **Other**) and the roster shows "Present (manual: technical issue)".
- **Manual attendance:** lists every student with their roll number and **Present**, **Absent** and **Excused** buttons. Choosing Excused asks for a reason (Medical, Family emergency, College event / sports, Other). Totals show Total, Present, Absent and Excused.
- **Submit attendance** (on both) asks for confirmation, then ends the class and closes the QR code. Students not marked stay absent. Students marked by hand show as "Manual".

### 6. Optional second mode: one scanner for the whole class
The student opens **My QR**, a personal code that rotates every 15 seconds: `st<studentId>.<window>.<sig>`. Each student's signing key is derived from a master secret (`STUDENT_QR_SECRET`), so one student's code can't be altered into another's. The professor's tablet, under **Scan Students**, scans the codes continuously. Each scan shows a large "✅ Name marked present" message. A repeat scan says "already present", and a student from another class is rejected.

### 7. Live roster and manual override
- Live updates with socket.io. Each row shows how the student was marked (QR scan or Manual).
- The professor ticks or unticks a student; the UI updates at once and rolls back if the save fails.
- Sockets must not broadcast excuse notes, only the reason category. A socket must carry a valid sign-in token, and only professors and the HOD may listen to class and event rooms.

### 8. Excused absences (health and other valid reasons)
- The professor marks a student excused with a reason (Medical, Family emergency, College event / sports, Other) and an optional short note of at most 80 characters. The screen reminds them **not to write diagnoses**.
- Attendance % = present ÷ (classes held − excused). A class counts as held once it has started. Unmarked students count as absent. **Below 75% is flagged low.**
- A student scanning the QR or being ticked present clears the excuse.
- A Teacher **Analytics** tab lists everyone lowest first. A student's **My Attendance** tab shows their own number.

### 9. Leave requests
- The student picks from and to dates, a type and an optional reason of at most 200 characters, and is asked not to write medical details. A request covers at most 31 days.
- The professor approves or rejects. **Approving** (in one database transaction) excuses the student's existing classes in the date range with the request's type as the reason and `excuse_source = leave:<id>`. It never overwrites PRESENT or LATE. A decided request can't be decided again.
- State the limit: only classes that already exist are excused.

### 10. Exams and college events
**Exams:** the professor adds an exam (course, date, start time with the time selector, room) and deletes exams. A clashing room and time is refused. Students see only their own courses' exams.

**College events:**
- The professor creates an event (name, type, date, optional venue location).
- Each event has its own rotating QR with token prefix `ev<id>`. Students scan it from the Events tab, with the same geofence rule if the venue has a location.
- The professor can also tick attendees by hand, with live updates.
- **Going for the college (on-duty):** the professor ticks students representing the college, then taps **Apply on-duty**. This marks every class on the event's date as EXCUSED ("College event / sports", `excuse_source = event:<id>`) for those students. It never overwrites PRESENT or LATE, and is safe to run again.
- **Undo on-duty** puts back to ABSENT only records carrying that event's source, so hand edits are kept.
- Students see a "Representing the college" badge. The time zone for matching the event's date to classes comes from `APP_TIMEZONE` (default UTC).

### 11. Time selector (important UI rule)
Do **not** use the browser's native time input; it draws its own clock icon and grey box. Build a `TimeField` component from three plain selects: hour (1 to 12), minute (00 to 59) and AM/PM. It reads and writes 24-hour `"HH:MM"` and keeps partial choices internally. 12 AM is just after midnight and 12 PM is noon. Use it everywhere a time is entered: class From and To, edit time, exam start, and timetable periods.

### 12. Timetable and HOD view
**Timetable (set by the HOD):**
- Add a period: choose the course and day, then set **From** and **To** with the time selector, and enter the room.
- Every period has **Edit time** and **Delete**.
- Refuse a missing time or room, an end that isn't after the start, a period over 8 hours, an overlap in the same room on the same day, and an overlap for the same professor on the same day. Back-to-back periods are allowed.
- Professors see only their own courses' periods and students only theirs (read-only).
- On the professor's **Classes** tab, show today's timetable periods as buttons; tapping one fills in the course and From and To.

**HOD overview:** for each course, the average attendance %, the students below 75%, and the classes held in the last 24 hours. This is department-wide for now; there is no departments table yet.

### 13. Menu, offline games and theme
- A **☰ Menu** button lists the sections for the current role, lets the user switch view in the demo, and opens **Mind games** and **Feedback**.
- **Feedback** (from the menu): the user picks App problem, Suggestion or Other and writes a message of 5 to 500 characters. Each person can send **2 messages every 48 hours**; the screen shows how many are left and when the next one opens. The HOD reads all feedback in a Feedback tab.
- When the browser is offline, or a request to the server fails, show an amber banner with **Play a mind game**. The games need no internet: **Memory Match** (8 pairs, move counter), **Quick Math** (30 seconds, score and best) and **Sequence** (repeat a growing colour pattern).
- Light theme with Tailwind. A standalone demo page may also offer a Light / Dark / Auto switch.

**Feedback (in the menu):** a **Feedback** option opens a form with a category (App problem, Suggestion, Other) and a message of 5 to 500 characters. Each person can send **2 messages every 2 days**. The screen shows how many are left, or when they can send again, and lists their own recent feedback. The HOD has a **Feedback** tab listing everything sent. (The 2-per-2-days limit is enforced by the server.)

### 14. API summary
All requests except signing in send `Authorization: Bearer <token>`.
- Auth: `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/change-password`
- Classes: `GET/POST /api/sessions`, `PUT /api/sessions/:id/time`, `POST /api/sessions/:id/end`, `GET /api/sessions/:id/qr`, `GET /api/sessions/:id/roster`
- Attendance: `POST /api/attendance/scan`, `PUT /api/sessions/:id/attendance/:studentId` (optional `reason`), `PUT /api/sessions/:id/excuse/:studentId`
- One scanner: `GET /api/me/qr`, `POST /api/sessions/:id/scan-student`
- Reports: `GET /api/courses`, `GET /api/courses/:id/attendance-summary`, `GET /api/me/summary`, `GET /api/hod/overview`
- Leave: `GET/POST /api/leave-requests`, `PUT /api/leave-requests/:id/decision`
- Exams: `GET/POST /api/exams`, `DELETE /api/exams/:id`
- Events: `GET/POST /api/events`, `DELETE /api/events/:id`, `GET /api/events/:id/qr`, `POST /api/events/scan`, attendance and participants routes, `POST/DELETE /api/events/:id/on-duty`
- Timetable: `GET/POST /api/timetable`, `PUT/DELETE /api/timetable/:id`
- Feedback: `GET /api/feedback/mine`, `POST /api/feedback` (returns 429 after 2 in 48 hours), `GET /api/feedback` (HOD only)
- Wrap async routes so a database error returns a clean 500 instead of crashing the server.

### 15. Security and privacy requirements
- Parameterised SQL only; escape any user text shown on a page.
- Timing-safe token comparison; rotating tokens; geofence checked on the server, not the client.
- Medical information is sensitive: store only the reason category and a short note, never diagnoses, and make it visible only to the professor and the student themselves.
- Environment variables: `DATABASE_URL`, `WEB_ORIGIN`, `APP_TIMEZONE`, `STUDENT_QR_SECRET`, `SESSION_SECRET`, and for seeding `ROOM_LAT`, `ROOM_LNG`, `ROOM_RADIUS`. Never commit a real `.env`.

### 16. Known limits to state honestly
- Only test accounts exist (change them before real use); sign-ins cannot be cancelled early on the server; there is no screen yet for the HOD to create accounts or reset passwords.
- Approved leave and on-duty only excuse classes that already exist.
- There is no revoke for an approved leave yet, and no departments table.
- GPS can be spoofed, so the location check is a deterrent, not proof.

### 17. How to build it (one module at a time)
Ask the AI to build in this order, testing each step before the next:
1. Database schema and seed script.
2. `lib.js` helpers with unit tests (tokens, geofence, percentage, time rules).
3. Server routes for classes and the class QR, then student scan.
4. Web app shell with the role switcher, the time selector and the Classes screen.
5. Live roster with socket.io, then excused absences and analytics.
6. Leave requests, exams, then events with on-duty and undo.
7. The one-scanner mode.
8. Timetable and HOD overview.
9. Menu, offline banner and mind games.
10. Setup scripts for a GitHub Codespace (install PostgreSQL, create the database, write `.env`, install packages, seed, run both servers).

For every step, ask the AI to explain in plain language, to say what it could not test, and to list any limits.
