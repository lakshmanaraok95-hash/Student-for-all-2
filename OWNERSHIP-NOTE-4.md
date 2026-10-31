# Project ownership and handover note

This note records who owns the College Attendance System project and what is being handed over. It is a plain agreement between friends, not legal advice. If the project was made for a college or as coursework, check the college's rules first.

## The project

- **Name:** College Attendance System
- **What it is:** a web app where a professor shows one rotating QR code, students scan it to mark attendance, with a live roster, excused absences, leave requests, exams, events, a timetable and a head-of-department view.
- **Repository address (GitHub):** ______________________________________________

## The people

| | Name | GitHub username |
| --- | --- | --- |
| Previous owner (handing over) | ______________________ | ______________________ |
| New owner (receiving) | ______________________ | ______________________ |

- **Date of handover:** ____ / ____ / ________

## What is handed over

- [ ] The GitHub repository, including all files and its history (done with GitHub's **Transfer ownership**)
- [ ] The `sldlovespav9676` folder / zip (the full copy: project, prompt, demo, design files, guides)
- [ ] The project prompt (`prompt/project-prompt.md`)
- [ ] The clickable demo file (`demo/attendance-demo.html`)
- [ ] The design source files (`design/`)

## What is NOT handed over automatically

- **Codespaces** belong to the account that created them. The new owner makes their own.
- **The two shared links** (demo and design canvas) belong to the Claude account that made them. The new owner uses the portable files above instead.
- **Secrets.** The new owner creates their own `backend/.env` and `STUDENT_QR_SECRET`. The previous owner stops using the old ones and does not pass them on.

## Rights and reuse (tick one)

- [ ] **All rights go to the new owner.** The previous owner keeps no right to reuse or publish the code.
- [ ] **The new owner owns it, and the previous owner may keep a copy for portfolio or study use only.**
- [ ] **Shared ownership.** Both may use and change it. Neither will sell it or publish it without the other's agreement.

No open-source licence has been chosen. If the new owner wants others to reuse the code, they should add a licence file (for example MIT) after the handover.

## Credit

- The previous owner built this project using **Claude**, an AI assistant made by Anthropic, for the code, designs and documents.
- Other people who helped, and how: ______________________________________________
- If the college asks for AI help to be declared, the new owner will say so.

## Data and safety

- The project contains **test data only**. No real student, attendance or health information is included.
- The login is a **development stub**. Real accounts must be added before it is used with real students.
- Real student information, especially health-related reasons, must be kept private and handled under the college's rules.

## Handover checklist (in this order)

1. [ ] Previous owner keeps a backup copy of `sldlovespav9676.zip`.
2. [ ] The new owner has their own GitHub account (free).
3. [ ] Previous owner: repository **Settings, then Danger Zone, then Transfer ownership**, and enters the new owner's GitHub username.
4. [ ] New owner accepts the transfer from the email GitHub sends.
5. [ ] New owner opens the repository and creates their **own** Codespace.
6. [ ] New owner creates their own `backend/.env` and `STUDENT_QR_SECRET` (see `guides/SETUP-GUIDE.md`).
7. [ ] Previous owner signs out of GitHub on any shared device and removes any saved passwords.
8. [ ] Both sign below.

## Signatures

Previous owner: ______________________  Date: ______________

New owner: ______________________  Date: ______________
