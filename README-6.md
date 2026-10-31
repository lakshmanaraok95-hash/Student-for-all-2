# College Attendance System

![College Attendance System](docs/screens/overview.png)

**One rotating QR code for the whole class.** The professor starts a class with their own From and To times and shows a single QR code. Every student scans it on their own phone, and the server checks the code, the class time, enrollment and the student's distance from the classroom before marking them present. Includes a live roster, manual attendance, excused absences, leave requests, exams, college events with on-duty attendance, a weekly timetable, a head-of-department (HOD) view, in-app feedback and offline mind games.

> Built step by step with Claude, working from a tablet. Sign-in is real (roles, hashed passwords, 12-hour sign-ins), but only **test accounts** exist so far. Change them before using real student data (see [Known limits](#known-limits)).

## Features

**Signing in**
- A first screen asks **who you are** (Student, Professor, HOD or Others), then shows the sign-in page for that role. Others (staff and guests) see only the timetable and exam schedule.

**Taking attendance**
- **Start a class** with your own From and To times (type them with simple hour : minute AM/PM selectors). Tap a period from today's timetable to fill in the course and times.
- **Scan attendance:** one QR code that changes every 15 seconds, so screenshots are useless. Students must be near the classroom, enrolled, and scanning during the class time.
- **Present and Not present yet:** a live class list with roll numbers. A professor can mark a student present by hand when their phone or the app failed (recorded as a technical issue).
- **Manual attendance:** tap Present, Absent or Excused for every student.
- **Open scanner:** the professor's tablet can scan each student's personal QR code instead.
- **Submit attendance** ends the class and closes the QR code.

**Around attendance**
- **Excused absences** (medical or other reasons) are left out of the attendance percentage. Students below 75% are flagged.
- **Leave requests:** students ask, professors approve or reject. Approving excuses the classes in the date range.
- **Exams:** exam schedule with room double-booking prevented.
- **College events:** event QR codes, and **on-duty** attendance for students representing the college (with undo).
- **Timetable:** the HOD sets each period's day, room and From and To times. Room and professor clashes are refused.
- **HOD overview:** attendance per course, students below 75%, and recent classes.
- **Menu, Feedback and Mind games:** feedback (2 messages every 2 days per person) goes to the HOD. Three offline games appear when the connection drops.

## Screens

These images are **illustrations of the screens** drawn from the design, not screenshots of the running app. Replace them with real screenshots once you have the app running.

| Start a class | Class QR and class list | Manual attendance |
| :---: | :---: | :---: |
| <img src="docs/screens/start-class.png" width="240"> | <img src="docs/screens/class-qr.png" width="240"> | <img src="docs/screens/manual-attendance.png" width="240"> |

| Student scan | HOD timetable | HOD overview |
| :---: | :---: | :---: |
| <img src="docs/screens/student-scan.png" width="240"> | <img src="docs/screens/hod-timetable.png" width="240"> | <img src="docs/screens/hod-overview.png" width="240"> |

## Tech stack

- **Backend:** Node.js, Express, PostgreSQL, socket.io
- **Frontend:** React (Vite), Tailwind CSS, html5-qrcode, qrcode.react
- QR codes are HMAC-signed and rotate every 15 seconds; the distance check uses the Haversine formula on the server.

## Quick start (GitHub Codespaces)

The camera and GPS need HTTPS, so the easiest way to try the app is a Codespace, which gives you a secure link for each running server.

1. Open this repository in a Codespace (**Code → Codespaces → Create codespace**).
2. Get the latitude and longitude of the classroom (in Google Maps, press and hold the spot).
3. In the terminal, set everything up once. This installs PostgreSQL, creates the database, installs the packages and loads test data:
   ```bash
   bash setup-codespace.sh <ROOM_LAT> <ROOM_LNG>
   ```
4. Start both servers:
   ```bash
   bash run-codespace.sh
   ```
5. In the **Ports** tab, open the link for port **5173**. Choose your role, then sign in with a [test account](#accounts). To scan with a phone, set the port to Public (and back to Private afterwards).

`npm run seed` (in `backend/`) wipes the database and reloads the test data. Only use it on a test copy.

### Configuration

Copy `backend/.env.example` to `backend/.env` (the setup script does this for you):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `STUDENT_QR_SECRET` | Master key for students' personal QR codes (`openssl rand -hex 32`) |
| `SESSION_SECRET` | Signs everyone's sign-in (`openssl rand -hex 32`). Without it everyone is signed out whenever the server restarts |
| `ALLOW_DEV_LOGIN` | Leave unset. `1` turns on an insecure header login for testing only |
| `APP_TIMEZONE` | Your time zone, e.g. `Asia/Kolkata`, used to match event dates to classes |
| `ROOM_LAT`, `ROOM_LNG`, `ROOM_RADIUS` | Test classroom location for `npm run seed` |

Never commit a real `.env` file; it is already in `.gitignore`.

### Accounts

The first screen asks **who you are** (Student, Professor, HOD or Others). The next screen is the sign-in page for that role. The role you chose must match your account.

`npm run seed` creates these **test accounts** (for testing only; change them before real use):

| Role | ID | Password |
| --- | --- | --- |
| Student | `CS202601` to `CS202605` | `Student@123` |
| Professor | `EMP001` | `Teach@123` |
| HOD | `HOD001` | `Hod@12345` |
| Others | `GUEST01` | `Guest@123` |

**Others** (staff and guests) can only see the timetable and exam schedule, and send feedback.

Passwords are stored only as salted hashes. A sign-in lasts 12 hours, and 5 wrong passwords in a row lock an account for 15 minutes. Everyone can change their own password from the menu. To add an account or reset a password, run this in `backend/` (the HOD has no screen for this yet):

```bash
NEW_PASSWORD='Something@123' node create-user.js add teacher EMP002 "Professor B" 2
NEW_PASSWORD='Something@123' node create-user.js reset student CS202601
```

## Project structure

```
backend/   Express API, database schema, seed script, tests (lib.js holds the pure logic)
web/       React app (Vite + Tailwind)
docs/      Screen illustrations
setup-codespace.sh   One-time setup inside a Codespace
run-codespace.sh     Starts PostgreSQL, the backend and the web app
```

## Tests

```bash
cd backend && npm test
```

The tests cover the pure logic: QR tokens, the distance check, attendance percentage, class and timetable time rules, the feedback limit, password hashing, sign-in tokens and the account lockout. The database queries and screens are not covered by automated tests yet.

## Known limits

- **Only test accounts exist**, with passwords written in this README. Change or remove them before real use.
- A sign-in cannot be cancelled from the server before it expires (12 hours); signing out only forgets it on that device.
- There is no screen yet for the HOD to create accounts or reset passwords (use `create-user.js`).
- **Do not put real student data in it yet.** Health-related reasons are sensitive; keep them to a category and a short note, never a diagnosis, and check your college's rules.
- GPS can be spoofed, so the location check is a deterrent, not proof.
- Approved leave and on-duty only excuse classes that already exist.
- There is no departments table yet: the HOD sees every course.

## License

No license has been chosen yet.
