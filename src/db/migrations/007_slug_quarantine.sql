-- Slugs liberados por troca (AF-05 item 5). Só linhas de slugs que NÃO estão em uso:
-- o slug atual continua só em businesses.slug (UNIQUE).
-- Sem FK para businesses de propósito: a quarentena precisa sobreviver a um negócio apagado.
CREATE TABLE slug_quarantine (
  slug         TEXT PRIMARY KEY,      -- mesmo formato de businesses.slug
  business_id  TEXT NOT NULL,         -- quem liberou
  released_at  TEXT NOT NULL          -- ISO 8601 UTC; quarentena vale enquanto released_at > now - 30 dias
);
CREATE INDEX slug_quarantine_business_id_released_at_idx ON slug_quarantine(business_id, released_at);
