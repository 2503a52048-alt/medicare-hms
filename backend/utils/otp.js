// OTP generation, delivery and verification.
//  OTP_MODE=dev    -> OTP printed in the server console (DEVELOPMENT ONLY; also returned
//                     in the API response when NODE_ENV is not production)
//  OTP_MODE=twilio -> real SMS through Twilio
// OTPs are stored hashed, expire after 10 minutes, and allow 5 attempts.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const MAX_ATTEMPTS = 5;

const isDevOtp = () => (process.env.OTP_MODE || 'dev') !== 'twilio';
// Only expose the OTP in the API response for local development.
const exposeDevOtp = () => isDevOtp() && process.env.NODE_ENV !== 'production';

async function sendSms(mobile, message) {
  if (isDevOtp()) {
    console.log(`\n[SMS - DEV MODE] To: +91${mobile}\n${message}\n`);
    return;
  }
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = process.env;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: `+91${mobile}`, From: from, Body: message }),
  });
  if (!res.ok) throw new Error(`SMS provider error (${res.status})`);
}

/** Creates and sends an OTP. `identifier` is the mobile number. */
async function issueOtp(identifier, purpose) {
  const [recent] = await pool.execute(
    `SELECT id FROM otp_codes
      WHERE identifier = ? AND purpose = ? AND created_at > (NOW() - INTERVAL 30 SECOND)`,
    [identifier, purpose]
  );
  if (recent.length) {
    const err = new Error('Please wait 30 seconds before requesting another OTP.');
    err.status = 429;
    throw err;
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const hash = await bcrypt.hash(code, 8);

  await pool.execute('UPDATE otp_codes SET used = 1 WHERE identifier = ? AND purpose = ? AND used = 0', [
    identifier, purpose,
  ]);
  await pool.execute(
    `INSERT INTO otp_codes (identifier, purpose, code_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
    [identifier, purpose, hash]
  );

  await sendSms(identifier, `Your MediCare verification code is ${code}. It is valid for 10 minutes. Do not share it.`);
  return exposeDevOtp() ? code : undefined;
}

/** Returns true when the code is correct (and consumes it). */
async function verifyOtp(identifier, purpose, code) {
  const [rows] = await pool.execute(
    `SELECT * FROM otp_codes
      WHERE identifier = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1`,
    [identifier, purpose]
  );
  if (!rows.length) return false;
  const row = rows[0];
  if (row.attempts >= MAX_ATTEMPTS) return false;

  await pool.execute('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  const ok = await bcrypt.compare(String(code), row.code_hash);
  if (ok) await pool.execute('UPDATE otp_codes SET used = 1 WHERE id = ?', [row.id]);
  return ok;
}

module.exports = { issueOtp, verifyOtp, exposeDevOtp };
