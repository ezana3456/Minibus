const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrate-admin.sql'), 'utf8'));
  console.log('Admin tables ready. Existing data kept.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
