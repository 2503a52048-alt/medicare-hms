// In-app notification + email in one call. Never throws.
const pool = require('../config/db');
const { notify } = require('./logger');
const { sendMail } = require('./mailer');

async function notifyUser(userId, title, message, type = 'system') {
  await notify(userId, title, message, type);
  try {
    const [rows] = await pool.execute('SELECT email FROM users WHERE id = ?', [userId]);
    if (rows[0]) await sendMail({ to: rows[0].email, subject: `MediCare: ${title}`, text: message });
  } catch (err) {
    console.error('Email notification failed:', err.message);
  }
}

module.exports = { notifyUser };
