# MediCare – Hospital Appointment Management System

College major project: Node.js + Express + MySQL backend, HTML/CSS/JS (Bootstrap 5 + Chart.js) frontend,
three role-based dashboards (Patient, Doctor, Admin).

> **Build status:** complete - database, backend APIs and the full frontend (homepage, login/register with OTP,
> Patient, Doctor and Admin dashboards). Only syntax/import checks were run in the build sandbox (no MySQL there),
> so run the "Quick test" in section 6 once on your machine.
> Requires **MySQL 8.0+** (generated columns, `FOR UPDATE OF`). Keep the MySQL session timezone the same as the
> Node server's timezone (both IST for local use).

## 1. Architecture

```
 Browser (HTML/CSS/JS, Bootstrap 5, Chart.js)
        │  fetch() JSON  +  httpOnly JWT cookie
        ▼
 Express server  (backend/server.js)
   helmet (security headers + CSP) → rate limiting → express-validator
   middleware/auth.js  → authenticate (JWT + live DB check) → authorize(role)
   routes/*            → controllers/models → parameterized SQL (mysql2)
        │
        ▼
 MySQL (database/schema.sql)  users ─┬─ patients ─┐
                                     └─ doctors ──┼─ appointments ─ payments
                                                  └─ prescriptions / reviews ...
```

Key design decisions

| Concern | Approach |
|---|---|
| Double booking | `appointments.slot_lock` is a generated column (NULL when cancelled/rejected). A UNIQUE key on `(doctor_id, appointment_date, slot_time, slot_lock)` makes two live bookings of one slot **impossible at database level**, even with simultaneous requests. A cancelled slot becomes free again automatically. |
| Slots | Generated from the doctor's weekly schedule (`doctor_availability`), minus breaks, blocked dates, past times and booked slots (`backend/utils/slots.js`). |
| Passwords | bcrypt hashing (`bcryptjs`, cost 12 – same algorithm as `bcrypt`, no native build needed on Windows). |
| Sessions | JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). The user row is re-checked on every request so deactivated accounts lose access immediately. |
| Authorization | `authorize('patient'|'doctor'|'admin')` on every API route; dashboard HTML pages are also guarded server-side (`pageGuard`). |
| SQL injection | Only parameterized queries (`?` placeholders). |
| OTP | Hashed in DB, 10-minute expiry, 5 attempts, 30-second resend cooldown. `OTP_MODE=dev` prints the code in the server console; `OTP_MODE=twilio` sends real SMS. |
| Payments | `PAYMENT_MODE=test` simulated gateway clearly labelled TEST MODE; `razorpay` mode for Razorpay test keys (Razorpay Checkout is loaded only in that mode). |
| Secrets | Only in `.env` (never committed). Demo accounts are fictional and use `SEED_DEMO_PASSWORD` from `.env`. |

## 2. Folder structure

```
hospital-management-system/
├── backend/
│   ├── server.js            # entry point
│   ├── initDb.js            # loads schema + reference data (npm run db:init)
│   ├── seed.js              # fictional demo accounts (npm run db:seed)
│   ├── config/db.js         # MySQL pool
│   ├── middleware/          # auth.js, validate.js, error.js, upload.js
│   ├── models/              # doctorModel.js
│   ├── routes/              # auth, public, patient, doctor, admin, payments, notifications, files
│   ├── services/            # appointmentService (cancel/refund/expiry/reminders), scheduleService, scheduler
│   └── utils/               # slots, otp, mailer, notifier, logger, token, ids, httpError, receiptPdf
├── database/
│   ├── schema.sql           # 12 required tables + otp_codes, health_issues, doctor_blocked_dates, site_settings
│   └── sample-data.sql      # specializations, health-issue mapping, site settings
├── frontend/
│   ├── index.html, login.html, register.html
│   ├── patient-dashboard.html, doctor-dashboard.html, admin-dashboard.html
│   ├── css/style.css        # blue/white theme, dark mode variables
│   ├── js/                  # common.js (shared toolkit), home, login, register, patient, doctor, admin, theme-init
│   └── assets/              # logo, avatar, hero (SVG)
├── uploads/                 # photos/ and prescriptions/ (git-ignored)
├── .env.example
├── package.json
└── README.md
```

## 3. Setup

Requirements: Node.js 18+, MySQL 8.0+.

```bash
cd hospital-management-system
npm install
cp .env.example .env          # Windows: copy .env.example .env
```

