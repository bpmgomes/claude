/**
 * @typedef {{ id: string, professionalId: string|null, professionalName: string|null, startsAt: string,
 *   endsAt: string, reasonKind: string|null, reasonNote: string|null, createdAt: string }} TimeBlockRow
 * @typedef {{ startsAt: string, endsAt: string, professionalId: string|null }} BlockInterval
 */

/** Teto do período de `findApplicable*` (contrato do AF-10, design 4.5). */
export const FIND_APPLICABLE_RANGE_MAX_DAYS = 400;

const DAY_MS = 86_400_000;

/**
 * Nome do profissional ativo (LEFT JOIN): bloqueio de "todos" não tem profissional, e o de
 * profissional removido não sai (a linha já foi apagada por markRemoved; o filtro é defesa).
 */
const ACTIVE_LEFT_JOIN = `LEFT JOIN professionals p
    ON p.id = tb.professional_id AND p.business_id = tb.business_id AND p.removed_at IS NULL`;
const VISIBLE = '(tb.professional_id IS NULL OR p.id IS NOT NULL)';

const ROW_COLUMNS = `tb.id, tb.professional_id, p.name AS professional_name, tb.starts_at, tb.ends_at,
       tb.reason_kind, tb.reason_note, tb.created_at`;

const ORDER_BY = 'ORDER BY tb.starts_at ASC, tb.id ASC';

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    professionalId: row.professional_id ?? null,
    professionalName: row.professional_name ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reasonKind: row.reason_kind ?? null,
    reasonNote: row.reason_note ?? null,
    createdAt: row.created_at,
  };
}

function toInterval(row) {
  return { professionalId: row.professional_id ?? null, startsAt: row.starts_at, endsAt: row.ends_at };
}

/** @throws {RangeError} período vazio, invertido, inválido ou acima de 400 dias */
function checkRange(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new RangeError('Período inválido: fromIso deve ser menor que toIso.');
  }
  if (to - from > FIND_APPLICABLE_RANGE_MAX_DAYS * DAY_MS) {
    throw new RangeError(`O período pode ter no máximo ${FIND_APPLICABLE_RANGE_MAX_DAYS} dias.`);
  }
}

/**
 * Todo acesso filtra por `business_id`. Instantes são texto ISO de largura fixa (24 caracteres,
 * sufixo Z): a comparação de strings equivale à cronológica.
 * @param {import('../../db/index.js').Database} db
 */
