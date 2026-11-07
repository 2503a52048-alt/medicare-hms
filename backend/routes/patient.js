// Patient APIs: dashboard, profile, booking, reschedule, cancel, history, records, reviews.
const express = require('express');
const { body, param, query } = require('express-validator');

const pool = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { wrap, httpError } = require('../utils/httpError');
const { getDoctor } = require('../models/doctorModel');
const { getAvailableSlots, isValidISODate, todayISO } = require('../utils/slots');
const ids = require('../utils/ids');
const { logActivity } = require('../utils/logger');
const { notifyUser } = require('../utils/notifier');
const svc = require('../services/appointmentService');

const router = express.Router();
router.use(authenticate, authorize('patient'));
router.use((req, res, next) => (req.user.patientId ? next() : res.status(403).json({ message: 'Patient profile not found.' })));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const dateRule = (field) =>
  body(field).custom((v) => isValidISODate(v)).withMessage('Choose a valid date (YYYY-MM-DD).');
const idParam = param('id').isInt({ min: 1 }).toInt();
const n = (v) => Number(v || 0);

// ---------------------------------------------------------------- DASHBOARD
router.get('/dashboard', wrap(async (req, res) => {
  const pid = req.user.patientId;
  const today = todayISO();
  const [[c]] = await pool.execute(
    `SELECT SUM(a.status IN ('pending','confirmed') AND ${svc.HAS_PAID}) AS upcoming,
            SUM(a.status = 'pending' AND NOT ${svc.HAS_PAID}) AS awaiting_payment,
            SUM(a.status = 'completed') AS completed,
            SUM(a.status IN ('cancelled','rejected')) AS cancelled
       FROM appointments a WHERE a.patient_id = ?`,
    [pid]
  );
  const [next] = await pool.execute(
    `SELECT a.id, a.appointment_code, a.appointment_date, a.slot_time, a.status, d.full_name AS doctor_name, s.name AS specialization
       FROM appointments a JOIN doctors d ON d.id = a.doctor_id JOIN specializations s ON s.id = d.specialization_id
      WHERE a.patient_id = ? AND a.status IN ('pending','confirmed') AND a.appointment_date >= ? AND ${svc.HAS_PAID}
      ORDER BY a.appointment_date, a.slot_time LIMIT 1`,
    [pid, today]
  );
  const [[{ unread }]] = await pool.execute(
    'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0',
    [req.user.id]
  );
  const [[p]] = await pool.execute('SELECT full_name FROM patients WHERE id = ?', [pid]);
  res.json({
    welcome: `Welcome back, ${p.full_name}`,
    counts: { upcoming: n(c.upcoming), awaitingPayment: n(c.awaiting_payment), completed: n(c.completed), cancelled: n(c.cancelled) },
    nextAppointment: next[0] || null,
    unreadNotifications: unread,
  });
}));

// ------------------------------------------------------------------ PROFILE
router.get('/profile', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT p.full_name, p.age, p.gender, p.blood_group, p.address, u.email, u.mobile, u.created_at
       FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    [req.user.patientId]
  );
  res.json(rows[0]);
}));

