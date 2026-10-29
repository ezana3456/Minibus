// One canonical format so one person = one account.
// Ethiopian numbers (0912345678, 251912345678, +251 91 234 5678) all become +251912345678.
function normPhone(p) {
  const s = String(p || '').replace(/[\s()-]/g, '');
  if (/^(\+?251|0)?9\d{8}$/.test(s)) return '+251' + s.slice(-9);
  return s;
}
const validPhone = (s) => /^\+2519\d{8}$/.test(s) || /^\+\d{9,15}$/.test(s);
module.exports = { normPhone, validPhone };
