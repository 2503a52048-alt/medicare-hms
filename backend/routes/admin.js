// Admin APIs: statistics, doctors, specializations, patients, appointments, payments, settings, logs.
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param, query } = require('express-validator');

const pool = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPhoto, removeUpload } = require('../middleware/upload');
const { wrap, httpError, parsePage } = require('../utils/httpError');
const { getWeeklySchedule } = require('../models/doctorModel');
const { validateSchedule, saveSchedule } = require('../services/scheduleService');
const { isValidISODate, todayISO, addDays } = require('../utils/slots');
const { logActivity } = require('../utils/logger');
const { notifyUser } = require('../utils/notifier');
const svc = require('../services/appointmentService');

const router = express.Router();
router.use(authenticate, authorize('admin'));

const idParam = param('id').isInt({ min: 1 }).toInt();
const n = (v) => Number(v || 0);
const optDate = (field) =>
  query(field).optional({ values: 'falsy' }).custom((v) => isValidISODate(v)).withMessage(`${field} must be YYYY-MM-DD.`);
const likeParam = (s) => `%${s}%`;

async function findDoctor(id) {
  const [rows] = await pool.execute('SELECT id, user_id, photo, full_name FROM doctors WHERE id = ?', [id]);
  if (!rows[0]) throw httpError(404, 'Doctor not found.');
  return rows[0];
}

// -------------------------------------------------------------------- STATS
router.get('/stats', wrap(async (req, res) => {
  const today = todayISO();
  const from = addDays(today, -13);

  const [[tot]] = await pool.execute(
    `SELECT (SELECT COUNT(*) FROM patients) AS patients,
            (SELECT COUNT(*) FROM doctors WHERE is_active = 1) AS doctors,
            (SELECT COUNT(*) FROM appointments a WHERE ${svc.HAS_PAID}) AS appointments,
            (SELECT COUNT(*) FROM appointments a WHERE a.appointment_date = ? AND a.status IN ('pending','confirmed','completed') AND ${svc.HAS_PAID}) AS today,
            (SELECT COUNT(*) FROM appointments a WHERE a.status = 'pending' AND ${svc.HAS_PAID}) AS pending,
            (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'success') AS revenue`,
    [today]
  );

  const [spec] = await pool.execute(
    `SELECT s.name, COUNT(a.id) AS total
       FROM specializations s
       JOIN doctors d ON d.specialization_id = s.id
       JOIN appointments a ON a.doctor_id = d.id AND ${svc.HAS_PAID}
      GROUP BY s.id, s.name ORDER BY total DESC LIMIT 6`
  );
  const [status] = await pool.execute(
    `SELECT a.status, COUNT(*) AS total FROM appointments a WHERE ${svc.HAS_PAID} GROUP BY a.status`
  );
  const [apptDays] = await pool.execute(
    `SELECT a.appointment_date AS d, COUNT(*) AS total FROM appointments a
      WHERE a.appointment_date BETWEEN ? AND ? AND a.status IN ('pending','confirmed','completed') AND ${svc.HAS_PAID}
      GROUP BY a.appointment_date`,
    [from, today]
  );
  const [revDays] = await pool.execute(
    `SELECT DATE(paid_at) AS d, SUM(amount) AS total FROM payments
      WHERE status = 'success' AND DATE(paid_at) BETWEEN ? AND ? GROUP BY DATE(paid_at)`,
    [from, today]
  );
  const am = Object.fromEntries(apptDays.map((r) => [r.d, r.total]));
  const rm = Object.fromEntries(revDays.map((r) => [r.d, Number(r.total)]));
  const trend = [];
  for (let i = -13; i <= 0; i++) {
    const d = addDays(today, i);
    trend.push({ date: d, appointments: am[d] || 0, revenue: rm[d] || 0 });
  }
  res.json({
    totals: {
      patients: n(tot.patients), doctors: n(tot.doctors), appointments: n(tot.appointments),
      today: n(tot.today), pending: n(tot.pending), revenue: Number(tot.revenue),
    },
    popularSpecializations: spec,
    statusBreakdown: status,
    trend,
  });
}));

