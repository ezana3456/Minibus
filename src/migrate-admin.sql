ALTER TABLE trips ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE passengers ADD COLUMN IF NOT EXISTS boarded_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS staff_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','operator','scanner')),
  operator_id INT REFERENCES operators(id),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- route photos (served from backend/public/images/routes/<city>.jpg)
ALTER TABLE routes ADD COLUMN IF NOT EXISTS image_url TEXT;
UPDATE routes SET image_url = '/images/routes/' || trim(both '-' from lower(regexp_replace(destination, '[^a-zA-Z0-9]+', '-', 'g'))) || '.jpg' WHERE image_url IS NULL;

-- staff app: bus/driver on trips, staff contact details
ALTER TABLE trips ADD COLUMN IF NOT EXISTS bus_number TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS driver_name TEXT;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS email TEXT;

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
