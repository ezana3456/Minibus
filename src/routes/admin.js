const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { pool, query } = require('../db');
const { wrap, staffAuth, opScope } = require('../middleware');
const { hash, verify } = require('../passwords');
const { normPhone, validPhone } = require('../phone');

const TZ = `'Africa/Addis_Ababa'`;
const ALL = staffAuth();                       // any staff
const MANAGE = staffAuth('admin', 'operator'); // can change trips
const ADMIN = staffAuth('admin');              // you only

// ---------- login (with simple brute-force protection) ----------
const fails = new Map();
router.post('/login', wrap(async (req, res) => {
  const username = String(req.body.username || '').toLowerCase().trim();
  const key = `${req.ip}|${username}`;
  const f = fails.get(key);
  if (f && f.count >= 5 && Date.now() - f.last < 10 * 60e3) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  }
  const r = await query('SELECT * FROM staff_users WHERE username=$1 AND active=true', [username]);
  const u = r.rows[0];
  if (!u || !verify(String(req.body.password || ''), u.password_hash)) {
    fails.set(key, { count: (f?.count || 0) + 1, last: Date.now() });
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  fails.delete(key);
  const staff = { id: u.id, role: u.role, operatorId: u.operator_id, kind: 'staff' };
  res.json({
    token: jwt.sign(staff, process.env.JWT_SECRET, { expiresIn: '12h' }),
    user: { id: u.id, username: u.username, fullName: u.full_name, role: u.role, operatorId: u.operator_id },
  });
}));

router.get('/me', ALL, wrap(async (req, res) => {
  const r = await query(
    `SELECT s.id, s.username, s.full_name AS "fullName", s.role, s.operator_id AS "operatorId", o.name AS "operatorName", s.phone, s.email
     FROM staff_users s LEFT JOIN operators o ON o.id=s.operator_id WHERE s.id=$1`, [req.staff.id]);
  res.json(r.rows[0]);
}));