// ------------------------------------------------------------------ DOCTORS
router.get(
  '/doctors',
  [query('q').optional().trim().isLength({ max: 80 }), query('status').optional({ values: 'falsy' }).isIn(['active', 'inactive', 'unverified'])],
  validate,
  wrap(async (req, res) => {
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.q) {
      where += ' AND (d.full_name LIKE ? OR u.email LIKE ? OR s.name LIKE ?)';
      params.push(likeParam(req.query.q), likeParam(req.query.q), likeParam(req.query.q));
    }
    if (req.query.status === 'active') where += ' AND d.is_active = 1';
    if (req.query.status === 'inactive') where += ' AND d.is_active = 0';
    if (req.query.status === 'unverified') where += ' AND d.is_verified = 0';
    const [rows] = await pool.execute(
      `SELECT d.id, d.full_name, d.qualifications, d.experience_years, d.license_number, d.phone,
              d.consultation_fee, d.photo, d.bio, d.is_verified, d.is_active, u.email,
              s.id AS specialization_id, s.name AS specialization,
              (SELECT COUNT(*) FROM appointments a WHERE a.doctor_id = d.id AND ${svc.HAS_PAID}) AS appointments
         FROM doctors d JOIN users u ON u.id = d.user_id JOIN specializations s ON s.id = d.specialization_id
         ${where} ORDER BY d.full_name LIMIT 200`,
      params
    );
    res.json(rows.map((r) => ({ ...r, is_verified: !!r.is_verified, is_active: !!r.is_active })));
  })
);

const strongPassword = body('password')
  .isLength({ min: 8, max: 72 }).withMessage('Password must be 8-72 characters.')
  .matches(/[a-z]/).withMessage('Password needs a lowercase letter.')
  .matches(/[A-Z]/).withMessage('Password needs an uppercase letter.')
  .matches(/\d/).withMessage('Password needs a number.');

const doctorFields = [
  body('fullName').trim().isLength({ min: 2, max: 120 }).withMessage('Enter the doctor\'s full name.'),
  body('specializationId').isInt({ min: 1 }).withMessage('Select a specialization.').toInt(),
  body('qualifications').trim().isLength({ min: 2, max: 255 }).withMessage('Enter qualifications.'),
  body('experienceYears').isInt({ min: 0, max: 70 }).withMessage('Experience must be 0-70 years.').toInt(),
  body('phone').trim().matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit mobile number.'),
  body('licenseNumber').optional({ values: 'falsy' }).trim().isLength({ max: 50 }),
  body('consultationFee').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100000 }).withMessage('Enter a valid fee.').toFloat(),
  body('bio').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
];

