// Authentication: patient registration + OTP, login for all 3 roles, logout,
// forgot/reset password (OTP), change password.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');

const pool = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { issueOtp, verifyOtp } = require('../utils/otp');
const { setAuthCookie, clearAuthCookie } = require('../utils/token');
const { logActivity, notify } = require('../utils/logger');
const { sendMail } = require('../utils/mailer');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again after a few minutes.' },
});

// Compared against when the account does not exist, so response time doesn't reveal valid accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const REDIRECTS = {
  patient: '/patient-dashboard.html',
  doctor: '/doctor-dashboard.html',
  admin: '/admin-dashboard.html',
};

const strongPassword = (field) =>
  body(field)
    .isLength({ min: 8, max: 72 }).withMessage('Password must be 8-72 characters.')
    .matches(/[a-z]/).withMessage('Password needs a lowercase letter.')
    .matches(/[A-Z]/).withMessage('Password needs an uppercase letter.')
    .matches(/\d/).withMessage('Password needs a number.');

const mobileRule = (field = 'mobile') =>
  body(field).trim().matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number.');

async function displayName(user) {
  if (user.role === 'admin') return 'Administrator';
  const table = user.role === 'doctor' ? 'doctors' : 'patients';
  const [rows] = await pool.execute(`SELECT full_name FROM ${table} WHERE user_id = ?`, [user.id]);
  return rows[0] ? rows[0].full_name : user.email;
}

