DROP TABLE IF EXISTS staff_message_reads, staff_messages, staff_users, payments, passengers, bookings, trip_seats, trips, routes, operators, otps, users CASCADE;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE otps (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE operators (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  rating NUMERIC(2,1) DEFAULT 4.5,
  reviews_count INT DEFAULT 0
);

CREATE TABLE routes (
  id SERIAL PRIMARY KEY,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  distance_km INT,
  duration_min INT,
  image_url TEXT,
  UNIQUE (origin, destination)
);

CREATE TABLE trips (
  id SERIAL PRIMARY KEY,
  route_id INT NOT NULL REFERENCES routes(id),
  operator_id INT NOT NULL REFERENCES operators(id),
  departure_at TIMESTAMPTZ NOT NULL,
  arrival_at TIMESTAMPTZ NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'Toyota Hiace',
  total_seats INT NOT NULL DEFAULT 14,
  status TEXT NOT NULL DEFAULT 'active', -- active | cancelled
  bus_number TEXT,
  driver_name TEXT
);
CREATE INDEX trips_search_idx ON trips (route_id, departure_at);

CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  ref TEXT UNIQUE,
  user_id INT NOT NULL REFERENCES users(id),
  trip_id INT NOT NULL REFERENCES trips(id),
  total_amount NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled | expired
  hold_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE trip_seats (
  id SERIAL PRIMARY KEY,
  trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seat_number INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', -- available | held | booked
  held_by INT REFERENCES users(id),
  held_until TIMESTAMPTZ,
  booking_id INT REFERENCES bookings(id),
  UNIQUE (trip_id, seat_number)
);

CREATE TABLE passengers (
  id SERIAL PRIMARY KEY,
  booking_id INT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  id_number TEXT NOT NULL,
  seat_number INT NOT NULL,
  boarded_at TIMESTAMPTZ
);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  booking_id INT NOT NULL REFERENCES bookings(id),
  method TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL, -- success | failed
  tx_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Admin panel accounts: admin (you), operator (one company), scanner (station staff)
CREATE TABLE staff_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','operator','scanner')),
  operator_id INT REFERENCES operators(id),
  phone TEXT,
  email TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- bookings sold at the station (cash) remember who sold them
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sold_by_staff_id INT REFERENCES staff_users(id);

-- notices from admin/operators to station staff (operator_id NULL = everyone)
CREATE TABLE IF NOT EXISTS staff_messages (
  id SERIAL PRIMARY KEY,
  operator_id INT REFERENCES operators(id),
  kind TEXT NOT NULL DEFAULT 'operations', -- operations | support | system | driver
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_by INT REFERENCES staff_users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS staff_message_reads (
  staff_id INT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  message_id INT NOT NULL REFERENCES staff_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, message_id)
);
