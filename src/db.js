const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
});

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing from backend/.env');
}

const dbUrl = new URL(process.env.DATABASE_URL);

console.log('Database username:', dbUrl.username);
console.log('Database host:', dbUrl.hostname);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};