router.post(
  '/doctors',
  [
    ...doctorFields,
    body('email').trim().toLowerCase().isEmail().withMessage('Enter a valid email.'),
    strongPassword,
    body('verified').optional().isBoolean().toBoolean(),
  ],
  validate,
  wrap(async (req, res) => {
    const b = req.body;
    const [[fee]] = await pool.execute("SELECT setting_value FROM site_settings WHERE setting_key = 'default_fee'");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [spec] = await conn.execute('SELECT id FROM specializations WHERE id = ? AND is_active = 1', [b.specializationId]);
      if (!spec.length) throw httpError(400, 'Selected specialization does not exist.');

      const hash = await bcrypt.hash(b.password, 12);
      const [u] = await conn.execute(
        "INSERT INTO users (email, mobile, password_hash, role, mobile_verified) VALUES (?, ?, ?, 'doctor', 1)",
        [b.email, b.phone, hash]
      );
      const [d] = await conn.execute(
        `INSERT INTO doctors (user_id, specialization_id, full_name, qualifications, experience_years,
                              license_number, phone, consultation_fee, bio, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u.insertId, b.specializationId, b.fullName, b.qualifications, b.experienceYears, b.licenseNumber || null,
         b.phone, b.consultationFee || Number(fee ? fee.setting_value : 200), b.bio || null, b.verified === false ? 0 : 1]
      );
      // Default schedule: Mon-Sat 09:00-17:00, lunch 13:00-14:00, 20-minute slots; Sunday off.
      for (let day = 0; day <= 6; day++) {
        await conn.execute(
          `INSERT INTO doctor_availability (doctor_id, day_of_week, is_working, start_time, end_time, break_start, break_end, slot_minutes)
           VALUES (?, ?, ?, '09:00', '17:00', ?, ?, 20)`,
          [d.insertId, day, day === 0 ? 0 : 1, day === 0 ? null : '13:00', day === 0 ? null : '14:00']
        );
      }
      await conn.commit();
      await logActivity(req.user.id, 'DOCTOR_CREATED', b.fullName, req.ip);
      res.status(201).json({ message: 'Doctor account created. Share the login email and password securely with the doctor.', doctorId: d.insertId });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (err.code === 'ER_DUP_ENTRY') {
        throw httpError(409, /license/.test(err.message) ? 'This license number is already registered.' : 'This email or mobile number is already registered.');
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

router.put('/doctors/:id', [idParam, ...doctorFields], validate, wrap(async (req, res) => {
  const doc = await findDoctor(req.params.id);
  const b = req.body;
  // An empty fee field keeps the current fee.
  const fee = b.consultationFee === '' || b.consultationFee === undefined || b.consultationFee === null ? null : Number(b.consultationFee);
  try {
    await pool.execute(
      `UPDATE doctors SET full_name = ?, specialization_id = ?, qualifications = ?, experience_years = ?,
              license_number = ?, phone = ?, consultation_fee = COALESCE(?, consultation_fee), bio = ? WHERE id = ?`,
      [b.fullName, b.specializationId, b.qualifications, b.experienceYears, b.licenseNumber || null,
       b.phone, fee, b.bio || null, doc.id]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'This license number is already registered.');
    if (err.code === 'ER_NO_REFERENCED_ROW_2') throw httpError(400, 'Selected specialization does not exist.');
    throw err;
  }
  await logActivity(req.user.id, 'DOCTOR_UPDATED', doc.full_name, req.ip);
  res.json({ message: 'Doctor details updated.' });
}));

router.post('/doctors/:id/photo', uploadPhoto, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw httpError(400, 'Invalid doctor.');
  if (!req.file) throw httpError(400, 'Choose a JPG or PNG image (max 2 MB).');
  let doc;
  try {
    doc = await findDoctor(id);
  } catch (err) {
    removeUpload(`photos/${req.file.filename}`);
    throw err;
  }
  const url = `/uploads/photos/${req.file.filename}`;
  await pool.execute('UPDATE doctors SET photo = ? WHERE id = ?', [url, doc.id]);
  removeUpload(doc.photo);
  res.json({ message: 'Photo updated.', photo: url });
}));

// Qualification verification: only verified, active doctors are visible to patients.
router.post('/doctors/:id/verify', [idParam, body('verified').isBoolean().toBoolean()], validate, wrap(async (req, res) => {
  const doc = await findDoctor(req.params.id);
  await pool.execute('UPDATE doctors SET is_verified = ? WHERE id = ?', [req.body.verified ? 1 : 0, doc.id]);
  await notifyUser(
    doc.user_id,
    req.body.verified ? 'Profile verified' : 'Verification removed',
    req.body.verified ? 'Your qualifications have been verified. Patients can now book appointments with you.' : 'Your profile is no longer verified. Please contact the hospital administration.',
    'system'
  );
  await logActivity(req.user.id, req.body.verified ? 'DOCTOR_VERIFIED' : 'DOCTOR_UNVERIFIED', doc.full_name, req.ip);
  res.json({ message: req.body.verified ? 'Doctor verified.' : 'Verification removed.' });
}));

// Deactivating a doctor also cancels (and refunds) their upcoming appointments.
router.post('/doctors/:id/status', [idParam, body('active').isBoolean().toBoolean()], validate, wrap(async (req, res) => {
  const doc = await findDoctor(req.params.id);
  const active = req.body.active ? 1 : 0;
  await pool.execute('UPDATE doctors SET is_active = ? WHERE id = ?', [active, doc.id]);
  await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [active, doc.user_id]);
  let cancelled = 0;
  if (!active) {
    const [rows] = await pool.execute(
      "SELECT id FROM appointments WHERE doctor_id = ? AND status IN ('pending','confirmed') AND appointment_date >= ?",
      [doc.id, todayISO()]
    );
    for (const r of rows) {
      await svc.cancelAppointment(r.id, { by: 'admin', reason: 'Doctor is no longer available', actorUserId: req.user.id, ip: req.ip })
        .then(() => { cancelled++; }).catch((e) => console.error('deactivate cancel:', e.message));
    }
  }
  await logActivity(req.user.id, active ? 'DOCTOR_ACTIVATED' : 'DOCTOR_DEACTIVATED', doc.full_name, req.ip);
  res.json({ message: active ? 'Doctor account activated.' : `Doctor account deactivated. ${cancelled} upcoming appointment(s) cancelled and refunded.` });
}));

router.delete('/doctors/:id', [idParam], validate, wrap(async (req, res) => {
  const doc = await findDoctor(req.params.id);
  const [[{ total }]] = await pool.execute('SELECT COUNT(*) AS total FROM appointments WHERE doctor_id = ?', [doc.id]);
  if (total > 0) throw httpError(409, 'This doctor has appointment history and cannot be deleted. Deactivate the account instead.');
  await pool.execute('DELETE FROM users WHERE id = ?', [doc.user_id]); // cascades to doctors + availability
  removeUpload(doc.photo);
  await logActivity(req.user.id, 'DOCTOR_DELETED', doc.full_name, req.ip);
  res.json({ message: 'Doctor deleted.' });
}));

router.get('/doctors/:id/schedule', [idParam], validate, wrap(async (req, res) => {
  const doc = await findDoctor(req.params.id);
  res.json(await getWeeklySchedule(doc.id));
}));

router.put('/doctors/:id/schedule', [idParam], validate, wrap(async (req, res) => {
  const doc = await findDoctor(req.params.id);
  const days = (req.body.days || []).map((d) => ({
    day_of_week: Number(d.day_of_week), is_working: !!d.is_working, start_time: d.start_time, end_time: d.end_time,
    break_start: d.break_start || null, break_end: d.break_end || null, slot_minutes: Number(d.slot_minutes),
  }));
  const error = validateSchedule(days);
  if (error) throw httpError(400, error);
  await saveSchedule(doc.id, days);
  await logActivity(req.user.id, 'DOCTOR_SCHEDULE_UPDATED', doc.full_name, req.ip);
  res.json({ message: 'Schedule saved.' });
}));

// ---------------------------------------------------------- SPECIALIZATIONS
router.get('/specializations', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT s.id, s.name, s.description, s.icon, s.is_active,
            (SELECT COUNT(*) FROM doctors d WHERE d.specialization_id = s.id AND d.is_active = 1) AS doctors
       FROM specializations s ORDER BY s.name`
  );
  res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active })));
}));

