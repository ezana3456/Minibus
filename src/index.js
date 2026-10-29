require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { query } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/admin', require('express').static(require('path').join(__dirname, '../public/admin')));
app.use('/images', require('express').static(require('path').join(__dirname, '../public/images')));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/trips'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/admin', require('./routes/admin'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

// Release expired seat holds every minute
async function cleanup() {
  try {
    await query("UPDATE bookings SET status='expired' WHERE status='pending' AND hold_expires_at < now()");
    await query("UPDATE trip_seats SET status='available', held_by=NULL, held_until=NULL, booking_id=NULL WHERE status='held' AND held_until < now()");
  } catch (e) { console.error('cleanup failed', e.message); }
}
setInterval(cleanup, 60 * 1000);

const port = process.env.PORT || 4000;
app.listen(port, '0.0.0.0', () => console.log(`MinibusGo API on http://0.0.0.0:${port}`));
