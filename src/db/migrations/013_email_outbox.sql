-- AF-18: fila transacional de e-mails (outbox). Só ids e controle: nenhuma coluna guarda e-mail,
-- nome, telefone, token, link, assunto ou corpo (critério 1). Instantes UTC ISO de 24 caracteres.
-- A linha nasce na MESMA transação que muda o agendamento, só por enqueueEmail (critério 6).
CREATE TABLE email_outbox (
  id                       TEXT NOT NULL PRIMARY KEY,          -- UUID v4; usado no Message-ID
  business_id              TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL,
  appointment_id           TEXT NOT NULL,                       -- rescheduled: o NOVO agendamento
  previous_appointment_id  TEXT,                                -- só em appointment_rescheduled
  status                   TEXT NOT NULL DEFAULT 'pending',
  attempts                 INTEGER NOT NULL DEFAULT 0,          -- reivindicações para envio (até 5 envios)
  next_attempt_at          TEXT NOT NULL,
  locked_until             TEXT,                                -- arrendamento; só em 'sending'
  last_error_code          TEXT,                                -- código curto fixo, nunca texto do servidor
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  sent_at                  TEXT,
  -- Última tentativa que PODE ter sido entregue sem confirmação (queda ou timeout depois do início
  -- do envelope, teto do worker, arrendamento vencido): conta no teto por destinatário (B2).
  maybe_delivered_at       TEXT,
  CONSTRAINT email_outbox_business_id_kind_appointment_id_unique UNIQUE (business_id, kind, appointment_id),
  FOREIGN KEY (appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (previous_appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  CONSTRAINT email_outbox_id_check CHECK (length(id) = 36),
  CONSTRAINT email_outbox_kind_check
    CHECK (kind IN ('appointment_confirmed', 'appointment_cancelled', 'appointment_rescheduled')),
  CONSTRAINT email_outbox_previous_check
    CHECK ((kind = 'appointment_rescheduled') = (previous_appointment_id IS NOT NULL)
           AND (previous_appointment_id IS NULL OR previous_appointment_id <> appointment_id)),
  CONSTRAINT email_outbox_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'expired')),
  CONSTRAINT email_outbox_attempts_check
    CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 5),
  CONSTRAINT email_outbox_lock_check CHECK ((status = 'sending') = (locked_until IS NOT NULL)),
  CONSTRAINT email_outbox_sent_check CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT email_outbox_error_code_check
    CHECK (last_error_code IS NULL
           OR (length(last_error_code) BETWEEN 1 AND 32 AND last_error_code NOT GLOB '*[^a-z0-9_]*')),
  CONSTRAINT email_outbox_instants_check
    CHECK (length(created_at) = 24 AND length(updated_at) = 24 AND length(next_attempt_at) = 24
           AND (locked_until IS NULL OR length(locked_until) = 24)
           AND (sent_at IS NULL OR length(sent_at) = 24)
           AND (maybe_delivered_at IS NULL OR length(maybe_delivered_at) = 24))
);
-- Candidatos do worker (critério 1): pendentes vencidos e arrendamentos vencidos.
CREATE INDEX email_outbox_status_next_attempt_at_idx ON email_outbox(status, next_attempt_at);
-- Purga das terminais em 30 dias (critério 10).
CREATE INDEX email_outbox_status_updated_at_idx ON email_outbox(status, updated_at);
-- Teto por destinatário (JOIN pelo agendamento) e cascata da FK.
CREATE INDEX email_outbox_business_id_appointment_id_idx ON email_outbox(business_id, appointment_id);
-- Teto por destinatário somando todos os negócios (critério 27): customers só tem (business_id, email).
CREATE INDEX customers_email_idx ON customers(email);
