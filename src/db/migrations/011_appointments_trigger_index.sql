-- AF-22: índice do trigger de não sobreposição (pendência do AF-11, design 3.1, nota "Índice do trigger").
-- Os triggers appointments_no_overlap_* filtram só por professional_id (sem business_id, para resistir a
-- foreign_keys = OFF, QA AF-11 F4) e por "a.ends_at > NEW.starts_at AND a.starts_at < NEW.ends_at".
-- Com (professional_id, ends_at), a busca lê só os não cancelados do profissional que terminam depois do
-- novo início (na prática, os futuros), e não o histórico inteiro pelo índice único (professional_id, starts_at).
-- O WHERE do índice é idêntico ao termo do trigger (status <> 'cancelled'): é a condição para o SQLite
-- poder usar um índice parcial. O índice appointments_business_id_professional_id_ends_at_active_idx (010)
-- continua: serve countFutureByProfessional e findFutureByProfessional, que filtram por business_id.
CREATE INDEX appointments_professional_id_ends_at_active_idx
  ON appointments(professional_id, ends_at) WHERE status <> 'cancelled';