export function createTimeBlocksRepository(db) {
  return {
    async insert({ id, businessId, professionalId, startsAt, endsAt, reasonKind, reasonNote, createdAt }, conn = db) {
      await conn.run(
        `INSERT INTO time_blocks
           (id, business_id, professional_id, starts_at, ends_at, reason_kind, reason_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, businessId, professionalId, startsAt, endsAt, reasonKind, reasonNote, createdAt],
      );
    },

    /** @returns {Promise<TimeBlockRow|undefined>} */
    async findById(id, businessId, conn = db) {
      return fromRow(
        await conn.get(
          `SELECT ${ROW_COLUMNS} FROM time_blocks tb ${ACTIVE_LEFT_JOIN}
            WHERE tb.id = ? AND tb.business_id = ? AND ${VISIBLE}`,
          [id, businessId],
        ),
      );
    },

    /**
     * Listagem do dono. `professionalId`: null (todos os bloqueios), 'all' (só os de "todos") ou um
     * UUID (os dele e os de "todos"; o serviço confere antes que ele é ativo e do negócio).
     * Com `fromIso`/`toIso`: os que intersectam [fromIso, toIso). Sem período: só ativos (ends_at > nowIso).
     * @returns {Promise<{ rows: TimeBlockRow[], truncated: boolean }>}
     */
    async list(businessId, { professionalId = null, fromIso = null, toIso = null, nowIso, limit }, conn = db) {
      const where = ['tb.business_id = ?', VISIBLE];
      const params = [businessId];
      if (professionalId === 'all') where.push('tb.professional_id IS NULL');
      else if (professionalId) {
        where.push('(tb.professional_id IS NULL OR tb.professional_id = ?)');
        params.push(professionalId);
      }
      if (fromIso && toIso) {
        where.push('tb.starts_at < ? AND tb.ends_at > ?');
        params.push(toIso, fromIso);
      } else {
        where.push('tb.ends_at > ?');
        params.push(nowIso);
      }
      const rows = await conn.all(
        `SELECT ${ROW_COLUMNS} FROM time_blocks tb ${ACTIVE_LEFT_JOIN}
          WHERE ${where.join(' AND ')}
          ${ORDER_BY} LIMIT ?`,
        [...params, limit + 1],
      );
      return { rows: rows.slice(0, limit).map(fromRow), truncated: rows.length > limit };
    },

    /** @returns {Promise<{ changes: number }>} */
    async deleteById(id, businessId, conn = db) {
      return conn.run('DELETE FROM time_blocks WHERE id = ? AND business_id = ?', [id, businessId]);
    },

    /** Ativos = ends_at > nowIso. @returns {Promise<number>} */
    async countActive(businessId, nowIso, conn = db) {
      const row = await conn.get('SELECT COUNT(*) AS n FROM time_blocks WHERE business_id = ? AND ends_at > ?', [
        businessId,
        nowIso,
      ]);
      return Number(row.n);
    },

    /** Apaga os encerrados até `cutoffIso` (ends_at <= cutoff) do negócio. @returns {Promise<{ changes: number }>} */
    async purgeEnded(businessId, cutoffIso, conn = db) {
      return conn.run('DELETE FROM time_blocks WHERE business_id = ? AND ends_at <= ?', [businessId, cutoffIso]);
    },

    /** Mantém só os `keep` encerrados (ends_at <= nowIso) mais recentes do negócio. */
    async trimEnded(businessId, nowIso, keep, conn = db) {
      return conn.run(
        `DELETE FROM time_blocks WHERE business_id = ? AND ends_at <= ? AND id NOT IN (
           SELECT id FROM time_blocks WHERE business_id = ? AND ends_at <= ?
            ORDER BY ends_at DESC, id ASC LIMIT ?
         )`,
        [businessId, nowIso, businessId, nowIso, keep],
      );
    },

    /** Purga global (boot); usa o índice (ends_at). @returns {Promise<{ changes: number }>} */
    async purgeEndedAll(cutoffIso, conn = db) {
      return conn.run('DELETE FROM time_blocks WHERE ends_at <= ?', [cutoffIso]);
    },

    // Contrato do AF-10 (design 4.5): instantes UTC, intervalos semiabertos, possivelmente
    // sobrepostos (o consumidor trata como união). Sem IN (...): JOIN por business_id (AF-08 item 2).

    /**
     * Bloqueios aplicáveis ao profissional P (os dele e os de "todos") que intersectam
     * [fromIso, toIso). Profissional removido, inexistente ou de outro negócio -> [] (nem os de "todos").
     * @returns {Promise<BlockInterval[]>} por starts_at
     * @throws {RangeError} se fromIso >= toIso ou o período passar de 400 dias
     */
    async findApplicable(businessId, professionalId, fromIso, toIso, conn = db) {
      checkRange(fromIso, toIso);
      const rows = await conn.all(
        `SELECT tb.professional_id, tb.starts_at, tb.ends_at FROM time_blocks tb
           JOIN professionals p ON p.business_id = tb.business_id AND p.id = ? AND p.removed_at IS NULL
          WHERE tb.business_id = ? AND (tb.professional_id IS NULL OR tb.professional_id = p.id)
            AND tb.starts_at < ? AND tb.ends_at > ?
          ${ORDER_BY}`,
        [professionalId, businessId, toIso, fromIso],
      );
      return rows.map(toInterval);
    },

    /**
     * Fluxo "qualquer profissional": uma consulta só. `all` vale para todo profissional ativo;
     * `byProfessional.get(id) ?? []` para cada um. Removidos não aparecem.
     * @returns {Promise<{ all: BlockInterval[], byProfessional: Map<string, BlockInterval[]> }>}
     * @throws {RangeError} se fromIso >= toIso ou o período passar de 400 dias
     */
    async findApplicableByBusiness(businessId, fromIso, toIso, conn = db) {
      checkRange(fromIso, toIso);
      const rows = await conn.all(
        `SELECT tb.professional_id, tb.starts_at, tb.ends_at FROM time_blocks tb ${ACTIVE_LEFT_JOIN}
          WHERE tb.business_id = ? AND ${VISIBLE} AND tb.starts_at < ? AND tb.ends_at > ?
          ${ORDER_BY}`,
        [businessId, toIso, fromIso],
      );
      const all = [];
      const byProfessional = new Map();
      for (const row of rows) {
        const interval = toInterval(row);
        if (interval.professionalId === null) all.push(interval);
        else {
          if (!byProfessional.has(interval.professionalId)) byProfessional.set(interval.professionalId, []);
          byProfessional.get(interval.professionalId).push(interval);
        }
      }
      return { all, byProfessional };
    },
  };
}