Edit `.env`: set `DB_USER`, `DB_PASSWORD`, and a random `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Create the database and demo data (keep `DB_NAME=medicare_hms`, matching the SQL files):

```bash
npm run db:init     # runs schema.sql + sample-data.sql   (WARNING: drops existing tables)
npm run db:seed     # fictional admin / doctors / patients + sample appointments
npm start           # http://localhost:3000
```

Alternatively use the MySQL CLI: `mysql -u root -p < database/schema.sql` then
`mysql -u root -p medicare_hms < database/sample-data.sql`.

### Demo accounts (development only)

All use the password you set in `SEED_DEMO_PASSWORD`.

| Role | Login |
|---|---|
| Admin | `admin@medicare.example` |
| Doctor | `dr.anil@medicare.example` (also dr.priya, dr.rahul, dr.meera, dr.suresh, dr.kavya, dr.arvind, dr.fatima) |
| Patient | `ravi.teja@patient.example` |

## 4. Booking, payment and refund rules

1. Patient books a slot -> appointment is `pending` and the slot is **held for 15 minutes**.
2. Patient pays (`/api/payments/initiate` then `/confirm`). Unpaid holds are released automatically.
3. After payment the doctor sees the request and **accepts** (`confirmed`) or **rejects** (refund).
4. Doctor marks it `completed` (on/after the appointment date); the consultation is added to the patient's history.
5. Refunds: doctor / admin / system cancellations always refund. A patient cancelling **2+ hours** before the slot is refunded; later cancellations are not.
6. Paid requests the doctor never answers before the slot time are cancelled and refunded automatically.
7. Reminders (in-app + email) are sent 24 hours before confirmed appointments. All three jobs run every minute in `services/scheduler.js`.
8. Refunds are recorded in the database. In Razorpay mode, the actual money refund must still be issued from the Razorpay dashboard (not automated here).

## 5. API reference

### Auth, public (Part 1)

Auth – `/api/auth`

| Method | Path | Purpose |
|---|---|---|
| POST | `/register` | Patient sign-up (name, mobile, email, age, gender, password) → sends OTP |
| POST | `/verify-otp` | Verify mobile, logs the patient in |
| POST | `/resend-otp` | Resend registration OTP |
| POST | `/login` | `{identifier, password, role}` → sets cookie, returns dashboard redirect |
| POST | `/logout` | Clears cookie |
| GET | `/me` | Current user |
| POST | `/forgot-password` | Sends reset OTP (same response whether or not the account exists) |
| POST | `/reset-password` | `{identifier, code, newPassword}` |
| POST | `/change-password` | Logged-in users, all roles |

Public – `/api/public`

`GET /specializations`, `/health-issues`, `/doctors?q=&specialization=&limit=`, `/doctors/:id`,
`/doctors/:id/slots?date=YYYY-MM-DD`, `/recommend?issueId=`, `/testimonials`, `/settings`

The recommendation endpoint returns specialization-based guidance with a disclaimer; it never diagnoses.

### Patient (`/api/patient`, role patient)

`GET /dashboard`, `GET|PUT /profile`, `GET /appointments?status=upcoming|completed|cancelled|all`,
`POST /appointments` `{doctorId,date,time,reason}`, `PUT /appointments/:id/reschedule` `{date,time}`,
`POST /appointments/:id/cancel`, `POST /appointments/:id/review` `{rating,comment}`,
`GET /prescriptions`, `GET|POST /records`, `DELETE /records/:id` (own entries only)

### Payments (`/api/payments`)

`POST /initiate` `{appointmentId, method: upi|card|netbanking}`, `POST /confirm` `{appointmentId, simulate?: success|failure}`
(`simulate` works only when `PAYMENT_MODE=test`), `GET /receipt/:appointmentId` (PDF, patient owner or admin)

### Doctor (`/api/doctor`, role doctor)

`GET /dashboard`, `GET|PUT /profile`, `POST /photo` (multipart field `photo`), `GET|PUT /schedule`,
`GET|POST /blocked-dates`, `DELETE /blocked-dates/:id`, `GET /appointments?scope=today|upcoming|completed|cancelled|all`,
`GET /appointments/:id` (patient details + history), `POST /appointments/:id/accept|reject|cancel|complete`,
`PUT /appointments/:id/notes`, `POST /appointments/:id/prescription` (multipart, optional field `file`), `GET /reviews`

### Admin (`/api/admin`, role admin)

`GET /stats`; doctors: `GET|POST /doctors`, `PUT|DELETE /doctors/:id`, `POST /doctors/:id/photo|verify|status`,
`GET|PUT /doctors/:id/schedule`; `GET|POST /specializations`, `PUT /specializations/:id`, `GET|POST /health-issues`,
`DELETE /health-issues/:id`; `GET /patients`, `GET /patients/:id`, `POST /patients/:id/status`;
`GET /appointments?q&date&doctorId&status&page`, `POST /appointments/:id/cancel`;
`GET /payments?status&from&to&page`, `GET /payments/report` (CSV); `GET /reviews`, `PUT /reviews/:id/visibility`;
`GET|PUT /settings` (incl. default fee, `applyToAll`); `GET /logs`

### Shared

`GET /api/notifications`, `POST /api/notifications/read-all`, `POST /api/notifications/:id/read`,
`GET /api/files/prescription/:id` (private file, owner only), `POST /api/auth/change-password`

## 6. Quick test (after `npm start`)

```bash
curl http://localhost:3000/api/public/specializations
curl "http://localhost:3000/api/public/recommend?issueId=3"
curl "http://localhost:3000/api/public/doctors/1/slots?date=$(date -d 'tomorrow' +%F)"
```

Register a patient in dev mode: the OTP appears in the server console (and in the `devOtp` field of the response).

## 7. Frontend overview

| Page | What it does |
|---|---|
| `index.html` | Public homepage: hero, live specializations / doctors / testimonials, emergency contact, find-a-doctor links. |
| `register.html`, `login.html` | Patient registration with mobile OTP, role-tab login, forgot-password via OTP. |
| `patient-dashboard.html` | Doctor search + health-concern guidance, booking with slot picker and payment, appointments (pay, reschedule, cancel, review, PDF receipt), prescriptions and medical history, profile, notifications. |
| `doctor-dashboard.html` | Stats and chart, today / upcoming / history, accept / reject / complete with notes and prescription upload, weekly schedule and blocked dates, profile and photo, reviews. |
| `admin-dashboard.html` | Analytics charts, doctor / patient / appointment / payment management, CSV payment report, specializations and health-concern mapping, review moderation, settings (fee, hospital info, password), activity logs. |

Bootstrap, Bootstrap Icons, Chart.js and Google Fonts load from CDNs (internet needed; no SRI hashes are set).
Dark / light mode is the moon/sun button in every top bar. Test payments show a visible **TEST MODE** banner.

## 8. Production notes

Set `NODE_ENV=production` (hides dev OTPs, enables Secure cookies, blocks seeding and `db:init`), use real OTP/SMTP providers, serve behind HTTPS, and use a database user with only the privileges the app needs.
