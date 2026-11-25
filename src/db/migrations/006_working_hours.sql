-- AF-08: grade semanal por profissional. Uma linha por intervalo, em hora local do negócio.
-- Sem fuso, data ou versão (decisões 6 e 7). A remoção lógica do profissional não apaga a
-- grade (decisão 5): toda leitura faz JOIN com professionals filtrando removed_at IS NULL.
CREATE TABLE working_hours (
  professional_id  TEXT    NOT NULL,
  business_id      TEXT    NOT NULL,
  weekday          INTEGER NOT NULL,   -- ISO 8601: 1 = segunda ... 7 = domingo
  start_minute     INTEGER NOT NULL,   -- minutos desde 00:00, hora local do negócio
  end_minute       INTEGER NOT NULL,   -- 1440 = 24:00
  created_at       TEXT    NOT NULL,
  PRIMARY KEY (professional_id, weekday, start_minute),
  FOREIGN KEY (professional_id, business_id) REFERENCES professionals(id, business_id) ON DELETE CASCADE,
  CONSTRAINT working_hours_weekday_check CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT working_hours_range_check   CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute),
  CONSTRAINT working_hours_step_check    CHECK (start_minute % 15 = 0 AND end_minute % 15 = 0)
);
CREATE INDEX working_hours_business_id_professional_id_idx ON working_hours(business_id, professional_id);