const specRules = [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2-80 characters.'),
  body('description').optional({ values: 'falsy' }).trim().isLength({ max: 255 }),
  body('icon').optional({ values: 'falsy' }).trim().matches(/^bi-[a-z0-9-]{1,40}$/).withMessage('Icon must be a Bootstrap icon class such as bi-heart-pulse.'),
];

router.post('/specializations', specRules, validate, wrap(async (req, res) => {
  const { name, description, icon } = req.body;
  try {
    await pool.execute('INSERT INTO specializations (name, description, icon) VALUES (?, ?, ?)', [name, description || null, icon || 'bi-heart-pulse']);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'A specialization with this name already exists.');
    throw err;
  }
  await logActivity(req.user.id, 'SPECIALIZATION_ADDED', name, req.ip);
  res.status(201).json({ message: 'Specialization added.' });
}));

router.put('/specializations/:id', [idParam, ...specRules, body('isActive').optional().isBoolean().toBoolean()], validate, wrap(async (req, res) => {
  const { name, description, icon, isActive } = req.body;
  if (isActive === false) {
    const [[{ docs }]] = await pool.execute('SELECT COUNT(*) AS docs FROM doctors WHERE specialization_id = ? AND is_active = 1', [req.params.id]);
    if (docs > 0) throw httpError(409, 'Active doctors still use this specialization. Reassign or deactivate them first.');
  }
  try {
    const [r] = await pool.execute(
      'UPDATE specializations SET name = ?, description = ?, icon = COALESCE(?, icon), is_active = COALESCE(?, is_active) WHERE id = ?',
      [name, description || null, icon || null, isActive === undefined ? null : (isActive ? 1 : 0), req.params.id]
    );
    if (!r.affectedRows) throw httpError(404, 'Specialization not found.');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'A specialization with this name already exists.');
    throw err;
  }
  await logActivity(req.user.id, 'SPECIALIZATION_UPDATED', name, req.ip);
  res.json({ message: 'Specialization updated.' });
}));

