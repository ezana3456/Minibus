// Usage: node src/scripts/create-admin.js <username> <password> ["Full Name"]
const { pool } = require('../db');
const { hash } = require('../passwords');
(async () => {
  const [username, password, fullName] = process.argv.slice(2);
  if (!username || !password || password.length < 8) {
    console.log('Usage: npm run admin:create -- <username> <password (8+ chars)> "Full Name"');
    process.exit(1);
  }
  await pool.query(
    `INSERT INTO staff_users(username, password_hash, full_name, role) VALUES($1,$2,$3,'admin')
     ON CONFLICT (username) DO UPDATE SET password_hash=$2, role='admin', active=true`,
    [username.toLowerCase(), hash(password), fullName || username]
  );
  console.log(`Admin "${username}" is ready. Open http://localhost:4000/admin`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
