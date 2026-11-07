// Doctor APIs. A doctor can only ever see and change their own data (req.user.doctorId).
// Doctors only see appointments that have been paid for.
const express = require('express');
const { body, param, query } = require('express-validator');

const pool = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPhoto, uploadPrescription, removeUpload } = require('../middleware/upload');
const { wrap, httpError } = require('../utils/httpError');
const { getWeeklySchedule } = require('../models/doctorModel');
const { validateSchedule, saveSchedule } = require('../services/scheduleService');
const { isValidISODate, todayISO, addDays } = require('../utils/slots');
const { logActivity } = require('../utils/logger');
const { notifyUser } = require('../utils/notifier');
const svc = require('../services/appointmentService');

const router = express.Router();
router.use(authenticate, authorize('doctor'));
router.use((req, res, next) => (req.user.doctorId ? next() : res.status(403).json({ message: 'Doctor profile not found.' })));

const idParam = param('id').isInt({ min: 1 }).toInt();
const n = (v) => Number(v || 0);

/** Loads an appointment only if it belongs to this doctor and was paid for. */
async function ownAppointment(id, doctorId) {
  const [rows] = await pool.execute(
    `SELECT a.*, p.user_id AS patient_user_id, p.full_name AS patient_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.id = ? AND a.doctor_id = ? AND ${svc.HAS_PAID}`,
    [id, doctorId]
  );
  if (!rows[0]) throw httpError(404, 'Appointment not found.');
  return rows[0];
}

// ---------------------------------------------------------------- DASHBOARD
router.get('/dashboard', wrap(async (req, res) => {
  const did = req.user.doctorId;
  const today = todayISO();
  const [[c]] = await pool.execute(
    `SELECT SUM(a.appointment_date = ? AND a.status IN ('pending','confirmed','completed')) AS today_total,
            SUM(a.appointment_date >= ? AND a.status IN ('pending','confirmed')) AS upcoming,
            SUM(a.status = 'pending') AS pending_requests,
            SUM(a.status = 'completed') AS completed,
            SUM(a.status IN ('cancelled','rejected')) AS cancelled
       FROM appointments a WHERE a.doctor_id = ? AND ${svc.HAS_PAID}`,
    [today, today, did]
  );
  const from = addDays(today, -6);
  const to = addDays(today, 7);
  const [days] = await pool.execute(
    `SELECT a.appointment_date AS d, COUNT(*) AS total
       FROM appointments a
      WHERE a.doctor_id = ? AND a.appointment_date BETWEEN ? AND ?
        AND a.status IN ('pending','confirmed','completed') AND ${svc.HAS_PAID}
      GROUP BY a.appointment_date`,
    [did, from, to]
  );
  const map = Object.fromEntries(days.map((r) => [r.d, r.total]));
  const daily = [];
  for (let i = -6; i <= 7; i++) {
    const d = addDays(today, i);
    daily.push({ date: d, total: map[d] || 0 });
  }
  const [[rating]] = await pool.execute(
    'SELECT ROUND(AVG(rating), 1) AS avg_rating, COUNT(*) AS reviews FROM reviews WHERE doctor_id = ? AND is_visible = 1',
    [did]
  );
  res.json({
    counts: { today: n(c.today_total), upcoming: n(c.upcoming), pendingRequests: n(c.pending_requests), completed: n(c.completed), cancelled: n(c.cancelled) },
    daily,
    rating: { average: rating.avg_rating ? Number(rating.avg_rating) : null, reviews: rating.reviews },
  });
}));

