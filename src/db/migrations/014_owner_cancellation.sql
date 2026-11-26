-- AF-14: origem do cancelamento e e-mail do cancelamento pelo dono. Instantes UTC ISO de 24 caracteres.

-- 1. Origem do cancelamento (critério 11, decisão 7 do Gerente). NULL = não cancelado, ou cancelado
-- antes do AF-14 (não há base real a migrar). Só existe com status 'cancelled'. O CHECK de ADD COLUMN
-- é verificado contra as linhas existentes (todas recebem NULL), como em 012.
ALTER TABLE appointments ADD COLUMN cancelled_by TEXT
  CONSTRAINT appointments_cancelled_by_check
  CHECK (cancelled_by IS NULL
         OR (cancelled_by IN ('customer', 'owner', 'reschedule') AND status = 'cancelled'));

-- 2. Amplia o CHECK de kind de email_outbox (AF-18, design 4.7 e R10): no SQLite, ampliar um CHECK
-- exige recriar a tabela. Nenhuma tabela referencia email_outbox (ela só é filha de businesses e
-- appointments), então não é preciso desligar foreign_keys (o que, de todo modo, não tem efeito dentro
-- da transação do runMigrations). Colunas, ordem, nomes de constraint e índices são os da 013.
CREATE TABLE email_outbox_new (
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
  maybe_delivered_at       TEXT,
  CONSTRAINT email_outbox_business_id_kind_appointment_id_unique UNIQUE (business_id, kind, appointment_id),
  FOREIGN KEY (appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (previous_appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  CONSTRAINT email_outbox_id_check CHECK (length(id) = 36),
  CONSTRAINT email_outbox_kind_check
    CHECK (kind IN ('appointment_confirmed', 'appointment_cancelled', 'appointment_rescheduled',
                    'appointment_cancelled_by_owner')),
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
-- Lista explícita de colunas nos dois lados: a cópia não depende da ordem física da 013. A varredura
-- do AF-18 (só enqueue-email.js enfileira na fila) procura o nome exato da tabela, com ou sem aspas
-- e com limite de palavra, então esta cópia para email_outbox_new não conta como enfileiramento.
INSERT INTO email_outbox_new
  (id, business_id, kind, appointment_id, previous_appointment_id, status, attempts, next_attempt_at,
   locked_until, last_error_code, created_at, updated_at, sent_at, maybe_delivered_at)
SELECT id, business_id, kind, appointment_id, previous_appointment_id, status, attempts, next_attempt_at,
       locked_until, last_error_code, created_at, updated_at, sent_at, maybe_delivered_at
  FROM email_outbox;
DROP TABLE email_outbox;
ALTER TABLE email_outbox_new RENAME TO email_outbox;
-- DROP TABLE levou os índices; recriados com os mesmos nomes da 013. customers_email_idx (013) é de
-- customers e não é tocado.
CREATE INDEX email_outbox_status_next_attempt_at_idx ON email_outbox(status, next_attempt_at);
CREATE INDEX email_outbox_status_updated_at_idx ON email_outbox(status, updated_at);
CREATE INDEX email_outbox_business_id_appointment_id_idx ON email_outbox(business_id, appointment_id);
