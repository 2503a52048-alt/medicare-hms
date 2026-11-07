// Authentication and role-based authorization.
// The user row is re-read from MySQL on every request, so deactivating an account
// takes effect immediately instead of waiting for the token to expire.
const pool = require('../config/db');
const { COOKIE, verifyToken } = require('../utils/token');

async function resolveUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    const [rows] = await pool.execute(
      `SELECT u.id, u.role, u.email, u.mobile, u.is_active,
              p.id AS patient_id, d.id AS doctor_id
         FROM users u
         LEFT JOIN patients p ON p.user_id = u.id
         LEFT JOIN doctors  d ON d.user_id = u.id
        WHERE u.id = ?`,
      [payload.id]
    );
    if (!rows.length || !rows[0].is_active) return null;
    const u = rows[0];
    return {
      id: u.id, role: u.role, email: u.email, mobile: u.mobile,
      patientId: u.patient_id || null, doctorId: u.doctor_id || null,
    };
  } catch {
    return null;
  }
}

async function authenticate(req, res, next) {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ message: 'Please log in to continue.' });
  req.user = user;
  next();
}

const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'You do not have permission to access this resource.' });
  }
  next();
};

// For HTML dashboard pages: redirect to the login page instead of returning JSON.
const pageGuard = (role) => async (req, res, next) => {
  const user = await resolveUser(req);
  if (!user || user.role !== role) return res.redirect(`/login.html?role=${role}`);
  req.user = user;
  next();
};

module.exports = { authenticate, authorize, pageGuard };
