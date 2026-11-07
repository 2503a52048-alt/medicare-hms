// Convenience script: creates the database and loads reference data without the mysql CLI.
//   npm run db:init
// WARNING: schema.sql drops and recreates all tables. Do not run it on a database with real data.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run db:init in production (it drops all tables).');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  const dbName = process.env.DB_NAME || 'medicare_hms';
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) { console.error('DB_NAME may only contain letters, numbers and underscore.'); process.exit(1); }
  try {
    for (const file of ['schema.sql', 'sample-data.sql']) {
      let sql = fs.readFileSync(path.join(__dirname, '..', 'database', file), 'utf8');
      // Managed databases already exist (e.g. "defaultdb") and usually forbid CREATE DATABASE.
      if (process.env.DB_SKIP_CREATE === 'true') sql = sql.replace(/CREATE DATABASE[\s\S]*?;\s*/i, '');
      sql = sql.replace(/USE medicare_hms;/g, `USE \`${dbName}\`;`);
      await conn.query(sql);
      console.log(`Loaded database/${file}`);
    }
    console.log('Database ready. Next: npm run db:seed');
  } catch (err) {
    console.error('Database setup failed:', err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})();
