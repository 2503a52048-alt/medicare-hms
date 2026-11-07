// Writes to the activity_logs table. Never throws: logging must not break a request.
const pool = require('../config/db');

async function logActivity(userId, action, details = null, ip = null) {
  try {
    await pool.execute(
      'INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
      [userId || null, String(action).slice(0, 80), details ? String(details).slice(0, 500) : null, ip]
    );
  } catch (err) {
    console.error('Activity log failed:', err.message);
  }
}

async function notify(userId, title, message, type = 'system') {
  try {
    await pool.execute(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, title.slice(0, 150), message.slice(0, 500), type]
    );
  } catch (err) {
    console.error('Notification failed:', err.message);
  }
}

module.exports = { logActivity, notify };