router.patch('/me', ALL, wrap(async (req, res) => {
  const fullName = String(req.body.fullName || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = req.body.phone ? normPhone(req.body.phone) : '';
  if (!fullName) return res.status(400).json({ error: 'Enter your name' });
  if (phone && !validPhone(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  await query('UPDATE staff_users SET full_name=$1, phone=$2, email=$3 WHERE id=$4', [fullName, phone || null, email || null, req.staff.id]);
  res.json({ ok: true });
}));

router.post('/me/password', ALL, wrap(async (req, res) => {
  const next = String(req.body.next || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const u = (await query('SELECT password_hash FROM staff_users WHERE id=$1', [req.staff.id])).rows[0];
  if (!verify(String(req.body.current || ''), u.password_hash)) return res.status(400).json({ error: 'Your current password is wrong' });
  await query('UPDATE staff_users SET password_hash=$1 WHERE id=$2', [hash(next), req.staff.id]);
  res.json({ ok: true });
}));

// ---------- dashboard ----------
router.get('/stats', MANAGE, wrap(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const scope = opScope(req);
  const summary = await query(
    `SELECT COUNT(*) FILTER (WHERE b.status='confirmed')::int AS bookings,
            COALESCE(SUM(b.total_amount) FILTER (WHERE b.status='confirmed'), 0)::float AS revenue,
            COALESCE((SELECT COUNT(*) FROM passengers p JOIN bookings b2 ON b2.id=p.booking_id JOIN trips t2 ON t2.id=b2.trip_id
                      WHERE b2.status='confirmed' AND ($1::int IS NULL OR t2.operator_id=$1)
                        AND b2.created_at > now() - ($2::text || ' days')::interval), 0)::int AS seats
     FROM bookings b JOIN trips t ON t.id=b.trip_id
     WHERE ($1::int IS NULL OR t.operator_id=$1) AND b.created_at > now() - ($2::text || ' days')::interval`,
    [scope, String(days)]);
  const daily = await query(
    `SELECT (b.created_at AT TIME ZONE ${TZ})::date::text AS day, COUNT(*)::int AS bookings, SUM(b.total_amount)::float AS revenue
     FROM bookings b JOIN trips t ON t.id=b.trip_id
     WHERE b.status='confirmed' AND ($1::int IS NULL OR t.operator_id=$1) AND b.created_at > now() - ($2::text || ' days')::interval
     GROUP BY 1 ORDER BY 1`, [scope, String(days)]);
  const routes = await query(
    `SELECT r.origin, r.destination, COUNT(*)::int AS bookings, SUM(b.total_amount)::float AS revenue
     FROM bookings b JOIN trips t ON t.id=b.trip_id JOIN routes r ON r.id=t.route_id
     WHERE b.status='confirmed' AND ($1::int IS NULL OR t.operator_id=$1) AND b.created_at > now() - ($2::text || ' days')::interval
     GROUP BY 1,2 ORDER BY revenue DESC LIMIT 5`, [scope, String(days)]);
  res.json({ ...summary.rows[0], daily: daily.rows, topRoutes: routes.rows });
}));

// ---------- operators & routes ----------
router.get('/operators', ALL, wrap(async (req, res) => {
  const scope = opScope(req);
  const r = await query('SELECT id, name, rating::float, reviews_count FROM operators WHERE ($1::int IS NULL OR id=$1) ORDER BY name', [scope]);
  res.json(r.rows);
}));

router.post('/operators', ADMIN, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Operator name is required' });
  const r = await query('INSERT INTO operators(name) VALUES($1) RETURNING id, name', [name]);
  res.status(201).json(r.rows[0]);
}));

router.get('/routes', ALL, wrap(async (req, res) => {
  res.json((await query('SELECT id, origin, destination, distance_km, duration_min, image_url FROM routes ORDER BY origin, destination')).rows);
}));

router.post('/routes', ADMIN, wrap(async (req, res) => {
  const origin = String(req.body.origin || '').trim();
  const destination = String(req.body.destination || '').trim();
  const km = Number(req.body.distanceKm), mins = Number(req.body.durationMin);
  if (!origin || !destination || origin.toLowerCase() === destination.toLowerCase() || !(km > 0) || !(mins > 0)) {
    return res.status(400).json({ error: 'Enter origin, destination, distance (km) and duration (minutes)' });
  }
  const pairs = [[origin, destination]];
  if (req.body.addReturn) pairs.push([destination, origin]);
  const imageFor = (dest) => `/images/routes/${dest.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`;
  let added = 0;
  for (const [o, d] of pairs) {
    const r = await query(
      'INSERT INTO routes(origin,destination,distance_km,duration_min,image_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT (origin,destination) DO NOTHING RETURNING id',
      [o, d, km, mins, imageFor(d)]);
    added += r.rowCount;
  }
  res.status(201).json({ added });
}));

router.patch('/routes/:id', ADMIN, wrap(async (req, res) => {
  const url = String(req.body.imageUrl || '').trim();
  if (url && !/^(\/images\/[\w\/.-]+|https:\/\/\S+)$/.test(url)) return res.status(400).json({ error: 'Use /images/routes/name.jpg or a full https:// link' });
  await query('UPDATE routes SET image_url=$1 WHERE id=$2', [url || null, req.params.id]);
  res.json({ ok: true });
}));

// ---------- trips ----------
const TRIP_SQL = `SELECT t.id, t.departure_at, t.arrival_at, t.price::float AS price, t.vehicle_type, t.total_seats, t.status,
    t.bus_number, t.driver_name, o.name AS operator, r.origin, r.destination, r.distance_km, r.duration_min,
    (SELECT COUNT(*) FROM trip_seats s WHERE s.trip_id=t.id AND s.status='booked')::int AS sold,
    (SELECT COUNT(*) FROM passengers p JOIN bookings b ON b.id=p.booking_id
       WHERE b.trip_id=t.id AND b.status='confirmed' AND p.boarded_at IS NOT NULL)::int AS boarded
  FROM trips t JOIN routes r ON r.id=t.route_id JOIN operators o ON o.id=t.operator_id`;

// GET /admin/trips?date=YYYY-MM-DD   or   ?range=today|upcoming|past
router.get('/trips', ALL, wrap(async (req, res) => {
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;
  const d = `(t.departure_at AT TIME ZONE ${TZ})::date`;
  let cond, order = 'ORDER BY t.departure_at', arg = date;
  if (req.query.range === 'upcoming') { cond = `${d} > $2::date AND ${d} <= ($2::date + 14)`; arg = today; }
  else if (req.query.range === 'past') { cond = `${d} < $2::date AND ${d} >= ($2::date - 14)`; arg = today; order = 'ORDER BY t.departure_at DESC'; }
  else cond = `${d} = $2::date`;
  const r = await query(`${TRIP_SQL} WHERE ($1::int IS NULL OR t.operator_id=$1) AND ${cond} ${order}`, [opScope(req), arg]);
  res.json(r.rows);
}));

router.get('/trips/:id(\\d+)', ALL, wrap(async (req, res) => {
  const r = await query(`${TRIP_SQL} WHERE t.id=$1 AND ($2::int IS NULL OR t.operator_id=$2)`, [req.params.id, opScope(req)]);
  if (!r.rows.length) return res.status(404).json({ error: 'Trip not found' });
  res.json(r.rows[0]);
}));

const parseAddis = (s) => new Date(/[+Z]/.test(String(s).slice(10)) ? s : `${s}${String(s).length === 16 ? ':00' : ''}+03:00`);

router.post('/trips', MANAGE, wrap(async (req, res) => {
  const b = req.body;
  const scope = opScope(req);
  const operatorId = scope ?? Number(b.operatorId);
  const price = Number(b.price), seats = Number(b.totalSeats), days = Math.floor(Number(b.days) || 1);
  const times = Array.isArray(b.times) ? b.times : [];
  if (!operatorId || !b.routeId) return res.status(400).json({ error: 'Choose a route and operator' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.startDate || '')) return res.status(400).json({ error: 'Choose a start date' });
  if (!(price > 0)) return res.status(400).json({ error: 'Enter a price' });
  if (!(seats >= 1 && seats <= 60)) return res.status(400).json({ error: 'Seats must be between 1 and 60' });
  if (days < 1 || days > 60) return res.status(400).json({ error: 'Days must be between 1 and 60' });
  if (!times.length || times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return res.status(400).json({ error: 'Enter times like 07:00, 15:30' });
  const route = (await query('SELECT duration_min FROM routes WHERE id=$1', [b.routeId])).rows[0];
  if (!route) return res.status(400).json({ error: 'Route not found' });

  const [y, m, d] = b.startDate.split('-').map(Number);
  const client = await pool.connect();
  let created = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    for (let i = 0; i < days; i++) {
      const day = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
      for (const t of times) {
        const dep = new Date(`${day}T${t}:00+03:00`);
        if (dep <= new Date()) { skipped++; continue; }
        const arr = new Date(dep.getTime() + route.duration_min * 60e3);
        const ins = await client.query(
          `INSERT INTO trips(route_id, operator_id, departure_at, arrival_at, price, vehicle_type, total_seats)
           SELECT $1,$2,$3,$4,$5,$6,$7
           WHERE NOT EXISTS (SELECT 1 FROM trips WHERE route_id=$1 AND operator_id=$2 AND departure_at=$3 AND status='active')
           RETURNING id`,
          [b.routeId, operatorId, dep, arr, price, String(b.vehicleType || 'Toyota Hiace'), seats]);
        if (!ins.rowCount) { skipped++; continue; }
        await client.query('INSERT INTO trip_seats(trip_id, seat_number) SELECT $1, generate_series(1,$2)', [ins.rows[0].id, seats]);
        created++;
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  res.status(201).json({ created, skipped });
}));

async function ownTrip(req, id) {
  const r = await query('SELECT * FROM trips WHERE id=$1 AND ($2::int IS NULL OR operator_id=$2)', [id, opScope(req)]);
  return r.rows[0];
}

router.patch('/trips/:id', MANAGE, wrap(async (req, res) => {
  const t = await ownTrip(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Trip not found' });
  if (t.status !== 'active') return res.status(400).json({ error: 'This trip is cancelled' });
  const price = req.body.price !== undefined ? Number(req.body.price) : Number(t.price);
  if (!(price > 0)) return res.status(400).json({ error: 'Enter a valid price' });
  let dep = new Date(t.departure_at), arr = new Date(t.arrival_at);
  if (req.body.departureAt) {
    const nd = parseAddis(req.body.departureAt);
    if (isNaN(nd) || nd <= new Date()) return res.status(400).json({ error: 'Choose a future time' });
    arr = new Date(nd.getTime() + (arr - dep));
    dep = nd;
  }
  const clean = (v, old) => (v === undefined ? old : String(v).trim().slice(0, 30) || null);
  await query('UPDATE trips SET price=$1, departure_at=$2, arrival_at=$3, bus_number=$4, driver_name=$5 WHERE id=$6',
    [price, dep, arr, clean(req.body.busNumber, t.bus_number), clean(req.body.driverName, t.driver_name), t.id]);
  // Price change only applies to NEW bookings. Existing bookings keep what they paid.
  res.json({ ok: true });
}));

router.post('/trips/:id/cancel', MANAGE, wrap(async (req, res) => {
  const t = await ownTrip(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Trip not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE trips SET status='cancelled' WHERE id=$1", [t.id]);
    const refunds = await client.query(
      `SELECT b.ref, b.total_amount::float AS amount, u.phone
       FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.trip_id=$1 AND b.status='confirmed'`, [t.id]);
    await client.query("UPDATE bookings SET status='cancelled' WHERE trip_id=$1 AND status IN ('pending','confirmed')", [t.id]);
    await client.query("UPDATE trip_seats SET status='available', held_by=NULL, held_until=NULL WHERE trip_id=$1 AND status='held'", [t.id]);
    await client.query('COMMIT');
    // TODO: send SMS to each phone below. Refunds must be done manually until payments are integrated.
    res.json({ ok: true, refundsDue: refunds.rows });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

router.get('/trips/:id/passengers', ALL, wrap(async (req, res) => {
  const t = await ownTrip(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Trip not found' });
  const r = await query(
    `SELECT p.id, p.seat_number, p.full_name, p.phone, p.id_number, (p.boarded_at IS NOT NULL) AS boarded, b.ref
     FROM passengers p JOIN bookings b ON b.id=p.booking_id
     WHERE b.trip_id=$1 AND b.status='confirmed' ORDER BY p.seat_number`, [t.id]);
  res.json(r.rows);
}));

// ---------- bookings ----------
router.get('/bookings', MANAGE, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const r = await query(
    `SELECT b.id, b.ref, b.status, b.total_amount::float AS total_amount, b.created_at, t.departure_at,
            r.origin, r.destination, o.name AS operator, u.phone AS user_phone,
            (SELECT json_agg(json_build_object('fullName',p.full_name,'phone',p.phone,'seat',p.seat_number,'boarded',p.boarded_at IS NOT NULL) ORDER BY p.seat_number)
               FROM passengers p WHERE p.booking_id=b.id) AS passengers
     FROM bookings b JOIN trips t ON t.id=b.trip_id JOIN routes r ON r.id=t.route_id
     JOIN operators o ON o.id=t.operator_id JOIN users u ON u.id=b.user_id
     WHERE b.status <> 'pending' AND ($1::int IS NULL OR t.operator_id=$1)
       AND ($2::text = '' OR b.ref ILIKE '%'||$2||'%' OR u.phone ILIKE '%'||$2||'%'
            OR EXISTS (SELECT 1 FROM passengers p WHERE p.booking_id=b.id AND (p.full_name ILIKE '%'||$2||'%' OR p.phone ILIKE '%'||$2||'%')))
     ORDER BY b.created_at DESC LIMIT 100`, [opScope(req), q]);
  res.json(r.rows);
}));

// ---------- ticket scanning ----------
async function findByRef(req, ref) {
  const r = await query(
    `SELECT b.id, b.ref, b.status, t.status AS trip_status, t.departure_at, r.origin, r.destination, o.name AS operator,
            (SELECT json_agg(json_build_object('fullName',p.full_name,'phone',p.phone,'idNumber',p.id_number,'seat',p.seat_number,'boarded',p.boarded_at IS NOT NULL) ORDER BY p.seat_number)
               FROM passengers p WHERE p.booking_id=b.id) AS passengers
     FROM bookings b JOIN trips t ON t.id=b.trip_id JOIN routes r ON r.id=t.route_id JOIN operators o ON o.id=t.operator_id
     WHERE b.ref=$1 AND ($2::int IS NULL OR t.operator_id=$2)`, [String(ref).trim().toUpperCase(), opScope(req)]);
  return r.rows[0];
}

router.get('/scan/:ref', ALL, wrap(async (req, res) => {
  const b = await findByRef(req, req.params.ref);
  if (!b) return res.status(404).json({ error: 'Ticket not found for your company' });
  let problem = null;
  if (b.status !== 'confirmed') problem = `This booking is ${b.status}. Do not allow boarding.`;
  else if (b.trip_status !== 'active') problem = 'This trip was cancelled.';
  else if (Math.abs(new Date(b.departure_at) - Date.now()) > 24 * 3600e3) problem = 'This ticket is for a different day.';
  res.json({ booking: b, problem, allBoarded: (b.passengers || []).every((p) => p.boarded) });
}));

router.post('/scan/:ref/board', ALL, wrap(async (req, res) => {
  const b = await findByRef(req, req.params.ref);
  if (!b) return res.status(404).json({ error: 'Ticket not found for your company' });
  if (b.status !== 'confirmed' || b.trip_status !== 'active') return res.status(400).json({ error: 'This ticket is not valid' });
  const r = await query('UPDATE passengers SET boarded_at=now() WHERE booking_id=$1 AND boarded_at IS NULL RETURNING id', [b.id]);
  res.json({ ok: true, boarded: r.rowCount });
}));

// ---------- staff accounts ----------
router.get('/staff', ADMIN, wrap(async (req, res) => {
  const r = await query(
    `SELECT s.id, s.username, s.full_name AS "fullName", s.role, s.active, s.phone, o.name AS operator
     FROM staff_users s LEFT JOIN operators o ON o.id=s.operator_id ORDER BY s.id`);
  res.json(r.rows);
}));

router.post('/staff', ADMIN, wrap(async (req, res) => {
  const username = String(req.body.username || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const role = req.body.role;
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username: 3-30 letters, numbers, . _ -' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!['operator', 'scanner', 'admin'].includes(role)) return res.status(400).json({ error: 'Choose a role' });
  if (role !== 'admin' && !req.body.operatorId) return res.status(400).json({ error: 'Choose the operator this person works for' });
  try {
    await query('INSERT INTO staff_users(username, password_hash, full_name, role, operator_id, phone) VALUES($1,$2,$3,$4,$5,$6)',
      [username, hash(password), req.body.fullName || username, role, role === 'admin' ? null : req.body.operatorId, req.body.phone ? normPhone(req.body.phone) : null]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    throw e;
  }
  res.status(201).json({ ok: true });
}));

router.post('/staff/:id/toggle', ADMIN, wrap(async (req, res) => {
  if (Number(req.params.id) === req.staff.id) return res.status(400).json({ error: 'You cannot disable your own account' });
  await query('UPDATE staff_users SET active = NOT active WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

router.post('/staff/:id/password', ADMIN, wrap(async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const r = await query('UPDATE staff_users SET password_hash=$1 WHERE id=$2 RETURNING id', [hash(pw), req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Account not found' });
  res.json({ ok: true });
}));

// ---------- mark one passenger boarded / undo ----------
router.post('/passengers/:id/board', ALL, wrap(async (req, res) => {
  const boarded = req.body.boarded !== false;
  const r = await query(
    `UPDATE passengers p SET boarded_at = CASE WHEN $2::boolean THEN COALESCE(p.boarded_at, now()) ELSE NULL END
     FROM bookings b JOIN trips t ON t.id=b.trip_id
     WHERE p.id=$1 AND b.id=p.booking_id AND b.status='confirmed' AND ($3::int IS NULL OR t.operator_id=$3)
     RETURNING p.id`, [req.params.id, boarded, opScope(req)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Passenger not found' });
  res.json({ ok: true });
}));

// ---------- sell a seat at the station (cash) ----------
router.post('/trips/:id/walkup', ALL, wrap(async (req, res) => {
  const t = await ownTrip(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Trip not found' });
  if (t.status !== 'active') return res.status(400).json({ error: 'This trip is cancelled' });
  if (new Date(t.departure_at) < new Date(Date.now() - 60 * 60e3)) return res.status(400).json({ error: 'This trip already left' });
  const fullName = String(req.body.fullName || '').trim();
  const phone = normPhone(req.body.phone);
  const idNumber = String(req.body.idNumber || '').trim() || '-';
  const seat = Number(req.body.seat);
  if (!fullName) return res.status(400).json({ error: 'Enter the passenger name' });
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
  if (!Number.isInteger(seat) || seat < 1) return res.status(400).json({ error: 'Choose a seat' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      `INSERT INTO users(phone, full_name) VALUES($1,$2)
       ON CONFLICT (phone) DO UPDATE SET full_name = COALESCE(users.full_name, EXCLUDED.full_name) RETURNING id`, [phone, fullName]);
    const b = await client.query(
      `INSERT INTO bookings(user_id, trip_id, total_amount, status, sold_by_staff_id) VALUES($1,$2,$3,'confirmed',$4) RETURNING id`,
      [u.rows[0].id, t.id, t.price, req.staff.id]);
    const id = b.rows[0].id;
    const lock = await client.query(
      `UPDATE trip_seats SET status='booked', held_by=NULL, held_until=NULL, booking_id=$3
       WHERE trip_id=$1 AND seat_number=$2 AND (status='available' OR (status='held' AND held_until < now())) RETURNING id`,
      [t.id, seat, id]);
    if (!lock.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'That seat is already taken' }); }
    const day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const ref = `MG${day}${String(id).padStart(4, '0')}`;
    await client.query('UPDATE bookings SET ref=$1 WHERE id=$2', [ref, id]);
    await client.query('INSERT INTO passengers(booking_id, full_name, phone, id_number, seat_number) VALUES($1,$2,$3,$4,$5)', [id, fullName, phone, idNumber, seat]);
    await client.query("INSERT INTO payments(booking_id, method, amount, status, tx_ref) VALUES($1,'cash',$2,'success',$3)", [id, t.price, `CASH-${req.staff.id}-${Date.now()}`]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, ref, seat, amount: Number(t.price) });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

// ---------- messages to staff ----------
router.get('/messages', ALL, wrap(async (req, res) => {
  const r = await query(
    `SELECT m.id, m.kind, m.title, m.body, m.created_at, o.name AS operator, (rd.staff_id IS NOT NULL) AS read
     FROM staff_messages m
     LEFT JOIN operators o ON o.id=m.operator_id
     LEFT JOIN staff_message_reads rd ON rd.message_id=m.id AND rd.staff_id=$1
     WHERE ($2::int IS NULL OR m.operator_id IS NULL OR m.operator_id=$2)
     ORDER BY m.created_at DESC LIMIT 100`, [req.staff.id, opScope(req)]);
  res.json(r.rows);
}));

router.get('/messages/unread', ALL, wrap(async (req, res) => {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM staff_messages m
     WHERE ($2::int IS NULL OR m.operator_id IS NULL OR m.operator_id=$2)
       AND NOT EXISTS (SELECT 1 FROM staff_message_reads rd WHERE rd.message_id=m.id AND rd.staff_id=$1)`, [req.staff.id, opScope(req)]);
  res.json({ unread: r.rows[0].n });
}));

router.post('/messages/read', ALL, wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  await query(
    `INSERT INTO staff_message_reads(staff_id, message_id)
     SELECT $1, m.id FROM staff_messages m
     WHERE ($3::int IS NULL OR m.operator_id IS NULL OR m.operator_id=$3) AND ($2::int[] = '{}' OR m.id = ANY($2::int[]))
     ON CONFLICT DO NOTHING`, [req.staff.id, ids, opScope(req)]);
  res.json({ ok: true });
}));

router.post('/messages', MANAGE, wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  const kind = ['operations', 'support', 'system', 'driver'].includes(req.body.kind) ? req.body.kind : 'operations';
  if (!title || title.length > 80) return res.status(400).json({ error: 'Enter a short title (up to 80 characters)' });
  if (body.length > 500) return res.status(400).json({ error: 'Message is too long (500 characters max)' });
  const scope = opScope(req); // operators can only write to their own company
  const operatorId = scope ?? (req.body.operatorId ? Number(req.body.operatorId) : null);
  await query('INSERT INTO staff_messages(operator_id, kind, title, body, created_by) VALUES($1,$2,$3,$4,$5)', [operatorId, kind, title, body, req.staff.id]);
  res.status(201).json({ ok: true });
}));

router.delete('/messages/:id', MANAGE, wrap(async (req, res) => {
  const r = await query('DELETE FROM staff_messages WHERE id=$1 AND ($2::int IS NULL OR operator_id=$2) RETURNING id', [req.params.id, opScope(req)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Message not found' });
  res.json({ ok: true });
}));

module.exports = router;