// ------------------------------------------------------------------ PROFILE
router.get('/profile', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT d.full_name, d.qualifications, d.experience_years, d.license_number, d.phone, d.consultation_fee,
            d.photo, d.bio, d.is_verified, s.name AS specialization, u.email
       FROM doctors d JOIN users u ON u.id = d.user_id JOIN specializations s ON s.id = d.specialization_id
      WHERE d.id = ?`,
    [req.user.doctorId]
  );
  res.json({ ...rows[0], schedule: await getWeeklySchedule(req.user.doctorId) });
}));

router.put(
  '/profile',
  [
    body('fullName').trim().isLength({ min: 2, max: 120 }).withMessage('Enter your full name.'),
    body('qualifications').trim().isLength({ min: 2, max: 255 }).withMessage('Enter your qualifications.'),
    body('experienceYears').isInt({ min: 0, max: 70 }).withMessage('Experience must be 0-70 years.').toInt(),
    body('phone').trim().matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit mobile number.'),
    body('bio').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }).withMessage('Bio is too long (max 1000).'),
  ],
  validate,
  wrap(async (req, res) => {
    const { fullName, qualifications, experienceYears, phone, bio } = req.body;
    await pool.execute(
      'UPDATE doctors SET full_name = ?, qualifications = ?, experience_years = ?, phone = ?, bio = ? WHERE id = ?',
      [fullName, qualifications, experienceYears, phone, bio || null, req.user.doctorId]
    );
    await logActivity(req.user.id, 'DOCTOR_PROFILE_UPDATED', null, req.ip);
    res.json({ message: 'Profile updated.' });
  })
);

router.post('/photo', uploadPhoto, wrap(async (req, res) => {
  if (!req.file) throw httpError(400, 'Choose a JPG or PNG image (max 2 MB).');
  const [old] = await pool.execute('SELECT photo FROM doctors WHERE id = ?', [req.user.doctorId]);
  const url = `/uploads/photos/${req.file.filename}`;
  await pool.execute('UPDATE doctors SET photo = ? WHERE id = ?', [url, req.user.doctorId]);
  removeUpload(old[0] && old[0].photo);
  res.json({ message: 'Photo updated.', photo: url });
}));

// ----------------------------------------------- SCHEDULE & BLOCKED DATES
router.get('/schedule', wrap(async (req, res) => {
  res.json(await getWeeklySchedule(req.user.doctorId));
}));

router.put('/schedule', wrap(async (req, res) => {
  const days = (req.body.days || []).map((d) => ({
    day_of_week: Number(d.day_of_week),
    is_working: !!d.is_working,
    start_time: d.start_time,
    end_time: d.end_time,
    break_start: d.break_start || null,
    break_end: d.break_end || null,
    slot_minutes: Number(d.slot_minutes),
  }));
  const error = validateSchedule(days);
  if (error) throw httpError(400, error);
  await saveSchedule(req.user.doctorId, days);
  await logActivity(req.user.id, 'SCHEDULE_UPDATED', null, req.ip);
  res.json({ message: 'Schedule saved. New slots are available to patients immediately; existing appointments are unchanged.' });
}));

router.get('/blocked-dates', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT id, blocked_date, reason FROM doctor_blocked_dates WHERE doctor_id = ? AND blocked_date >= ? ORDER BY blocked_date',
    [req.user.doctorId, todayISO()]
  );
  res.json(rows);
}));

router.post(
  '/blocked-dates',
  [
    body('date').custom((v) => isValidISODate(v) && v >= todayISO()).withMessage('Choose today or a future date.'),
    body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 150 }),
  ],
  validate,
  wrap(async (req, res) => {
    const { date, reason } = req.body;
    const [[{ live }]] = await pool.execute(
      "SELECT COUNT(*) AS live FROM appointments WHERE doctor_id = ? AND appointment_date = ? AND status IN ('pending','confirmed')",
      [req.user.doctorId, date]
    );
    if (live > 0) {
      throw httpError(409, `You have ${live} active appointment(s) on ${date}. Cancel or reschedule them before blocking the date.`);
    }
    try {
      await pool.execute('INSERT INTO doctor_blocked_dates (doctor_id, blocked_date, reason) VALUES (?, ?, ?)', [req.user.doctorId, date, reason || null]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'This date is already blocked.');
      throw err;
    }
    res.status(201).json({ message: `${date} is now blocked.` });
  })
);

router.delete('/blocked-dates/:id', [idParam], validate, wrap(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM doctor_blocked_dates WHERE id = ? AND doctor_id = ?', [req.params.id, req.user.doctorId]);
  if (!r.affectedRows) throw httpError(404, 'Blocked date not found.');
  res.json({ message: 'Date unblocked.' });
}));

// ------------------------------------------------------------- APPOINTMENTS
// ?scope=today | upcoming | completed | cancelled | all   (&date=YYYY-MM-DD to see one day)
router.get(
  '/appointments',
  [
    query('scope').optional().isIn(['today', 'upcoming', 'completed', 'cancelled', 'all']),
    query('date').optional({ values: 'falsy' }).custom((v) => isValidISODate(v)).withMessage('Invalid date.'),
  ],
  validate,
  wrap(async (req, res) => {
    const scope = req.query.scope || 'today';
    const today = todayISO();
    const params = [req.user.doctorId];
    let where = '';
    if (req.query.date) {
      where = 'AND a.appointment_date = ?';
      params.push(req.query.date);
    } else if (scope === 'today') {
      where = "AND a.appointment_date = ? AND a.status IN ('pending','confirmed','completed')";
      params.push(today);
    } else if (scope === 'upcoming') {
      where = "AND a.appointment_date >= ? AND a.status IN ('pending','confirmed')";
      params.push(today);
    } else if (scope === 'completed') {
      where = "AND a.status = 'completed'";
    } else if (scope === 'cancelled') {
      where = "AND a.status IN ('cancelled','rejected')";
    }
    const [rows] = await pool.execute(
      `SELECT a.id, a.appointment_code, a.appointment_date, a.slot_time, a.reason, a.status, a.cancel_reason,
              a.cancelled_by, a.consultation_notes,
              p.id AS patient_id, p.full_name AS patient_name, p.age, p.gender, p.blood_group,
              EXISTS (SELECT 1 FROM prescriptions rx WHERE rx.appointment_id = a.id) AS has_prescription
         FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.doctor_id = ? AND ${svc.HAS_PAID} ${where}
        ORDER BY a.appointment_date ${scope === 'completed' || scope === 'cancelled' ? 'DESC' : 'ASC'}, a.slot_time
        LIMIT 200`,
      params
    );
    res.json(rows.map((r) => ({ ...r, has_prescription: !!r.has_prescription })));
  })
);

// One appointment with the patient information relevant to the consultation.
router.get('/appointments/:id', [idParam], validate, wrap(async (req, res) => {
  const a = await ownAppointment(req.params.id, req.user.doctorId);
  const [[patient]] = await pool.execute(
    'SELECT full_name, age, gender, blood_group FROM patients WHERE id = ?',
    [a.patient_id]
  );
  const [records] = await pool.execute(
    `SELECT record_type, title, details, record_date FROM medical_records
      WHERE patient_id = ? ORDER BY record_date DESC, id DESC LIMIT 20`,
    [a.patient_id]
  );
  const [previous] = await pool.execute(
    `SELECT rx.diagnosis, rx.medicines, rx.created_at, d.full_name AS doctor_name
       FROM prescriptions rx JOIN doctors d ON d.id = rx.doctor_id
      WHERE rx.patient_id = ? AND rx.appointment_id <> ? ORDER BY rx.created_at DESC LIMIT 10`,
    [a.patient_id, a.id]
  );
  const [rxRows] = await pool.execute(
    'SELECT id, diagnosis, medicines, instructions, (file_path IS NOT NULL) AS has_file FROM prescriptions WHERE appointment_id = ? LIMIT 1',
    [a.id]
  );
  const prescription = rxRows[0];
  res.json({
    appointment: {
      id: a.id, appointment_code: a.appointment_code, appointment_date: a.appointment_date, slot_time: a.slot_time,
      reason: a.reason, status: a.status, consultation_notes: a.consultation_notes,
    },
    patient,
    medicalHistory: records,
    previousPrescriptions: previous,
    prescription: prescription ? { ...prescription, has_file: !!prescription.has_file } : null,
  });
}));

router.post('/appointments/:id/accept', [idParam], validate, wrap(async (req, res) => {
  const a = await ownAppointment(req.params.id, req.user.doctorId);
  const [r] = await pool.execute("UPDATE appointments SET status = 'confirmed' WHERE id = ? AND status = 'pending'", [a.id]);
  if (!r.affectedRows) throw httpError(409, `This appointment is already ${a.status}.`);
  await notifyUser(a.patient_user_id, 'Appointment confirmed', `Your appointment ${a.appointment_code} on ${svc.whenText(a)} has been confirmed by the doctor.`, 'appointment');
  await logActivity(req.user.id, 'APPOINTMENT_ACCEPTED', a.appointment_code, req.ip);
  res.json({ message: 'Appointment confirmed.' });
}));

const reasonRule = body('reason').trim().isLength({ min: 3, max: 200 }).withMessage('Please give a reason (3-200 characters).');

router.post('/appointments/:id/reject', [idParam, reasonRule], validate, wrap(async (req, res) => {
  const a = await ownAppointment(req.params.id, req.user.doctorId);
  if (a.status !== 'pending') throw httpError(409, 'Only pending requests can be rejected. Use cancel for confirmed appointments.');
  await svc.cancelAppointment(a.id, { by: 'doctor', reason: req.body.reason, finalStatus: 'rejected', actorUserId: req.user.id, ip: req.ip });
  res.json({ message: 'Request rejected. The patient has been notified and refunded.' });
}));

router.post('/appointments/:id/cancel', [idParam, reasonRule], validate, wrap(async (req, res) => {
  const a = await ownAppointment(req.params.id, req.user.doctorId);
  await svc.cancelAppointment(a.id, { by: 'doctor', reason: req.body.reason, actorUserId: req.user.id, ip: req.ip });
  res.json({ message: 'Appointment cancelled. The patient has been notified and refunded.' });
}));

router.post(
  '/appointments/:id/complete',
  [idParam, body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }).withMessage('Notes are too long (max 2000).')],
  validate,
  wrap(async (req, res) => {
    const a = await ownAppointment(req.params.id, req.user.doctorId);
    if (a.status !== 'confirmed') throw httpError(409, 'Only confirmed appointments can be marked completed.');
    if (a.appointment_date > todayISO()) throw httpError(400, 'This appointment is in the future.');
    const notes = req.body.notes || a.consultation_notes || null;
    await pool.execute("UPDATE appointments SET status = 'completed', consultation_notes = ? WHERE id = ? AND status = 'confirmed'", [notes, a.id]);
    // The consultation becomes part of the patient's medical history.
    await pool.execute(
      "INSERT INTO medical_records (patient_id, doctor_id, record_type, title, details, record_date) VALUES (?, ?, 'note', ?, ?, ?)",
      [a.patient_id, req.user.doctorId, `Consultation ${a.appointment_code}`, notes, a.appointment_date]
    );
    await notifyUser(a.patient_user_id, 'Consultation completed', `Your consultation ${a.appointment_code} is complete. You can now view your prescription and rate your doctor.`, 'appointment');
    await logActivity(req.user.id, 'APPOINTMENT_COMPLETED', a.appointment_code, req.ip);
    res.json({ message: 'Appointment marked as completed.' });
  })
);

router.put(
  '/appointments/:id/notes',
  [idParam, body('notes').trim().isLength({ min: 1, max: 2000 }).withMessage('Enter notes (max 2000 characters).')],
  validate,
  wrap(async (req, res) => {
    const a = await ownAppointment(req.params.id, req.user.doctorId);
    if (!['confirmed', 'completed'].includes(a.status)) throw httpError(409, 'Notes can be added to confirmed or completed appointments.');
    await pool.execute('UPDATE appointments SET consultation_notes = ? WHERE id = ?', [req.body.notes, a.id]);
    res.json({ message: 'Consultation notes saved.' });
  })
);

// Digital prescription (text) with an optional scanned file (JPG, PNG, PDF up to 3 MB).
router.post(
  '/appointments/:id/prescription',
  uploadPrescription,
  [
    idParam,
    body('diagnosis').optional({ values: 'falsy' }).trim().isLength({ max: 255 }),
    body('medicines').trim().isLength({ min: 2, max: 3000 }).withMessage('List the prescribed medicines.'),
    body('instructions').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }),
  ],
  validate,
  wrap(async (req, res) => {
    const cleanup = () => req.file && removeUpload(`prescriptions/${req.file.filename}`);
    try {
      const a = await ownAppointment(req.params.id, req.user.doctorId);
      if (!['confirmed', 'completed'].includes(a.status)) throw httpError(409, 'Prescriptions can be added to confirmed or completed appointments.');

      const { diagnosis, medicines, instructions } = req.body;
      const [existing] = await pool.execute('SELECT id, file_path FROM prescriptions WHERE appointment_id = ?', [a.id]);
      const file = req.file ? req.file.filename : null;
      if (existing.length) {
        await pool.execute(
          'UPDATE prescriptions SET diagnosis = ?, medicines = ?, instructions = ?, file_path = COALESCE(?, file_path) WHERE id = ?',
          [diagnosis || null, medicines, instructions || null, file, existing[0].id]
        );
        if (file && existing[0].file_path) removeUpload(`prescriptions/${existing[0].file_path}`);
      } else {
        await pool.execute(
          `INSERT INTO prescriptions (appointment_id, doctor_id, patient_id, diagnosis, medicines, instructions, file_path)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [a.id, req.user.doctorId, a.patient_id, diagnosis || null, medicines, instructions || null, file]
        );
      }
      await notifyUser(a.patient_user_id, 'New prescription', `A prescription was added for appointment ${a.appointment_code}.`, 'appointment');
      await logActivity(req.user.id, 'PRESCRIPTION_SAVED', a.appointment_code, req.ip);
      res.status(existing.length ? 200 : 201).json({ message: 'Prescription saved.' });
    } catch (err) {
      cleanup();
      throw err;
    }
  })
);

router.get('/reviews', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT r.rating, r.comment, r.created_at, p.full_name AS patient_name
       FROM reviews r JOIN patients p ON p.id = r.patient_id
      WHERE r.doctor_id = ? AND r.is_visible = 1 ORDER BY r.created_at DESC LIMIT 50`,
    [req.user.doctorId]
  );
  res.json(rows);
}));

module.exports = router;
