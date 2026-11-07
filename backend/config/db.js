// MySQL connection pool. Credentials come ONLY from environment variables (.env).
require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'medicare_hms',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // DATE/TIME/DATETIME come back as plain strings (no timezone surprises)
  charset: 'utf8mb4',
  // Cloud MySQL providers (Aiven, TiDB, Railway...) require TLS: set DB_SSL=true.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  timezone: '+05:30',
});

module.exports = pool;
