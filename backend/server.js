// MediCare - Hospital Appointment Management System: Express server entry point.
require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const pool = require('./config/db');
const { pageGuard } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/error');

// ---- Fail fast on unsafe configuration ----
const PLACEHOLDER = 'replace_with_a_long_random_string';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === PLACEHOLDER || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is missing or too weak. Copy .env.example to .env and set a random value of 32+ characters.');
  process.exit(1);
}
const isProd = process.env.NODE_ENV === 'production';

const app = express();
app.disable('x-powered-by');
if (isProd) app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://checkout.razorpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
        frameSrc: ["'self'", 'https://api.razorpay.com'],
        objectSrc: ["'none'"],
        // Avoid forcing https while testing on http://localhost
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ---- API routes ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/public', require('./routes/public'));
app.use('/api/patient', require('./routes/patient'));
app.use('/api/doctor', require('./routes/doctor'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/files', require('./routes/files'));

app.use(notFound);

// ---- Protected dashboard pages (registered BEFORE static files) ----
const frontend = path.join(__dirname, '..', 'frontend');
['patient', 'doctor', 'admin'].forEach((role) => {
  app.get(`/${role}-dashboard.html`, pageGuard(role), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(frontend, `${role}-dashboard.html`));
  });
});

// Doctor photos are public; prescriptions are served only through the authenticated /api/files route.
app.use('/uploads/photos', express.static(path.join(__dirname, '..', 'uploads', 'photos')));
app.use(express.static(frontend));

app.use(errorHandler);

const PORT = Number(process.env.PORT) || 3000;
pool
  .query('SELECT 1')
  .then(() => {
    app.listen(PORT, () => {
      require('./services/scheduler').startScheduler();
      console.log(`MediCare server running at http://localhost:${PORT}`);
      console.log(`OTP mode: ${process.env.OTP_MODE || 'dev'} | Mail mode: ${process.env.MAIL_MODE || 'dev'} | Payment mode: ${process.env.PAYMENT_MODE || 'test'}`);
    });
  })
  .catch((err) => {
    console.error('Cannot connect to MySQL:', err.message);
    console.error('Check DB_* values in .env and make sure MySQL is running and the schema is loaded (npm run db:init).');
    process.exit(1);
  });