router.put(
  '/profile',
  [
    body('fullName').trim().isLength({ min: 2, max: 120 }).matches(/^[A-Za-z][A-Za-z .'-]*$/).withMessage('Enter a valid name.'),
    body('age').isInt({ min: 1, max: 120 }).withMessage('Age must be between 1 and 120.').toInt(),
    body('gender').isIn(['male', 'female', 'other']).withMessage('Select a gender.'),
    body('bloodGroup').optional({ values: 'falsy' }).isIn(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).withMessage('Invalid blood group.'),
    body('address').optional({ values: 'falsy' }).trim().isLength({ max: 255 }).withMessage('Address is too long.'),
  ],
  validate,
  wrap(async (req, res) => {
    const { fullName, age, gender, bloodGroup, address } = req.body;
    await pool.execute(
      'UPDATE patients SET full_name = ?, age = ?, gender = ?, blood_group = ?, address = ? WHERE id = ?',
      [fullName, age, gender, bloodGroup || null, address || null, req.user.patientId]
    );
    await logActivity(req.user.id, 'PROFILE_UPDATED', null, req.ip);
    res.json({ message: 'Profile updated.' });
  })
);

// ------------------------------------------------------------- APPOINTMENTS
// ?status=upcoming | completed | cancelled | all
router.get(
  '/appointments',
  [query('status').optional().isIn(['upcoming', 'completed', 'cancelled', 'all'])],
  validate,
  wrap(async (req, res) => {
    await svc.expireUnpaid();
    const status = req.query.status || 'all';
    const filter = {
      upcoming: "AND a.status IN ('pending','confirmed')",
      completed: "AND a.status = 'completed'",
      cancelled: "AND a.status IN ('cancelled','rejected')",
      all: '',
    }[status];
    const [rows] = await pool.execute(
      `SELECT a.id, a.appointment_code, a.appointment_date, a.slot_time, a.reason, a.status,
              a.cancelled_by, a.cancel_reason, a.created_at,
              d.id AS doctor_id, d.full_name AS doctor_name, d.photo, d.consultation_fee AS fee, s.name AS specialization,
              (a.status = 'pending' AND NOT ${svc.HAS_PAID}) AS awaiting_payment,
              (SELECT p.status FROM payments p WHERE p.appointment_id = a.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
              (SELECT p.amount FROM payments p WHERE p.appointment_id = a.id ORDER BY p.id DESC LIMIT 1) AS amount,
              EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id) AS reviewed,
              EXISTS (SELECT 1 FROM prescriptions rx WHERE rx.appointment_id = a.id) AS has_prescription
         FROM appointments a
         JOIN doctors d ON d.id = a.doctor_id
         JOIN specializations s ON s.id = d.specialization_id
        WHERE a.patient_id = ? ${filter}
        ORDER BY a.appointment_date ${status === 'upcoming' ? 'ASC' : 'DESC'}, a.slot_time ${status === 'upcoming' ? 'ASC' : 'DESC'}
        LIMIT 200`,
      [req.user.patientId]
    );
    res.json(rows.map((r) => ({ ...r, awaiting_payment: !!r.awaiting_payment, reviewed: !!r.reviewed, has_prescription: !!r.has_prescription })));
  })
);

// Book an appointment. The slot is held for HOLD_MINUTES until the payment succeeds.
router.post(
  '/appointments',
  [
    body('doctorId').isInt({ min: 1 }).withMessage('Select a doctor.').toInt(),
    dateRule('date'),
    body('time').matches(TIME).withMessage('Select a time slot.'),
    body('reason').trim().isLength({ min: 5, max: 500 }).withMessage('Describe the reason for consultation (5-500 characters).'),
  ],
  validate,
  wrap(async (req, res) => {
    const { doctorId, date, time, reason } = req.body;
    const pid = req.user.patientId;
    await svc.expireUnpaid();

    const doctor = await getDoctor(doctorId);
    if (!doctor) throw httpError(404, 'Doctor not found or not available for booking.');

    const [[{ holds }]] = await pool.execute(
      `SELECT COUNT(*) AS holds FROM appointments a WHERE a.patient_id = ? AND a.status = 'pending' AND NOT ${svc.HAS_PAID}`,
      [pid]
    );
    if (holds >= 3) throw httpError(409, 'You have unpaid appointments waiting. Complete or cancel them before booking another.');

    const day = await getAvailableSlots(doctor.id, date);
    const slot = day.slots.find((s) => s.time === time);
    if (!slot || !slot.available) {
      throw httpError(409, day.reason || 'This slot is no longer available. Please choose another.');
    }

    const [clash] = await pool.execute(
      `SELECT id FROM appointments WHERE patient_id = ? AND appointment_date = ? AND slot_time = ? AND status IN ('pending','confirmed')`,
      [pid, date, `${time}:00`]
    );
    if (clash.length) throw httpError(409, 'You already have an appointment at this date and time.');

    let insertId = null;
    let code = null;
    for (let attempt = 0; attempt < 3 && !insertId; attempt++) {
      code = ids.appointmentCode();
      try {
        const [r] = await pool.execute(
          `INSERT INTO appointments (appointment_code, patient_id, doctor_id, appointment_date, slot_time, reason)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [code, pid, doctor.id, date, `${time}:00`, reason]
        );
        insertId = r.insertId;
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        // The UNIQUE key is the real guard against double booking, even with simultaneous requests.
        if (/uq_appt_slot/.test(err.message)) throw httpError(409, 'Sorry, this slot was just booked by someone else. Please choose another.');
      }
    }
    if (!insertId) throw httpError(500, 'Could not create the appointment. Please try again.');

    await logActivity(req.user.id, 'APPOINTMENT_BOOKED', `${code} with ${doctor.full_name}`, req.ip);
    res.status(201).json({
      message: `Slot reserved for ${svc.HOLD_MINUTES} minutes. Complete the payment to confirm your request.`,
      appointmentId: insertId,
      appointmentCode: code,
      amount: Number(doctor.consultation_fee),
      holdMinutes: svc.HOLD_MINUTES,
    });
  })
);

router.put(
  '/appointments/:id/reschedule',
  [idParam, dateRule('date'), body('time').matches(TIME).withMessage('Select a time slot.')],
  validate,
  wrap(async (req, res) => {
    const { date, time } = req.body;
    const [rows] = await pool.execute(
      `SELECT a.*, ${svc.HAS_PAID} AS paid FROM appointments a WHERE a.id = ? AND a.patient_id = ?`,
      [req.params.id, req.user.patientId]
    );
    const a = rows[0];
    if (!a) throw httpError(404, 'Appointment not found.');
    if (!['pending', 'confirmed'].includes(a.status) || !a.paid) {
      throw httpError(409, 'Only paid, active appointments can be rescheduled.');
    }
    if ((svc.slotStart(a) - new Date()) / 36e5 < svc.REFUND_CUTOFF_HOURS) {
      throw httpError(400, `Appointments cannot be rescheduled within ${svc.REFUND_CUTOFF_HOURS} hours of the start time.`);
    }
    if (a.appointment_date === date && a.slot_time.slice(0, 5) === time) {
      throw httpError(400, 'Choose a different date or time.');
    }

    const day = await getAvailableSlots(a.doctor_id, date);
    const slot = day.slots.find((s) => s.time === time);
    if (!slot || !slot.available) throw httpError(409, day.reason || 'That slot is not available.');

    const before = svc.whenText(a);
    try {
      await pool.execute(
        "UPDATE appointments SET appointment_date = ?, slot_time = ?, reminder_sent = 0 WHERE id = ? AND status IN ('pending','confirmed')",
        [date, `${time}:00`, a.id]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'Sorry, that slot was just taken. Please choose another.');
      throw err;
    }

    const [info] = await pool.execute(
      'SELECT d.user_id AS doctor_user_id, d.full_name AS doctor_name FROM doctors d WHERE d.id = ?',
      [a.doctor_id]
    );
    const after = svc.whenText({ appointment_date: date, slot_time: `${time}:00` });
    await notifyUser(req.user.id, 'Appointment rescheduled', `Your appointment ${a.appointment_code} with ${info[0].doctor_name} moved from ${before} to ${after}.`, 'appointment');
    await notifyUser(info[0].doctor_user_id, 'Appointment rescheduled', `Appointment ${a.appointment_code} was moved from ${before} to ${after}.`, 'appointment');
    await logActivity(req.user.id, 'APPOINTMENT_RESCHEDULED', a.appointment_code, req.ip);
    res.json({ message: `Appointment rescheduled to ${after}.` });
  })
);

router.post(
  '/appointments/:id/cancel',
  [idParam, body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 200 })],
  validate,
  wrap(async (req, res) => {
    const [own] = await pool.execute('SELECT id FROM appointments WHERE id = ? AND patient_id = ?', [req.params.id, req.user.patientId]);
    if (!own.length) throw httpError(404, 'Appointment not found.');
    const r = await svc.cancelAppointment(req.params.id, {
      by: 'patient',
      reason: req.body.reason || 'Cancelled by patient',
      actorUserId: req.user.id,
      ip: req.ip,
    });
    res.json({ message: `Appointment cancelled.${r.refundText ? ' ' + r.refundText : ''}`, refunded: r.refunded });
  })
);

router.post(
  '/appointments/:id/review',
  [
    idParam,
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1 to 5.').toInt(),
    body('comment').optional({ values: 'falsy' }).trim().isLength({ max: 500 }).withMessage('Comment is too long (max 500).'),
  ],
  validate,
  wrap(async (req, res) => {
    const [rows] = await pool.execute(
      "SELECT id, doctor_id FROM appointments WHERE id = ? AND patient_id = ? AND status = 'completed'",
      [req.params.id, req.user.patientId]
    );
    if (!rows.length) throw httpError(400, 'You can review only your completed appointments.');
    try {
      await pool.execute(
        'INSERT INTO reviews (appointment_id, patient_id, doctor_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
        [rows[0].id, req.user.patientId, rows[0].doctor_id, req.body.rating, req.body.comment || null]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'You have already reviewed this appointment.');
      throw err;
    }
    res.status(201).json({ message: 'Thank you for your feedback.' });
  })
);

// ------------------------------------------------- PRESCRIPTIONS & HISTORY
router.get('/prescriptions', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT rx.id, rx.diagnosis, rx.medicines, rx.instructions, (rx.file_path IS NOT NULL) AS has_file, rx.created_at,
            a.appointment_code, a.appointment_date, d.full_name AS doctor_name, s.name AS specialization
       FROM prescriptions rx
       JOIN appointments a ON a.id = rx.appointment_id
       JOIN doctors d ON d.id = rx.doctor_id
       JOIN specializations s ON s.id = d.specialization_id
      WHERE rx.patient_id = ? ORDER BY rx.created_at DESC`,
    [req.user.patientId]
  );
  res.json(rows.map((r) => ({ ...r, has_file: !!r.has_file })));
}));

router.get('/records', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT m.id, m.record_type, m.title, m.details, m.record_date, m.doctor_id, d.full_name AS doctor_name,
            (m.doctor_id IS NULL) AS added_by_me
       FROM medical_records m LEFT JOIN doctors d ON d.id = m.doctor_id
      WHERE m.patient_id = ? ORDER BY m.record_date DESC, m.id DESC`,
    [req.user.patientId]
  );
  res.json(rows.map((r) => ({ ...r, added_by_me: !!r.added_by_me })));
}));

router.post(
  '/records',
  [
    body('recordType').isIn(['allergy', 'condition', 'surgery', 'vaccination', 'lab_report', 'note']).withMessage('Select a record type.'),
    body('title').trim().isLength({ min: 2, max: 150 }).withMessage('Title must be 2-150 characters.'),
    body('details').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }),
    body('recordDate').custom((v) => isValidISODate(v) && v <= todayISO()).withMessage('Date cannot be in the future.'),
  ],
  validate,
  wrap(async (req, res) => {
    const { recordType, title, details, recordDate } = req.body;
    await pool.execute(
      'INSERT INTO medical_records (patient_id, doctor_id, record_type, title, details, record_date) VALUES (?, NULL, ?, ?, ?, ?)',
      [req.user.patientId, recordType, title, details || null, recordDate]
    );
    res.status(201).json({ message: 'Record added to your medical history.' });
  })
);

// Patients may delete only entries they added themselves, never a doctor's records.
router.delete('/records/:id', [idParam], validate, wrap(async (req, res) => {
  const [r] = await pool.execute(
    'DELETE FROM medical_records WHERE id = ? AND patient_id = ? AND doctor_id IS NULL',
    [req.params.id, req.user.patientId]
  );
  if (!r.affectedRows) throw httpError(404, 'Record not found or cannot be deleted.');
  res.json({ message: 'Record deleted.' });
}));

module.exports = router;
