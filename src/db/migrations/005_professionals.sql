-- Necessário para a FK composta (service_id, business_id). Portável: o PostgreSQL aceita
-- FK para colunas cobertas por índice único não parcial.
CREATE UNIQUE INDEX services_id_business_id_unique ON services(id, business_id);

CREATE TABLE professionals (
  id           TEXT PRIMARY KEY,                    -- UUID v4
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                       -- trim + NFC, até 100 code points, como digitado
  name_key     TEXT NOT NULL,                       -- textKey(name); NÃO é único (homônimos, decisão 4)
  photo_key    TEXT,                                -- professionals/<uuid>.png; NULL = sem foto
  removed_at   TEXT,                                -- NULL = ativo; remoção lógica (decisão 3)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CONSTRAINT professionals_id_business_id_unique UNIQUE (id, business_id),
  CONSTRAINT professionals_removed_photo_check CHECK (removed_at IS NULL OR photo_key IS NULL)
);
CREATE INDEX professionals_business_id_removed_at_idx ON professionals(business_id, removed_at, name_key);
CREATE INDEX professionals_photo_key_idx ON professionals(photo_key);

CREATE TABLE professional_services (
  professional_id  TEXT NOT NULL,
  service_id       TEXT NOT NULL,
  business_id      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (professional_id, service_id),
  FOREIGN KEY (professional_id, business_id) REFERENCES professionals(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (service_id, business_id) REFERENCES services(id, business_id) ON DELETE CASCADE
);
CREATE INDEX professional_services_business_id_service_id_idx ON professional_services(business_id, service_id);
