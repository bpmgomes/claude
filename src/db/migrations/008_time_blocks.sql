-- AF-16: bloqueios de horário. Uma linha por bloqueio, em instantes UTC (intervalo semiaberto
-- [starts_at, ends_at)). professional_id NULL = todos os profissionais, inclusive os criados
-- depois (decisão 9). Sem updated_at: o bloqueio é imutável (decisão 3). A remoção lógica do
-- profissional apaga as linhas dele explicitamente (markRemoved, decisão 7).
CREATE TABLE time_blocks (
  id               TEXT NOT NULL PRIMARY KEY,           -- UUID v4
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  professional_id  TEXT,                                -- NULL = todos os profissionais (inclusive os criados depois)
  starts_at        TEXT NOT NULL,                       -- instante UTC, 'YYYY-MM-DDTHH:MM:SS.sssZ' (24 caracteres)
  ends_at          TEXT NOT NULL,                       -- idem; intervalo semiaberto [starts_at, ends_at)
  reason_kind      TEXT,                                -- NULL | 'day_off' | 'holiday' | 'vacation' | 'other'
  reason_note      TEXT,                                -- NULL ou trim + NFC, 1..60 code points
  created_at       TEXT NOT NULL,
  FOREIGN KEY (professional_id, business_id) REFERENCES professionals(id, business_id) ON DELETE CASCADE,
  CONSTRAINT time_blocks_instants_check CHECK (length(starts_at) = 24 AND length(ends_at) = 24 AND starts_at < ends_at),
  CONSTRAINT time_blocks_reason_kind_check CHECK (reason_kind IS NULL OR reason_kind IN ('day_off', 'holiday', 'vacation', 'other')),
  CONSTRAINT time_blocks_reason_note_check CHECK (reason_note IS NULL OR length(reason_note) BETWEEN 1 AND 60)
);
CREATE INDEX time_blocks_business_id_ends_at_idx ON time_blocks(business_id, ends_at);
CREATE INDEX time_blocks_business_id_professional_id_starts_at_idx ON time_blocks(business_id, professional_id, starts_at);
CREATE INDEX time_blocks_ends_at_idx ON time_blocks(ends_at);