// Health-issue -> specialization mapping used by the patient recommendation feature.
router.get('/health-issues', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT h.id, h.name, s.id AS specialization_id, s.name AS specialization FROM health_issues h JOIN specializations s ON s.id = h.specialization_id ORDER BY h.name'
  );
  res.json(rows);
}));

router.post(
  '/health-issues',
  [body('name').trim().isLength({ min: 2, max: 100 }), body('specializationId').isInt({ min: 1 }).toInt()],
  validate,
  wrap(async (req, res) => {
    try {
      await pool.execute('INSERT INTO health_issues (name, specialization_id) VALUES (?, ?)', [req.body.name, req.body.specializationId]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'This health issue already exists.');
      if (err.code === 'ER_NO_REFERENCED_ROW_2') throw httpError(400, 'Selected specialization does not exist.');
      throw err;
    }
    res.status(201).json({ message: 'Health issue added.' });
  })
);

router.delete('/health-issues/:id', [idParam], validate, wrap(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM health_issues WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) throw httpError(404, 'Health issue not found.');
  res.json({ message: 'Health issue removed.' });
}));

// ----------------------------------------------------------------- PATIENTS
router.get('/patients', [query('q').optional().trim().isLength({ max: 80 })], validate, wrap(async (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const params = [];
  let where = 'WHERE 1=1';
  if (req.query.q) {
    where += ' AND (p.full_name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ?)';
    params.push(likeParam(req.query.q), likeParam(req.query.q), likeParam(req.query.q));
  }
  const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM patients p JOIN users u ON u.id = p.user_id ${where}`, params);
  const [rows] = await pool.execute(
    `SELECT p.id, p.full_name, p.age, p.gender, u.email, u.mobile, u.is_active, u.mobile_verified, u.created_at,
            (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id AND ${svc.HAS_PAID}) AS appointments
       FROM patients p JOIN users u ON u.id = p.user_id ${where}
      ORDER BY p.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );
  res.json({ page, pageSize, total, items: rows.map((r) => ({ ...r, is_active: !!r.is_active, mobile_verified: !!r.mobile_verified })) });
}));

router.get('/patients/:id', [idParam], validate, wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT p.id, p.full_name, p.age, p.gender, p.blood_group, p.address, u.email, u.mobile, u.is_active, u.created_at
       FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    [req.params.id]
  );
  if (!rows[0]) throw httpError(404, 'Patient not found.');
  const [appointments] = await pool.execute(
    `SELECT a.appointment_code, a.appointment_date, a.slot_time, a.status, d.full_name AS doctor_name
       FROM appointments a JOIN doctors d ON d.id = a.doctor_id
      WHERE a.patient_id = ? ORDER BY a.appointment_date DESC, a.slot_time DESC LIMIT 50`,
    [req.params.id]
  );
  res.json({ patient: { ...rows[0], is_active: !!rows[0].is_active }, appointments });
}));

router.post('/patients/:id/status', [idParam, body('active').isBoolean().toBoolean()], validate, wrap(async (req, res) => {
  const [rows] = await pool.execute('SELECT user_id, full_name FROM patients WHERE id = ?', [req.params.id]);
  if (!rows[0]) throw httpError(404, 'Patient not found.');
  await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [req.body.active ? 1 : 0, rows[0].user_id]);
  await logActivity(req.user.id, req.body.active ? 'PATIENT_ACTIVATED' : 'PATIENT_DEACTIVATED', rows[0].full_name, req.ip);
  res.json({ message: req.body.active ? 'Patient account activated.' : 'Patient account deactivated.' });
}));

