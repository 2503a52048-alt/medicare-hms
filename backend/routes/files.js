// Authenticated file access. Prescription files are private: only the patient they belong to,
// the doctor who wrote them, or an admin may download them. (Doctor photos are public.)
const path = require('path');
const express = require('express');
const { param } = require('express-validator');

const pool = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { wrap, httpError } = require('../utils/httpError');
const { ROOT } = require('../middleware/upload');

const router = express.Router();
router.use(authenticate);

router.get('/prescription/:id', [param('id').isInt({ min: 1 }).toInt()], validate, wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT rx.file_path, rx.patient_id, rx.doctor_id FROM prescriptions rx WHERE rx.id = ?`,
    [req.params.id]
  );
  const rx = rows[0];
  const allowed =
    rx &&
    (req.user.role === 'admin' ||
      (req.user.role === 'patient' && rx.patient_id === req.user.patientId) ||
      (req.user.role === 'doctor' && rx.doctor_id === req.user.doctorId));
  if (!allowed || !rx.file_path) throw httpError(404, 'File not found.');

  const full = path.resolve(ROOT, 'prescriptions', path.basename(rx.file_path));
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(full, (err) => {
    if (err && !res.headersSent) res.status(404).json({ message: 'File not found.' });
  });
}));

module.exports = router;
