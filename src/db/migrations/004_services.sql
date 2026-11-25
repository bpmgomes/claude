CREATE TABLE services (
  id                TEXT PRIMARY KEY,                    -- UUID v4
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,                       -- trim + NFC, até 100 code points, como digitado
  name_key          TEXT NOT NULL,                       -- serviceNameKey(name): sem acentos, minúsculas, espaços colapsados
  duration_minutes  INTEGER NOT NULL,
  price_cents       INTEGER,                             -- NULL só quando price_on_request = 1
  price_on_request  INTEGER NOT NULL DEFAULT 0,          -- 0/1
  active            INTEGER NOT NULL DEFAULT 1,          -- 0/1; contrato para AF-09, AF-10, AF-11
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CONSTRAINT services_duration_check
    CHECK (duration_minutes BETWEEN 15 AND 480 AND duration_minutes % 15 = 0),
  CONSTRAINT services_price_range_check
    CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 9999999),
  CONSTRAINT services_flags_check
    CHECK (price_on_request IN (0, 1) AND active IN (0, 1)),
  CONSTRAINT services_price_state_check
    CHECK ((price_on_request = 1 AND price_cents IS NULL) OR (price_on_request = 0 AND price_cents IS NOT NULL)),
  CONSTRAINT services_business_id_name_key_unique UNIQUE (business_id, name_key)
);
CREATE INDEX services_business_id_active_idx ON services(business_id, active, name_key);