// ------------------------------------------------------------- APPOINTMENTS
router.get(
  '/appointments',
  [
    query('q').optional().trim().isLength({ max: 80 }),
    query('doctorId').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    query('status').optional({ values: 'falsy' }).isIn(['pending', 'confirmed', 'completed', 'cancelled', 'rejected']),
    optDate('date'),
  ],
  validate,
  wrap(async (req, res) => {
    const { page, pageSize, offset } = parsePage(req);
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.q) {
      where += ' AND (a.appointment_code LIKE ? OR p.full_name LIKE ? OR d.full_name LIKE ?)';
      params.push(likeParam(req.query.q), likeParam(req.query.q), likeParam(req.query.q));
    }
    if (req.query.date) { where += ' AND a.appointment_date = ?'; params.push(req.query.date); }
    if (req.query.doctorId) { where += ' AND a.doctor_id = ?'; params.push(req.query.doctorId); }
    if (req.query.status) { where += ' AND a.status = ?'; params.push(req.query.status); }

    const base = `FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id ${where}`;
    const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total ${base}`, params);
    const [rows] = await pool.execute(
      `SELECT a.id, a.appointment_code, a.appointment_date, a.slot_time, a.status, a.cancelled_by, a.cancel_reason,
              p.full_name AS patient_name, d.full_name AS doctor_name,
              (SELECT pm.status FROM payments pm WHERE pm.appointment_id = a.id ORDER BY pm.id DESC LIMIT 1) AS payment_status
         ${base} ORDER BY a.appointment_date DESC, a.slot_time DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    res.json({ page, pageSize, total, items: rows });
  })
);

router.post(
  '/appointments/:id/cancel',
  [idParam, body('reason').trim().isLength({ min: 3, max: 200 }).withMessage('Please give a reason (3-200 characters).')],
  validate,
  wrap(async (req, res) => {
    const r = await svc.cancelAppointment(req.params.id, { by: 'admin', reason: req.body.reason, actorUserId: req.user.id, ip: req.ip });
    res.json({ message: `Appointment cancelled.${r.refundText ? ' ' + r.refundText : ''}` });
  })
);

// ----------------------------------------------------------------- PAYMENTS
const paymentValidators = [
  query('status').optional({ values: 'falsy' }).isIn(['pending', 'success', 'failed', 'refunded']),
  optDate('from'),
  optDate('to'),
];

function paymentFilter(q) {
  const params = [];
  let where = 'WHERE 1=1';
  if (q.status) { where += ' AND p.status = ?'; params.push(q.status); }
  if (q.from) { where += ' AND DATE(COALESCE(p.paid_at, p.created_at)) >= ?'; params.push(q.from); }
  if (q.to) { where += ' AND DATE(COALESCE(p.paid_at, p.created_at)) <= ?'; params.push(q.to); }
  return { where, params };
}

const PAYMENT_SELECT = `
  SELECT p.id, p.receipt_no, p.transaction_ref, p.amount, p.method, p.status, p.mode,
         COALESCE(p.paid_at, p.created_at) AS payment_date,
         a.appointment_code, pt.full_name AS patient_name, d.full_name AS doctor_name
    FROM payments p
    JOIN appointments a ON a.id = p.appointment_id
    JOIN patients pt ON pt.id = p.patient_id
    JOIN doctors d ON d.id = a.doctor_id`;

router.get('/payments', paymentValidators, validate, wrap(async (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const { where, params } = paymentFilter(req.query);
  const [[s]] = await pool.execute(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN p.status = 'success' THEN p.amount END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN p.status = 'refunded' THEN p.amount END), 0) AS refunded,
            SUM(p.status = 'success') AS successful, SUM(p.status = 'failed') AS failed
       FROM payments p ${where}`,
    params
  );
  const [rows] = await pool.execute(`${PAYMENT_SELECT} ${where} ORDER BY p.id DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
  res.json({
    page, pageSize, total: s.total,
    summary: { revenue: Number(s.revenue), refunded: Number(s.refunded), successful: n(s.successful), failed: n(s.failed) },
    items: rows,
  });
}));

// CSV report. Cells starting with = + - @ are prefixed with ' so spreadsheets never run them as formulas.
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

