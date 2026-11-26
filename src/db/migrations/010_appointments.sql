-- AF-11: agendamento do cliente final. Instantes UTC ISO de 24 caracteres, intervalo semiaberto
-- [starts_at, ends_at). Os snapshots (customer_*, service_*) são imutáveis: editar o serviço ou o
-- cliente depois não altera o agendamento (AF-04 decisão 1, AF-06). O nome do profissional vem
-- por JOIN (a remoção é lógica e é bloqueada com agendamentos futuros).
CREATE TABLE appointments (
  id                TEXT NOT NULL PRIMARY KEY,          -- UUID v4; nunca sai em rota pública
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  professional_id   TEXT NOT NULL,
  customer_id       TEXT NOT NULL,
  service_id        TEXT NOT NULL,
  service_name      TEXT NOT NULL,                      -- snapshot
  duration_minutes  INTEGER NOT NULL,                   -- snapshot
  price_cents       INTEGER,                            -- snapshot; NULL = sob consulta
  customer_name     TEXT NOT NULL,                      -- snapshot do AF-04 (trim + NFC)
  customer_phone    TEXT NOT NULL,                      -- snapshot do AF-04 (só dígitos)
  starts_at         TEXT NOT NULL,
  ends_at           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  cancelled_at      TEXT,
  CONSTRAINT appointments_id_business_id_unique UNIQUE (id, business_id),
  FOREIGN KEY (professional_id, business_id) REFERENCES professionals(id, business_id),
  FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id),
  FOREIGN KEY (service_id, business_id) REFERENCES services(id, business_id),
  CONSTRAINT appointments_status_check
    CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  CONSTRAINT appointments_cancelled_at_check
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT appointments_instants_check
    CHECK (length(starts_at) = 24 AND length(ends_at) = 24 AND starts_at < ends_at),
  CONSTRAINT appointments_duration_check
    CHECK (duration_minutes BETWEEN 15 AND 480 AND duration_minutes % 15 = 0),
  -- ends_at = starts_at + duração, conferido no banco (SQLite: strftime é determinístico sem 'now').
  CONSTRAINT appointments_ends_at_check
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+' || duration_minutes || ' minutes') IS NOT NULL
           AND ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+' || duration_minutes || ' minutes')),
  CONSTRAINT appointments_price_check CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 9999999),
  CONSTRAINT appointments_customer_phone_check CHECK (length(customer_phone) IN (10, 11)),
  CONSTRAINT appointments_customer_name_check CHECK (length(customer_name) >= 2)
);

-- findBusyByBusiness, findConflictsForBlock, contagens do dia e futuros (AF-10 4.5).
CREATE INDEX appointments_business_id_starts_at_idx ON appointments(business_id, starts_at);
-- Trigger de sobreposição e futuros do profissional: só não cancelados, por fim.
CREATE INDEX appointments_business_id_professional_id_ends_at_active_idx
  ON appointments(business_id, professional_id, ends_at) WHERE status <> 'cancelled';
-- Rede mínima portátil (mesmo início, mesmo profissional). O nome segue a convenção que o
-- translateError reconstrói: appointments_professional_id_starts_at_unique.
CREATE UNIQUE INDEX appointments_professional_id_starts_at_unique
  ON appointments(professional_id, starts_at) WHERE status <> 'cancelled';
-- Limite por cliente (critério 42) e histórico do AF-14.
CREATE INDEX appointments_business_id_customer_id_starts_at_idx ON appointments(business_id, customer_id, starts_at);
CREATE INDEX appointments_business_id_customer_phone_starts_at_idx ON appointments(business_id, customer_phone, starts_at);

-- Garantia de não sobreposição (critério 21). Vale contra qualquer INSERT/UPDATE, inclusive os que
-- não passam pelo serviço. Encostados ([10:00, 11:00) e [11:00, 12:00)) não se intersectam.
-- Filtra só por professional_id (único no sistema): um business_id falso, gravado com
-- foreign_keys desligado, não escapa da checagem (QA AF-11, F4).
CREATE TRIGGER appointments_no_overlap_insert
BEFORE INSERT ON appointments
WHEN NEW.status <> 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'appointments_no_overlap')
   WHERE EXISTS (
     SELECT 1 FROM appointments a
      WHERE a.professional_id = NEW.professional_id
        AND a.status <> 'cancelled'
        AND a.ends_at > NEW.starts_at AND a.starts_at < NEW.ends_at);
END;

CREATE TRIGGER appointments_no_overlap_update
BEFORE UPDATE OF professional_id, starts_at, ends_at, status ON appointments
WHEN NEW.status <> 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'appointments_no_overlap')
   WHERE EXISTS (
     SELECT 1 FROM appointments a
      WHERE a.id <> NEW.id
        AND a.professional_id = NEW.professional_id
        AND a.status <> 'cancelled'
        AND a.ends_at > NEW.starts_at AND a.starts_at < NEW.ends_at);
END;

-- Idempotency-Key (critério 25, decisão 7). A resposta guardada é o corpo do 201, que não tem
-- dado do cliente (4.1). Expira em 24 h; purga oportunista na reserva e no boot.
CREATE TABLE booking_idempotency_keys (
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL,                       -- UUID v4 em minúsculas
  request_hash     TEXT NOT NULL,                       -- sha256 hex do corpo normalizado
  appointment_id   TEXT NOT NULL,
  response_body    TEXT NOT NULL,                       -- JSON do 201
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  PRIMARY KEY (business_id, idempotency_key),
  FOREIGN KEY (appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  CONSTRAINT booking_idempotency_keys_shape_check
    CHECK (length(idempotency_key) = 36 AND length(request_hash) = 64 AND created_at < expires_at)
);
CREATE INDEX booking_idempotency_keys_expires_at_idx ON booking_idempotency_keys(expires_at);