// ---------------------------------------------------------------- REGISTER
router.post(
  '/register',
  limiter,
  [
    body('fullName').trim().isLength({ min: 2, max: 120 }).withMessage('Full name must be 2-120 characters.')
      .matches(/^[A-Za-z][A-Za-z .'-]*$/).withMessage('Name can contain only letters, spaces, . \' and -'),
    mobileRule(),
    body('email').trim().toLowerCase().isEmail().withMessage('Enter a valid email address.').isLength({ max: 150 }),
    body('age').isInt({ min: 1, max: 120 }).withMessage('Age must be between 1 and 120.').toInt(),
    body('gender').isIn(['male', 'female', 'other']).withMessage('Select a gender.'),
    strongPassword('password'),
  ],
  validate,
  async (req, res, next) => {
    const { fullName, mobile, email, age, gender, password } = req.body;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.execute(
        'SELECT id, role, mobile_verified FROM users WHERE email = ? OR mobile = ? FOR UPDATE',
        [email, mobile]
      );
      // A verified account (or a doctor/admin) already owns this email/mobile.
      if (existing.some((u) => u.mobile_verified || u.role !== 'patient')) {
        await conn.rollback();
        return res.status(409).json({ message: 'An account with this email or mobile number already exists.' });
      }
      // Stale, never-verified sign-ups are replaced so the person can retry.
      for (const u of existing) await conn.execute('DELETE FROM users WHERE id = ?', [u.id]);

      const hash = await bcrypt.hash(password, 12);
      const [r] = await conn.execute(
        "INSERT INTO users (email, mobile, password_hash, role) VALUES (?, ?, ?, 'patient')",
        [email, mobile, hash]
      );
      await conn.execute(
        'INSERT INTO patients (user_id, full_name, age, gender) VALUES (?, ?, ?, ?)',
        [r.insertId, fullName, age, gender]
      );
      await conn.commit();

      const devOtp = await issueOtp(mobile, 'register');
      await logActivity(r.insertId, 'PATIENT_REGISTERED', `New patient sign-up: ${email}`, req.ip);
      res.status(201).json({
        message: 'Account created. Enter the OTP sent to your mobile number to verify it.',
        mobile,
        devOtp, // only present in development mode
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      next(err);
    } finally {
      conn.release();
    }
  }
);

// ------------------------------------------------------------- VERIFY OTP
router.post(
  '/verify-otp',
  limiter,
  [mobileRule(), body('code').trim().matches(/^\d{6}$/).withMessage('Enter the 6-digit OTP.')],
  validate,
  async (req, res, next) => {
    try {
      const { mobile, code } = req.body;
      const [rows] = await pool.execute("SELECT * FROM users WHERE mobile = ? AND role = 'patient'", [mobile]);
      if (!rows.length) return res.status(400).json({ message: 'Invalid or expired OTP.' });

      const ok = await verifyOtp(mobile, 'register', code);
      if (!ok) return res.status(400).json({ message: 'Invalid or expired OTP.' });

      await pool.execute('UPDATE users SET mobile_verified = 1, last_login_at = NOW() WHERE id = ?', [rows[0].id]);
      await notify(rows[0].id, 'Welcome to MediCare', 'Your mobile number is verified. You can now book appointments.', 'system');
      await sendMail({
        to: rows[0].email,
        subject: 'Welcome to MediCare',
        text: 'Your MediCare account is ready. You can now book appointments with our doctors.',
      });
      await logActivity(rows[0].id, 'MOBILE_VERIFIED', null, req.ip);

      setAuthCookie(res, rows[0]);
      res.json({ message: 'Mobile number verified.', role: 'patient', redirect: REDIRECTS.patient });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/resend-otp', limiter, [mobileRule()], validate, async (req, res, next) => {
  try {
    const { mobile } = req.body;
    const [rows] = await pool.execute(
      "SELECT id FROM users WHERE mobile = ? AND role = 'patient' AND mobile_verified = 0",
      [mobile]
    );
    // Same response whether or not the number exists.
    let devOtp;
    if (rows.length) devOtp = await issueOtp(mobile, 'register');
    res.json({ message: 'If this number is awaiting verification, a new OTP has been sent.', devOtp });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ LOGIN
router.post(
  '/login',
  limiter,
  [
    body('identifier').trim().notEmpty().withMessage('Enter your email or mobile number.'),
    body('password').notEmpty().withMessage('Enter your password.'),
    body('role').isIn(['patient', 'doctor', 'admin']).withMessage('Select a valid role.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { identifier, password, role } = req.body;
      const id = identifier.toLowerCase();
      const [rows] = await pool.execute(
        'SELECT * FROM users WHERE (email = ? OR mobile = ?) AND role = ?',
        [id, identifier, role]
      );
      const user = rows[0];
      const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
      if (!user || !valid) {
        await logActivity(user ? user.id : null, 'LOGIN_FAILED', `Role ${role}, identifier ${id.slice(0, 40)}`, req.ip);
        return res.status(401).json({ message: 'Invalid credentials.' });
      }
      if (!user.is_active) {
        return res.status(403).json({ message: 'This account has been deactivated. Please contact the hospital.' });
      }
      if (role === 'patient' && !user.mobile_verified) {
        return res.status(403).json({
          message: 'Please verify your mobile number first.',
          needsVerification: true,
          mobile: user.mobile,
        });
      }

      await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
      await logActivity(user.id, 'LOGIN', `${role} logged in`, req.ip);
      setAuthCookie(res, user);
      res.json({ message: 'Login successful.', role, name: await displayName(user), redirect: REDIRECTS[role] });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Logged out.' });
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    res.json({
      id: req.user.id,
      role: req.user.role,
      email: req.user.email,
      mobile: req.user.mobile,
      name: await displayName(req.user),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- PASSWORD MANAGEMENT
router.post(
  '/forgot-password',
  limiter,
  [body('identifier').trim().notEmpty().withMessage('Enter your email or mobile number.')],
  validate,
  async (req, res, next) => {
    try {
      const identifier = req.body.identifier;
      const [rows] = await pool.execute(
        'SELECT id, mobile, email FROM users WHERE (email = ? OR mobile = ?) AND is_active = 1 LIMIT 1',
        [identifier.toLowerCase(), identifier]
      );
      let devOtp;
      if (rows.length) {
        devOtp = await issueOtp(rows[0].mobile, 'reset');
        await logActivity(rows[0].id, 'PASSWORD_RESET_REQUESTED', null, req.ip);
      }
      // Identical response whether or not the account exists (prevents account enumeration).
      res.json({ message: 'If an account exists, an OTP has been sent to its registered mobile number.', devOtp });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/reset-password',
  limiter,
  [
    body('identifier').trim().notEmpty().withMessage('Enter your email or mobile number.'),
    body('code').trim().matches(/^\d{6}$/).withMessage('Enter the 6-digit OTP.'),
    strongPassword('newPassword'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { identifier, code, newPassword } = req.body;
      const [rows] = await pool.execute(
        'SELECT id, mobile FROM users WHERE (email = ? OR mobile = ?) AND is_active = 1 LIMIT 1',
        [identifier.toLowerCase(), identifier]
      );
      const ok = rows.length && (await verifyOtp(rows[0].mobile, 'reset', code));
      if (!ok) return res.status(400).json({ message: 'Invalid or expired OTP.' });

      const hash = await bcrypt.hash(newPassword, 12);
      await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, rows[0].id]);
      await logActivity(rows[0].id, 'PASSWORD_RESET', null, req.ip);
      res.json({ message: 'Password updated. You can now log in.' });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/change-password',
  authenticate,
  [body('currentPassword').notEmpty().withMessage('Enter your current password.'), strongPassword('newPassword')],
  validate,
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;
      const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
      if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
        return res.status(400).json({ message: 'Current password is incorrect.' });
      }
      if (currentPassword === newPassword) {
        return res.status(400).json({ message: 'New password must be different from the current one.' });
      }
      await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [
        await bcrypt.hash(newPassword, 12), req.user.id,
      ]);
      await logActivity(req.user.id, 'PASSWORD_CHANGED', null, req.ip);
      res.json({ message: 'Password changed successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