router.get('/payments/report', paymentValidators, validate, wrap(async (req, res) => {
  const { where, params } = paymentFilter(req.query);
  const [rows] = await pool.execute(`${PAYMENT_SELECT} ${where} ORDER BY p.id DESC LIMIT 5000`, params);
  const head = ['Receipt No', 'Transaction Ref', 'Date', 'Appointment', 'Patient', 'Doctor', 'Method', 'Mode', 'Status', 'Amount (INR)'];
  const lines = [head.map(csvCell).join(',')];
  rows.forEach((r) =>
    lines.push(
      [r.receipt_no, r.transaction_ref, r.payment_date, r.appointment_code, r.patient_name, r.doctor_name, r.method, r.mode, r.status, Number(r.amount).toFixed(2)]
        .map(csvCell).join(',')
    )
  );
  await logActivity(req.user.id, 'PAYMENT_REPORT_EXPORTED', `${rows.length} rows`, req.ip);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="payments-${todayISO()}.csv"`,
  });
  res.send('﻿' + lines.join('\r\n'));
}));

// ------------------------------------------------------------------ REVIEWS
router.get('/reviews', wrap(async (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const [[{ total }]] = await pool.execute('SELECT COUNT(*) AS total FROM reviews');
  const [rows] = await pool.execute(
    `SELECT r.id, r.rating, r.comment, r.is_visible, r.created_at, p.full_name AS patient_name, d.full_name AS doctor_name
       FROM reviews r JOIN patients p ON p.id = r.patient_id JOIN doctors d ON d.id = r.doctor_id
      ORDER BY r.id DESC LIMIT ${pageSize} OFFSET ${offset}`
  );
  res.json({ page, pageSize, total, items: rows.map((r) => ({ ...r, is_visible: !!r.is_visible })) });
}));

router.put('/reviews/:id/visibility', [idParam, body('visible').isBoolean().toBoolean()], validate, wrap(async (req, res) => {
  const [r] = await pool.execute('UPDATE reviews SET is_visible = ? WHERE id = ?', [req.body.visible ? 1 : 0, req.params.id]);
  if (!r.affectedRows) throw httpError(404, 'Review not found.');
  await logActivity(req.user.id, req.body.visible ? 'REVIEW_SHOWN' : 'REVIEW_HIDDEN', `review ${req.params.id}`, req.ip);
  res.json({ message: req.body.visible ? 'Review is now visible.' : 'Review hidden.' });
}));

// ----------------------------------------------------------------- SETTINGS
const SETTING_RULES = {
  hospital_name: (v) => v.length >= 2 && v.length <= 100,
  hospital_tagline: (v) => v.length <= 150,
  hospital_phone: (v) => /^[0-9+()\- ]{5,30}$/.test(v),
  hospital_email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 150,
  hospital_address: (v) => v.length <= 250,
  emergency_phone: (v) => /^[0-9+()\- ]{2,20}$/.test(v),
  default_fee: (v) => /^\d{1,6}(\.\d{1,2})?$/.test(v),
  working_hours: (v) => v.length <= 100,
};

router.get('/settings', wrap(async (req, res) => {
  const [rows] = await pool.execute('SELECT setting_key, setting_value FROM site_settings');
  res.json(Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value])));
}));

router.put('/settings', wrap(async (req, res) => {
  const updates = [];
  for (const [key, check] of Object.entries(SETTING_RULES)) {
    if (req.body[key] === undefined) continue;
    const value = String(req.body[key]).trim();
    if (!check(value)) throw httpError(400, `Invalid value for ${key.replace(/_/g, ' ')}.`);
    updates.push([key, value]);
  }
  if (!updates.length) throw httpError(400, 'No valid settings supplied.');
  for (const [key, value] of updates) {
    await pool.execute(
      'INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, value]
    );
  }
  // Optionally apply the default fee to every doctor (affects future bookings only).
  const fee = updates.find(([k]) => k === 'default_fee');
  if (fee && req.body.applyToAll === true) {
    await pool.execute('UPDATE doctors SET consultation_fee = ?', [Number(fee[1])]);
  }
  await logActivity(req.user.id, 'SETTINGS_UPDATED', updates.map(([k]) => k).join(', '), req.ip);
  res.json({ message: 'Settings saved.' });
}));

// ---------------------------------------------------------------------- LOGS
router.get('/logs', [query('q').optional().trim().isLength({ max: 80 })], validate, wrap(async (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const params = [];
  let where = 'WHERE 1=1';
  if (req.query.q) {
    where += ' AND (l.action LIKE ? OR l.details LIKE ? OR u.email LIKE ?)';
    params.push(likeParam(req.query.q), likeParam(req.query.q), likeParam(req.query.q));
  }
  const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ${where}`, params);
  const [rows] = await pool.execute(
    `SELECT l.id, l.action, l.details, l.ip_address, l.created_at, u.email, u.role
       FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ${where}
      ORDER BY l.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );
  res.json({ page, pageSize, total, items: rows });
}));

module.exports = router;
