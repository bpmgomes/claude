CREATE TABLE businesses (
  id          TEXT PRIMARY KEY,                       -- UUID v4
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                          -- trim + NFC, até 100 code points
  slug        TEXT NOT NULL,                          -- já em minúsculas, ^[a-z0-9]+(-[a-z0-9]+)*$, 3 a 50
  address     TEXT NOT NULL,                          -- texto livre, trim + NFC, até 200 code points
  phone       TEXT NOT NULL,                          -- só dígitos, DDD + número (10 ou 11 dígitos)
  timezone    TEXT NOT NULL DEFAULT 'America/Sao_Paulo', -- IANA; usado por AF-10 e AF-23
  logo_key    TEXT,                                   -- chave no storage (ex.: logos/<uuid>.png); NULL = sem logo
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CONSTRAINT businesses_owner_id_unique UNIQUE (owner_id),
  CONSTRAINT businesses_slug_unique UNIQUE (slug)
);
CREATE INDEX businesses_logo_key_idx ON businesses(logo_key);
