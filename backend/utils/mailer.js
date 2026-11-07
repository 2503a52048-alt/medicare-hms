// Email notifications.
//  MAIL_MODE=dev  -> prints the email to the server console (DEVELOPMENT ONLY)
//  MAIL_MODE=smtp -> sends through the SMTP server configured in .env
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text }) {
  if ((process.env.MAIL_MODE || 'dev') !== 'smtp') {
    console.log(`\n[MAIL - DEV MODE] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return { dev: true };
  }
  try {
    return await getTransporter().sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject,
      text,
    });
  } catch (err) {
    // Email failure must never break the booking flow.
    console.error('Email send failed:', err.message);
    return { error: err.message };
  }
}

module.exports = { sendMail };
