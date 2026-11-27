-- AF-03: recuperação de senha. Instantes UTC ISO de 24 caracteres. Hashes SHA-256 em hex minúsculo.

-- 1. Auditoria mínima (critério 35). NULL = nunca trocada por redefinição.
ALTER TABLE users ADD COLUMN password_changed_at TEXT
  CONSTRAINT users_password_changed_at_check
  CHECK (password_changed_at IS NULL OR length(password_changed_at) = 24);

-- 2. Bloqueio do AF-02 por conta (critério 20). A chave do AF-02 é sha256(email \n ip) e não permite
-- achar todas as linhas de um e-mail. email_hash = sha256('login_attempts.email\n' || email), gravado
-- pelo login a partir daqui. Linhas antigas ficam com NULL (não há base em produção).
ALTER TABLE login_attempts ADD COLUMN email_hash TEXT
  CONSTRAINT login_attempts_email_hash_check
  CHECK (email_hash IS NULL OR (length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX login_attempts_email_hash_idx ON login_attempts(email_hash);

-- 3. Tokens de redefinição (critério 8). Só o SHA-256; o texto puro nunca é gravado.
CREATE TABLE password_reset_tokens (
  token_hash  TEXT NOT NULL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,                 -- emissão (no envio pelo worker)
  expires_at  TEXT NOT NULL,                 -- created_at + 1 h; vale enquanto agora < expires_at
  used_at     TEXT,
  CONSTRAINT password_reset_tokens_hash_check
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT password_reset_tokens_instants_check
    CHECK (length(created_at) = 24 AND length(expires_at) = 24 AND expires_at > created_at
           AND (used_at IS NULL OR length(used_at) = 24))
);
-- Só um token pendente por conta (critério 11): o emissor apaga os pendentes antes de inserir.
CREATE UNIQUE INDEX password_reset_tokens_user_id_pending_unique
  ON password_reset_tokens(user_id) WHERE used_at IS NULL;
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens(user_id);
CREATE INDEX password_reset_tokens_expires_at_idx ON password_reset_tokens(expires_at);

-- 4. Limites persistidos (critérios 22 a 24). Por IP: janela fixa a partir do primeiro acerto.
-- key_hash = sha256(scope || '\n' || valor): rateLimitKey(ip). Nada em claro.
CREATE TABLE auth_rate_limits (
  scope              TEXT NOT NULL,
  key_hash           TEXT NOT NULL,
  window_started_at  TEXT NOT NULL,
  hits               INTEGER NOT NULL,
  PRIMARY KEY (scope, key_hash),
  CONSTRAINT auth_rate_limits_scope_check
    CHECK (scope IN ('password_reset_request_ip', 'password_reset_confirm_ip')),
  CONSTRAINT auth_rate_limits_key_check
    CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT auth_rate_limits_hits_check CHECK (typeof(hits) = 'integer' AND hits >= 0),
  CONSTRAINT auth_rate_limits_instant_check CHECK (length(window_started_at) = 24)
);
CREATE INDEX auth_rate_limits_window_started_at_idx ON auth_rate_limits(window_started_at);

-- 4b. Pedidos aceitos por e-mail, em janela DESLIZANTE (revisão de segurança, decisão 3 do Gerente):
-- 3 por hora e 5 por 24 h contados sobre os instantes, sem a borda da janela fixa. Uma linha por
-- pedido aceito (no máximo 5 por chave em 24 h); os recusados não gravam. key_hash =
-- sha256(scope || '\n' || e-mail normalizado).
CREATE TABLE auth_rate_events (
  scope        TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  CONSTRAINT auth_rate_events_scope_check CHECK (scope IN ('password_reset_request_email')),
  CONSTRAINT auth_rate_events_key_check
    CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT auth_rate_events_instant_check CHECK (length(occurred_at) = 24)
);
CREATE INDEX auth_rate_events_scope_key_hash_occurred_at_idx ON auth_rate_events(scope, key_hash, occurred_at);
CREATE INDEX auth_rate_events_occurred_at_idx ON auth_rate_events(occurred_at);

-- 5. Generaliza email_outbox (decisão 9 do Gerente) pelo procedimento da 014. Nenhuma tabela
-- referencia email_outbox; foreign_keys não é desligado. Colunas da 014 na mesma ordem, mais user_id
-- no FIM. Nomes de constraint e índices da 014 preservados. A varredura do AF-18 (só enqueue-email.js
-- enfileira) procura o nome exato da tabela: a cópia para email_outbox_new não conta.
CREATE TABLE email_outbox_new (
  id                       TEXT NOT NULL PRIMARY KEY,          -- UUID v4; usado no Message-ID
  business_id              TEXT REFERENCES businesses(id) ON DELETE CASCADE,   -- NULL só em e-mail de conta
  kind                     TEXT NOT NULL,
  appointment_id           TEXT,                                -- NULL só em e-mail de conta
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
  user_id                  TEXT REFERENCES users(id) ON DELETE CASCADE,        -- só e-mail de conta (AF-03)
  CONSTRAINT email_outbox_business_id_kind_appointment_id_unique UNIQUE (business_id, kind, appointment_id),
  FOREIGN KEY (appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (previous_appointment_id, business_id) REFERENCES appointments(id, business_id) ON DELETE CASCADE,
  CONSTRAINT email_outbox_id_check CHECK (length(id) = 36),
  CONSTRAINT email_outbox_kind_check
    CHECK (kind IN ('appointment_confirmed', 'appointment_cancelled', 'appointment_rescheduled',
                    'appointment_cancelled_by_owner', 'password_reset', 'password_changed')),
  -- Alvo por família: conta -> só user_id; agendamento -> business_id e appointment_id, sem user_id.
  CONSTRAINT email_outbox_target_check
    CHECK ((kind IN ('password_reset', 'password_changed')
            AND user_id IS NOT NULL AND business_id IS NULL AND appointment_id IS NULL
            AND previous_appointment_id IS NULL)
        OR (kind NOT IN ('password_reset', 'password_changed')
            AND user_id IS NULL AND business_id IS NOT NULL AND appointment_id IS NOT NULL)),
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
INSERT INTO email_outbox_new
  (id, business_id, kind, appointment_id, previous_appointment_id, status, attempts, next_attempt_at,
   locked_until, last_error_code, created_at, updated_at, sent_at, maybe_delivered_at, user_id)
SELECT id, business_id, kind, appointment_id, previous_appointment_id, status, attempts, next_attempt_at,
       locked_until, last_error_code, created_at, updated_at, sent_at, maybe_delivered_at, NULL
  FROM email_outbox;
DROP TABLE email_outbox;
ALTER TABLE email_outbox_new RENAME TO email_outbox;
-- DROP TABLE levou os índices; recriados com os mesmos nomes da 014. customers_email_idx não é tocado.
CREATE INDEX email_outbox_status_next_attempt_at_idx ON email_outbox(status, next_attempt_at);
CREATE INDEX email_outbox_status_updated_at_idx ON email_outbox(status, updated_at);
CREATE INDEX email_outbox_business_id_appointment_id_idx ON email_outbox(business_id, appointment_id);
-- Novo: cascata da FK de users, cota de conta e "pedido mais novo" do worker.
CREATE INDEX email_outbox_user_id_kind_created_at_idx ON email_outbox(user_id, kind, created_at);
