const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { wrap, auth } = require('../middleware');

const { normPhone, validPhone } = require('../phone');
const sign = (u) => jwt.sign({ id: u.id, phone: u.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });

router.post('/request-otp', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await query(
    `INSERT INTO otps(phone, code, expires_at) VALUES($1,$2, now() + interval '5 minutes')
     ON CONFLICT (phone) DO UPDATE SET code=$2, expires_at=now() + interval '5 minutes'`,
    [phone, code]
  );
  // TODO: send `code` by SMS here (Ethio Telecom / Africa's Talking / Firebase etc.)
  console.log(`OTP for ${phone}: ${code}`);
  res.json({ ok: true, ...(process.env.DEV_OTP === 'true' ? { devCode: code } : {}) });
}));

router.post('/verify-otp', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  const { code, fullName } = req.body;
  const o = await query('SELECT * FROM otps WHERE phone=$1 AND code=$2 AND expires_at > now()', [phone, String(code)]);
  if (!o.rows.length) return res.status(400).json({ error: 'Wrong or expired code' });
  await query('DELETE FROM otps WHERE phone=$1', [phone]);
  const r = await query(
    `INSERT INTO users(phone, full_name) VALUES($1,$2)
     ON CONFLICT (phone) DO UPDATE SET full_name = COALESCE(NULLIF($2,''), users.full_name)
     RETURNING id, phone, full_name`,
    [phone, fullName || null]
  );
  res.json({ token: sign(r.rows[0]), user: r.rows[0] });
}));

router.get('/me', auth, wrap(async (req, res) => {
  const r = await query('SELECT id, phone, full_name FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
}));

router.patch('/me', auth, wrap(async (req, res) => {
  const r = await query('UPDATE users SET full_name=$1 WHERE id=$2 RETURNING id, phone, full_name', [req.body.fullName, req.user.id]);
  res.json(r.rows[0]);
}));

module.exports = router;
