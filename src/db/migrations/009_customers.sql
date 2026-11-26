-- AF-04: cliente final, sem senha e sem conta. Um registro por (negócio, e-mail normalizado).
-- Nasce só dentro da transação de um agendamento (AF-11), pela porta customers.findOrCreate.
-- name/phone são os do PRIMEIRO agendamento e nunca são sobrescritos por envio público
-- (decisão 1): o dado digitado em cada agendamento fica no snapshot do próprio agendamento.
CREATE TABLE customers (
  id           TEXT NOT NULL PRIMARY KEY,          -- UUID v4 (randomUUID); nunca sai em rota pública
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                      -- trim + NFC, 2..80 code points
  phone        TEXT NOT NULL,                      -- só dígitos, DDD + número, sem 55 (10 ou 11)
  email        TEXT NOT NULL,                      -- trim + minúsculas, até 254
  created_at   TEXT NOT NULL,                      -- ISO 8601 UTC
  updated_at   TEXT NOT NULL,                      -- = created_at até existir edição pelo dono (AF-14)
  CONSTRAINT customers_business_id_email_unique UNIQUE (business_id, email),
  CONSTRAINT customers_id_business_id_unique UNIQUE (id, business_id),   -- FK composta do AF-11
  CONSTRAINT customers_phone_check CHECK (length(phone) IN (10, 11)),
  CONSTRAINT customers_email_check CHECK (length(email) BETWEEN 3 AND 254),
  CONSTRAINT customers_name_check CHECK (length(name) >= 2)
);
