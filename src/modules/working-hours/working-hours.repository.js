/**
 * @typedef {{ weekday: number, startMinute: number, endMinute: number }} WorkingInterval
 */

/**
 * Toda leitura faz JOIN com `professionals` filtrando `removed_at IS NULL`: a grade retida de um
 * profissional removido não sai por nenhum caminho (critério 19, decisão 5).
 */
const ACTIVE_JOIN = `JOIN professionals p
    ON p.id = wh.professional_id AND p.business_id = wh.business_id AND p.removed_at IS NULL`;

const ORDER_BY = 'ORDER BY wh.weekday ASC, wh.start_minute ASC';

const placeholdersFor = (list) => list.map(() => '?').join(', ');

function fromRow(row) {
  return { weekday: Number(row.weekday), startMinute: Number(row.start_minute), endMinute: Number(row.end_minute) };
}

/**
 * Todo acesso filtra por `business_id`. Contrato para o AF-10: `findWeekly`, `findByProfessional`
 * e `hasHours` (design 4.5). `weekday` é ISO e os minutos são hora local do negócio.
 * @param {import('../../db/index.js').Database} db
 */
export function createWorkingHoursRepository(db) {
  return {
    /** @returns {Promise<WorkingInterval[]>} por dia e início; [] para removido ou de outro negócio */
    async findByProfessional(businessId, professionalId, conn = db) {
      const rows = await conn.all(
        `SELECT wh.weekday, wh.start_minute, wh.end_minute
           FROM working_hours wh ${ACTIVE_JOIN}
          WHERE wh.business_id = ? AND wh.professional_id = ?
          ${ORDER_BY}`,
        [businessId, professionalId],
      );
      return rows.map(fromRow);
    },

    /**
     * Grade de vários profissionais numa consulta só (AF-10, sem N+1). Profissional sem grade
     * (ou removido) não aparece no Map: use `map.get(id) ?? []`.
     * @param {string[]} professionalIds
     * @returns {Promise<Map<string, WorkingInterval[]>>}
     */
    async findWeekly(businessId, professionalIds, conn = db) {
      const ids = [...new Set(Array.isArray(professionalIds) ? professionalIds : [])];
      const result = new Map();
      if (ids.length === 0) return result;
      const rows = await conn.all(
        `SELECT wh.professional_id, wh.weekday, wh.start_minute, wh.end_minute
           FROM working_hours wh ${ACTIVE_JOIN}
          WHERE wh.business_id = ? AND wh.professional_id IN (${placeholdersFor(ids)})
          ${ORDER_BY}`,
        [businessId, ...ids],
      );
      for (const row of rows) {
        if (!result.has(row.professional_id)) result.set(row.professional_id, []);
        result.get(row.professional_id).push(fromRow(row));
      }
      return result;
    },

    /** Contrato "tem expediente" (critério 2). @returns {Promise<boolean>} */
    async hasHours(businessId, professionalId, conn = db) {
      const row = await conn.get(
        `SELECT 1 AS found FROM working_hours wh ${ACTIVE_JOIN}
          WHERE wh.business_id = ? AND wh.professional_id = ? LIMIT 1`,
        [businessId, professionalId],
      );
      return Boolean(row);
    },

    /**
     * Substitui por inteiro os dias enviados (`intervals: []` vira folga); os outros dias não mudam.
     * Deve rodar dentro da transação do serviço, depois de `lockActive`.
     * @param {Array<{ weekday: number, intervals: Array<{ startMinute: number, endMinute: number }> }>} days
     */
    async replaceDays(professionalId, businessId, days, nowIso, conn = db) {
      if (days.length === 0) return;
      const weekdays = days.map((d) => d.weekday);
      await conn.run(
        `DELETE FROM working_hours
          WHERE professional_id = ? AND business_id = ? AND weekday IN (${placeholdersFor(weekdays)})`,
        [professionalId, businessId, ...weekdays],
      );
      const rows = days.flatMap((d) => d.intervals.map((i) => [d.weekday, i.startMinute, i.endMinute]));
      if (rows.length === 0) return;
      const params = rows.flatMap(([weekday, start, end]) => [professionalId, businessId, weekday, start, end, nowIso]);
      await conn.run(
        `INSERT INTO working_hours (professional_id, business_id, weekday, start_minute, end_minute, created_at)
         VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
        params,
      );
    },

    /** Defesa do teto de 42 (conferido na transação). @returns {Promise<number>} */
    async countByProfessional(professionalId, businessId, conn = db) {
      const row = await conn.get(
        'SELECT COUNT(*) AS n FROM working_hours WHERE professional_id = ? AND business_id = ?',
        [professionalId, businessId],
      );
      return Number(row.n);
    },
  };
}
