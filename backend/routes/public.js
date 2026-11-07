// Public (no login) endpoints used by the homepage, doctor search, recommendation and booking pages.
const express = require('express');
const { query, param } = require('express-validator');

const pool = require('../config/db');
const validate = require('../middleware/validate');
const { listDoctors, getDoctor, withAvailability, getWeeklySchedule } = require('../models/doctorModel');
const { getAvailableSlots, getAvailableDates } = require('../utils/slots');

const router = express.Router();

const DISCLAIMER =
  'This is specialization-based guidance only. It is not a medical diagnosis and does not guarantee a cure. ' +
  'In an emergency call 108 or visit the nearest emergency department.';

router.get('/specializations', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.id, s.name, s.description, s.icon,
              (SELECT COUNT(*) FROM doctors d WHERE d.specialization_id = s.id AND d.is_active = 1 AND d.is_verified = 1) AS doctor_count
         FROM specializations s WHERE s.is_active = 1 ORDER BY s.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/health-issues', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT h.id, h.name, s.id AS specialization_id, s.name AS specialization
         FROM health_issues h JOIN specializations s ON s.id = h.specialization_id
        WHERE s.is_active = 1 ORDER BY h.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Search / filter: ?q=name-or-specialization&specialization=ID&limit=N
router.get(
  '/doctors',
  [
    query('q').optional().trim().isLength({ max: 80 }),
    query('specialization').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('availability').optional().isIn(['0', '1']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const withSlots = req.query.availability === '1';
      const doctors = await listDoctors({
        q: req.query.q,
        specializationId: req.query.specialization,
        limit: withSlots ? Math.min(req.query.limit || 24, 24) : req.query.limit,
      });
      // ?availability=1 adds upcoming free dates and slots (capped at 24 doctors to keep the query cheap).
      res.json(withSlots ? await withAvailability(doctors) : doctors);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/doctors/:id', [param('id').isInt({ min: 1 }).toInt()], validate, async (req, res, next) => {
  try {
    const doctor = await getDoctor(req.params.id);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found.' });

    const [reviews] = await pool.execute(
      `SELECT r.rating, r.comment, r.created_at, p.full_name AS patient_name
         FROM reviews r JOIN patients p ON p.id = r.patient_id
        WHERE r.doctor_id = ? AND r.is_visible = 1 ORDER BY r.created_at DESC LIMIT 10`,
      [doctor.id]
    );
    const schedule = await getWeeklySchedule(doctor.id);
    const available_dates = await getAvailableDates(doctor.id, 14);
    res.json({
      ...doctor,
      schedule,
      available_dates,
      // Show first name + initial only, to protect patient privacy.
      reviews: reviews.map((r) => ({ ...r, patient_name: shortName(r.patient_name) })),
    });
  } catch (err) {
    next(err);
  }
});

// Free / booked slots for one doctor on one date: ?date=YYYY-MM-DD
router.get(
  '/doctors/:id/slots',
  [param('id').isInt({ min: 1 }).toInt(), query('date').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date must be YYYY-MM-DD.')],
  validate,
  async (req, res, next) => {
    try {
      const doctor = await getDoctor(req.params.id);
      if (!doctor) return res.status(404).json({ message: 'Doctor not found.' });
      res.json(await getAvailableSlots(doctor.id, req.query.date));
    } catch (err) {
      next(err);
    }
  }
);

// Smart recommendation: ?issueId=ID -> matching specialization + doctors with availability
router.get(
  '/recommend',
  [query('issueId').isInt({ min: 1 }).withMessage('Select a health issue.').toInt()],
  validate,
  async (req, res, next) => {
    try {
      const [issues] = await pool.execute(
        `SELECT h.id, h.name, s.id AS specialization_id, s.name AS specialization
           FROM health_issues h JOIN specializations s ON s.id = h.specialization_id WHERE h.id = ?`,
        [req.query.issueId]
      );
      if (!issues.length) return res.status(404).json({ message: 'Health issue not found.' });
      const issue = issues[0];
      const doctors = await withAvailability(await listDoctors({ specializationId: issue.specialization_id }));
      res.json({
        issue: issue.name,
        specialization: issue.specialization,
        specialization_id: issue.specialization_id,
        disclaimer: DISCLAIMER,
        doctors,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/testimonials', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT r.rating, r.comment, r.created_at, p.full_name AS patient_name, d.full_name AS doctor_name
         FROM reviews r
         JOIN patients p ON p.id = r.patient_id
         JOIN doctors d ON d.id = r.doctor_id
        WHERE r.is_visible = 1 AND r.rating >= 4 AND r.comment IS NOT NULL AND r.comment <> ''
        ORDER BY r.created_at DESC LIMIT 6`
    );
    res.json(rows.map((r) => ({ ...r, patient_name: shortName(r.patient_name) })));
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT setting_key, setting_value FROM site_settings');
    res.json(Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value])));
  } catch (err) {
    next(err);
  }
});

function shortName(full) {
  const parts = String(full).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

module.exports = router;
