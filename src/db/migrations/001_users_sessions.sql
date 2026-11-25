CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- UUID v4
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,              -- já normalizado: trim + lowercase
  password_hash TEXT NOT NULL,              -- bcrypt ($2a$/$2b$...)
  created_at    TEXT NOT NULL,              -- ISO-8601 UTC
  updated_at    TEXT NOT NULL,
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,           -- UUID v4 (uso interno)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,              -- SHA-256 hex do token do cookie
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,              -- last_seen_at + sessionTtlDays
  revoked_at    TEXT,                       -- preenchido no logout (AF-02) / reset (AF-03)
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
