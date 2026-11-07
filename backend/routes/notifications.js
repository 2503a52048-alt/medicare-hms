// In-app notifications for every role. Users only ever see their own.
const express = require('express');
const { param } = require('express-validator');

const pool = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { wrap } = require('../utils/httpError');

const router = express.Router();
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT id, title, message, type, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30',
    [req.user.id]
  );
  const [[{ unread }]] = await pool.execute('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ unread, notifications: rows.map((r) => ({ ...r, is_read: !!r.is_read })) });
}));

router.post('/read-all', wrap(async (req, res) => {
  await pool.execute('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ message: 'All notifications marked as read.' });
}));

router.post('/:id/read', [param('id').isInt({ min: 1 }).toInt()], validate, wrap(async (req, res) => {
  await pool.execute('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ message: 'Marked as read.' });
}));

module.exports = router;
