CREATE TABLE login_attempts (
  key_hash      TEXT PRIMARY KEY,   -- SHA-256 hex de "<email normalizado>\n<ip normalizado>"
  failed_count  INTEGER NOT NULL,   -- falhas consecutivas (inclui tentativas em andamento)
  locked_until  TEXT,               -- ISO-8601 UTC; NULL = sem bloqueio
  updated_at    TEXT NOT NULL
);
