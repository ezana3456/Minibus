const router = require('express').Router();
const { query } = require('../db');
const { wrap } = require('../middleware');

const TZ = `'Africa/Addis_Ababa'`;

router.get('/routes/popular', wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 50);
  // Most booked routes in the last 30 days first; routes with no bookings yet follow in id order.
  const r = await query(
    `SELECT r.id, r.origin, r.destination, r.image_url, MIN(t.price)::float AS min_price,
            (SELECT COUNT(*) FROM bookings b JOIN trips t2 ON t2.id=b.trip_id
              WHERE t2.route_id=r.id AND b.status='confirmed' AND b.created_at > now() - interval '30 days')::int AS recent_bookings
     FROM routes r JOIN trips t ON t.route_id=r.id AND t.departure_at > now() AND t.status='active'
     GROUP BY r.id ORDER BY recent_bookings DESC, r.id LIMIT $1`, [limit]);
  res.json(r.rows);
}));

// GET /api/trips?from=Addis Ababa&to=Bahir Dar&date=2026-10-20&period=all|morning|afternoon|evening
router.get('/trips', wrap(async (req, res) => {
  const { from, to, date, period } = req.query;
  if (!from || !to || !date) return res.status(400).json({ error: 'from, to and date are required' });
  const route = await query('SELECT * FROM routes WHERE lower(origin)=lower($1) AND lower(destination)=lower($2)', [from, to]);
  const p = ['morning', 'afternoon', 'evening'].includes(period) ? period : null;
  const trips = await query(
    `SELECT t.id, t.departure_at, t.arrival_at, t.price::float AS price, t.vehicle_type, t.total_seats,
            o.name AS operator, o.rating::float AS rating, o.reviews_count,
            (SELECT count(*) FROM trip_seats s WHERE s.trip_id=t.id
               AND (s.status='available' OR (s.status='held' AND s.held_until < now())))::int AS seats_left
     FROM trips t
     JOIN routes r ON r.id=t.route_id
     JOIN operators o ON o.id=t.operator_id
     WHERE r.id = $1
       AND (t.departure_at AT TIME ZONE ${TZ})::date = $2::date
       AND t.departure_at > now()
       AND t.status = 'active'
       AND ($3::text IS NULL OR (CASE
             WHEN extract(hour FROM t.departure_at AT TIME ZONE ${TZ}) < 12 THEN 'morning'
             WHEN extract(hour FROM t.departure_at AT TIME ZONE ${TZ}) < 17 THEN 'afternoon'
             ELSE 'evening' END) = $3)
     ORDER BY t.departure_at`,
    [route.rows[0]?.id || 0, date, p]
  );
  res.json({ route: route.rows[0] || null, trips: trips.rows });
}));

// GET /api/trips/prices?from&to&start=YYYY-MM-DD&days=14  -> lowest price per day (null = no trips)
router.get('/trips/prices', wrap(async (req, res) => {
  const { from, to, start } = req.query;
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 31);
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(start || '')) return res.status(400).json({ error: 'from, to and start are required' });
  const route = await query('SELECT id FROM routes WHERE lower(origin)=lower($1) AND lower(destination)=lower($2)', [from, to]);
  const found = new Map();
  if (route.rows[0]) {
    const r = await query(
      `SELECT (t.departure_at AT TIME ZONE ${TZ})::date::text AS date, MIN(t.price)::float AS min_price, COUNT(*)::int AS trips
       FROM trips t WHERE t.route_id=$1 AND t.status='active' AND t.departure_at > now()
         AND (t.departure_at AT TIME ZONE ${TZ})::date BETWEEN $2::date AND ($2::date + ($3::int - 1))
       GROUP BY 1`, [route.rows[0].id, start, days]);
    r.rows.forEach((x) => found.set(x.date, x));
  }
  const [y, m, d] = start.split('-').map(Number);
  res.json(Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    return found.get(date) || { date, min_price: null, trips: 0 };
  }));
}));

router.get('/trips/:id/seats', wrap(async (req, res) => {
  const trip = await query(
    `SELECT t.id, t.departure_at, t.arrival_at, t.price::float AS price, t.vehicle_type, t.total_seats,
            o.name AS operator, r.origin, r.destination
     FROM trips t JOIN routes r ON r.id=t.route_id JOIN operators o ON o.id=t.operator_id WHERE t.id=$1`,
    [req.params.id]
  );
  if (!trip.rows.length) return res.status(404).json({ error: 'Trip not found' });
  const seats = await query(
    `SELECT seat_number,
            CASE WHEN status='booked' THEN 'booked'
                 WHEN status='held' AND held_until > now() THEN 'booked'
                 ELSE 'available' END AS status
     FROM trip_seats WHERE trip_id=$1 ORDER BY seat_number`,
    [req.params.id]
  );
  res.json({ trip: trip.rows[0], seats: seats.rows });
}));

module.exports = router;
