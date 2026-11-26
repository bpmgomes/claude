-- AF-12: antecedência de cancelamento/remarcação, token de gerenciar (só o hash) e cadeia de
-- remarcações. Instantes UTC ISO de 24 caracteres, como em 010.

-- Antecedência do negócio (critério 1). Negócios existentes passam a valer 120 min sem preencher nada.
-- O CHECK de ADD COLUMN é verificado contra as linhas existentes (todas recebem o DEFAULT).
ALTER TABLE businesses ADD COLUMN cancellation_lead_minutes INTEGER NOT NULL DEFAULT 120
  CONSTRAINT businesses_cancellation_lead_minutes_check
  CHECK (typeof(cancellation_lead_minutes) = 'integer'
         AND cancellation_lead_minutes BETWEEN 0 AND 4320
         AND cancellation_lead_minutes % 15 = 0);

-- Token de gerenciar (critério 5). Só o SHA-256 em hex: o texto puro nunca é gravado. Mais de um
-- token ativo por agendamento é permitido (repetição idempotente do AF-11, decisão 3); todos são
-- revogados juntos ao cancelar e movidos juntos ao remarcar (decisão 4).
CREATE TABLE appointment_manage_tokens (
  token_hash      TEXT NOT NULL PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,                       -- = ends_at do agendamento apontado
  revoked_at      TEXT,
  revoked_reason  TEXT,
  FOREIGN KEY (appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  CONSTRAINT appointment_manage_tokens_hash_check
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT appointment_manage_tokens_instants_check
    CHECK (length(created_at) = 24 AND length(expires_at) = 24 AND created_at < expires_at),
  CONSTRAINT appointment_manage_tokens_revoked_check
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)
           AND (revoked_reason IS NULL OR revoked_reason IN ('cancelled', 'rescheduled')))
);
-- Revogar e mover os tokens de um agendamento.
CREATE INDEX appointment_manage_tokens_business_id_appointment_id_idx
  ON appointment_manage_tokens(business_id, appointment_id);
-- Purga dos vencidos há mais de 30 dias (critério 7).
CREATE INDEX appointment_manage_tokens_expires_at_idx ON appointment_manage_tokens(expires_at);

-- Cadeia de remarcações (decisão 7: no máximo 3 por cadeia). Um elo por agendamento remarcado:
-- a PK em previous_appointment_id garante, no banco, que um agendamento é remarcado no máximo uma
-- vez (rede atrás do changes === 1). `sequence` é a posição do NOVO na cadeia (1 = primeira remarcação).
CREATE TABLE appointment_reschedules (
  business_id              TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  previous_appointment_id  TEXT NOT NULL PRIMARY KEY,
  appointment_id           TEXT NOT NULL,
  sequence                 INTEGER NOT NULL,
  created_at               TEXT NOT NULL,
  CONSTRAINT appointment_reschedules_appointment_id_unique UNIQUE (appointment_id),
  FOREIGN KEY (previous_appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  CONSTRAINT appointment_reschedules_sequence_check CHECK (sequence BETWEEN 1 AND 3),
  CONSTRAINT appointment_reschedules_distinct_check CHECK (previous_appointment_id <> appointment_id),
  CONSTRAINT appointment_reschedules_created_at_check CHECK (length(created_at) = 24)
);
