const { pool } = require('../db');

const operators = [
  { name: 'Selam Minibus', rating: 4.7, reviews: 1200, vehicle: 'Toyota Hiace', seats: 14, times: ['07:00', '15:00'], extra: 0 },
  { name: 'Abay Transport', rating: 4.5, reviews: 856, vehicle: 'Toyota Hiace', seats: 14, times: ['08:30', '18:00'], extra: 20 },
  { name: 'Blue Nile Express', rating: 4.3, reviews: 642, vehicle: 'Toyota Coaster', seats: 28, times: ['10:00', '13:30'], extra: 50 },
];
// origin, destination, km, minutes, base price (ETB)
const routes = [
  ['Addis Ababa', 'Bahir Dar', 350, 390, 350],
  ['Addis Ababa', 'Hawassa', 275, 270, 300],
  ['Addis Ababa', 'Shashamane', 250, 240, 280],
  ['Addis Ababa', 'Dire Dawa', 515, 480, 500],
  ['Addis Ababa', 'Adama', 100, 90, 120],
  ['Bahir Dar', 'Addis Ababa', 350, 390, 350],
  ['Hawassa', 'Addis Ababa', 275, 270, 300],
  ['Shashamane', 'Addis Ababa', 250, 240, 280],
];

(async () => {
  const addisNow = new Date(Date.now() + 3 * 3600e3);
  for (const o of operators) {
    const r = await pool.query('INSERT INTO operators(name,rating,reviews_count) VALUES($1,$2,$3) RETURNING id', [o.name, o.rating, o.reviews]);
    o.id = r.rows[0].id;
  }
  for (const [origin, destination, km, mins, price] of routes) {
    const slug = destination.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const r = await pool.query('INSERT INTO routes(origin,destination,distance_km,duration_min,image_url) VALUES($1,$2,$3,$4,$5) RETURNING id', [origin, destination, km, mins, `/images/routes/${slug}.jpg`]);
    const routeId = r.rows[0].id;
    for (let d = 0; d < 21; d++) {
      const day = new Date(addisNow.getTime() + d * 86400e3).toISOString().slice(0, 10);
      for (const o of operators) {
        for (const t of o.times) {
          const dep = new Date(`${day}T${t}:00+03:00`);
          const arr = new Date(dep.getTime() + mins * 60e3);
          const trip = await pool.query(
            `INSERT INTO trips(route_id,operator_id,departure_at,arrival_at,price,vehicle_type,total_seats)
             VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [routeId, o.id, dep, arr, price + o.extra, o.vehicle, o.seats]
          );
          await pool.query('INSERT INTO trip_seats(trip_id,seat_number) SELECT $1, generate_series(1,$2)', [trip.rows[0].id, o.seats]);
        }
      }
    }
  }
  console.log('Seeded operators, routes, and 3 weeks of trips.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
