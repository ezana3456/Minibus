const router = require('express').Router();
const { pool, query } = require('../db');
const { wrap, auth } = require('../middleware');

router.use(auth);

const HOLD_MIN = Number(process.env.SEAT_HOLD_MINUTES || 10);
const METHODS = ['telebirr', 'cbe_birr', 'commercial_bank', 'card'];

async function fetchBookings(userId, { id, status } = {}) {
  const params = [userId];
  let where = 'b.user_id=$1';
  if (id) { params.push(id); where += ` AND b.id=$${params.length}`; }
  if (status === 'upcoming') where += " AND b.status='confirmed' AND t.departure_at >= now()";
  if (status === 'completed') where += " AND b.status='confirmed' AND t.departure_at < now()";
  if (status === 'cancelled') where += " AND b.status IN ('cancelled','expired')";
  const r = await query(
    `SELECT b.id, b.ref, b.status, b.total_amount::float AS total_amount, b.hold_expires_at, b.created_at,
            t.id AS trip_id, t.departure_at, t.arrival_at, t.vehicle_type,
            o.name AS operator, r.origin, r.destination,
            (SELECT json_agg(json_build_object('fullName',p.full_name,'phone',p.phone,'idNumber',p.id_number,'seat',p.seat_number) ORDER BY p.seat_number)
               FROM passengers p WHERE p.booking_id=b.id) AS passengers
     FROM bookings b
     JOIN trips t ON t.id=b.trip_id
     JOIN routes r ON r.id=t.route_id
     JOIN operators o ON o.id=t.operator_id
     WHERE ${where}
     ORDER BY t.departure_at DESC`,
    params
  );
  return r.rows;
}

// Create booking + hold seats
router.post('/', wrap(async (req, res) => {
  const { tripId, seats, passengers } = req.body;
  if (!Array.isArray(seats) || !seats.length || seats.length > 6) return res.status(400).json({ error: 'Choose 1 to 6 seats' });
  if (!Array.isArray(passengers) || passengers.length !== seats.length) return res.status(400).json({ error: 'Add one passenger for each seat' });
  for (const p of passengers) {
    if (!p.fullName?.trim() || !p.phone?.trim() || !p.idNumber?.trim()) return res.status(400).json({ error: 'Fill in every passenger detail' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query("SELECT id, price FROM trips WHERE id=$1 AND departure_at > now() AND status='active'", [tripId]);
    if (!trip.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'This trip is no longer available' }); }
    const total = Number(trip.rows[0].price) * seats.length;
    const b = await client.query(
      `INSERT INTO bookings(user_id, trip_id, total_amount, hold_expires_at)
       VALUES($1,$2,$3, now() + ($4 || ' minutes')::interval) RETURNING id, hold_expires_at`,
      [req.user.id, tripId, total, String(HOLD_MIN)]
    );
    const booking = b.rows[0];
    const lock = await client.query(
      `UPDATE trip_seats SET status='held', held_by=$3, held_until=$4, booking_id=$5
       WHERE trip_id=$1 AND seat_number = ANY($2::int[])
         AND (status='available' OR (status='held' AND held_until < now()))
       RETURNING seat_number`,
      [tripId, seats, req.user.id, booking.hold_expires_at, booking.id]
    );
    if (lock.rowCount !== seats.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Someone just took one of those seats. Please choose again.' });
    }
    const d = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const ref = `MG${d}${String(booking.id).padStart(4, '0')}`;
    await client.query('UPDATE bookings SET ref=$1 WHERE id=$2', [ref, booking.id]);
    for (let i = 0; i < seats.length; i++) {
      const p = passengers[i];
      await client.query(
        'INSERT INTO passengers(booking_id, full_name, phone, id_number, seat_number) VALUES($1,$2,$3,$4,$5)',
        [booking.id, p.fullName.trim(), p.phone.trim(), p.idNumber.trim(), seats[i]]
      );
    }
    await client.query('COMMIT');
    res.status(201).json((await fetchBookings(req.user.id, { id: booking.id }))[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// Pay (MOCK). Replace chargeProvider() with the real Telebirr / CBE Birr call.
async function chargeProvider({ method, amount, phone, ref }) {
  return { success: true, txRef: `MOCK-${method}-${Date.now()}` };
}

router.post('/:id/pay', wrap(async (req, res) => {
  const { method, phone } = req.body;
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'Choose a payment method' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT * FROM bookings WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
    const booking = b.rows[0];
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }
    if (booking.status === 'confirmed') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already paid' }); }
    if (booking.status !== 'pending' || new Date(booking.hold_expires_at) < new Date()) {
      await client.query("UPDATE bookings SET status='expired' WHERE id=$1 AND status='pending'", [booking.id]);
      await client.query("UPDATE trip_seats SET status='available', held_by=NULL, held_until=NULL, booking_id=NULL WHERE booking_id=$1 AND status='held'", [booking.id]);
      await client.query('COMMIT');
      return res.status(410).json({ error: 'Your seat hold expired. Please choose seats again.' });
    }
    const charge = await chargeProvider({ method, amount: booking.total_amount, phone, ref: booking.ref });
    await client.query('INSERT INTO payments(booking_id, method, amount, status, tx_ref) VALUES($1,$2,$3,$4,$5)',
      [booking.id, method, booking.total_amount, charge.success ? 'success' : 'failed', charge.txRef]);
    if (!charge.success) { await client.query('COMMIT'); return res.status(402).json({ error: 'Payment failed. Try again.' }); }
    await client.query("UPDATE bookings SET status='confirmed', hold_expires_at=NULL WHERE id=$1", [booking.id]);
    await client.query("UPDATE trip_seats SET status='booked', held_until=NULL WHERE booking_id=$1", [booking.id]);
    await client.query('COMMIT');
    res.json((await fetchBookings(req.user.id, { id: booking.id }))[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

router.get('/', wrap(async (req, res) => {
  res.json(await fetchBookings(req.user.id, { status: req.query.status }));
}));

router.get('/:id', wrap(async (req, res) => {
  const rows = await fetchBookings(req.user.id, { id: req.params.id });
  if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  const b = await query(
    `UPDATE bookings SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status IN ('pending','confirmed') RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!b.rows.length) return res.status(404).json({ error: 'Booking cannot be cancelled' });
  await query("UPDATE trip_seats SET status='available', held_by=NULL, held_until=NULL, booking_id=NULL WHERE booking_id=$1", [req.params.id]);
  // TODO: refund logic for confirmed bookings
  res.json({ ok: true });
}));

module.exports = router;
