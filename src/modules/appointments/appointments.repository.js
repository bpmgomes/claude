/**
 * @typedef {{
 *   id: string, businessId: string, professionalId: string, customerId: string, serviceId: string,
 *   serviceName: string, durationMinutes: number, priceCents: number|null,
 *   customerName: string, customerPhone: string, startsAt: string, endsAt: string,
 *   status: string, createdAt: string, updatedAt: string, cancelledAt: string|null,
 * }} AppointmentRow
 */

/** = CHECK da migração 010 e o teto de duração do AF-06. */
export const APPOINTMENT_DURATION_MAX_MINUTES = 480;

const MINUTE_MS = 60_000;

/** Ocupa horário: todo status exceto `cancelled` (critério 9). Literal, para o índice parcial. */
const ACTIVE = "a.status <> 'cancelled'";

/** Só profissional ativo (AF-10 4.5): JOIN pela FK composta. */
const ACTIVE_PROFESSIONAL_JOIN = `JOIN professionals p
    ON p.id = a.professional_id AND p.business_id = a.business_id AND p.removed_at IS NULL`;

const COLUMNS = `a.id, a.business_id, a.professional_id, a.customer_id, a.service_id, a.service_name,
       a.duration_minutes, a.price_cents, a.customer_name, a.customer_phone, a.starts_at, a.ends_at,
       a.status, a.created_at, a.updated_at, a.cancelled_at`;

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    businessId: row.business_id,
    professionalId: row.professional_id,
    customerId: row.customer_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    durationMinutes: Number(row.duration_minutes),
    priceCents: row.price_cents === null || row.price_cents === undefined ? null : Number(row.price_cents),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at ?? null,
  };
}

/**
 * Limite inferior de `starts_at` para uma consulta por intervalo que começa em `fromIso`: nenhum
 * agendamento dura mais de 480 min (CHECK no banco), então quem intersecta [fromIso, ...) começou
 * no máximo 480 min antes. Permite ao índice (business_id, starts_at) não varrer o histórico.
 */
function lowerBound(fromIso) {
  return new Date(Date.parse(fromIso) - APPOINTMENT_DURATION_MAX_MINUTES * MINUTE_MS).toISOString();
}

/**
 * Filtro de conflito do bloqueio (AF-16): não cancelado, intersecta [startsAt, endsAt), de
 * profissional ativo, do profissional do bloqueio ou de todos (alvo null).
 */
function conflictWhere(businessId, block) {
  const where = [
    'a.business_id = ?',
    ACTIVE,
    'a.starts_at >= ?',
    'a.starts_at < ?',
    'a.ends_at > ?',
  ];
  const params = [businessId, lowerBound(block.startsAt), block.endsAt, block.startsAt];
  if (block.professionalId) {
    where.push('a.professional_id = ?');
    params.push(block.professionalId);
  }
  return { where: where.join(' AND '), params };
}

/**
 * Agendamentos (AF-11). Todo acesso filtra por `business_id`; `conn` é a conexão ou a transação do
 * chamador (padrão: o `db` global). Instantes UTC ISO de 24 caracteres: a comparação de strings é a
 * cronológica. Nenhuma consulta usa IN (...).
 * @param {import('../../db/index.js').Database} db
 */
export function createAppointmentsRepository(db) {
  return {
    /**
     * @param {Omit<AppointmentRow, 'cancelledAt'|'status'> & { status?: string }} row
     * @throws {import('../../db/errors.js').ExclusionViolationError} sobreposição (trigger)
     * @throws {import('../../db/errors.js').UniqueViolationError} mesmo início (índice parcial)
     */
    async insert(row, conn = db) {
      await conn.run(
        `INSERT INTO appointments
           (id, business_id, professional_id, customer_id, service_id, service_name, duration_minutes,
            price_cents, customer_name, customer_phone, starts_at, ends_at, status, created_at, updated_at,
            cancelled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          row.id,
          row.businessId,
          row.professionalId,
          row.customerId,
          row.serviceId,
          row.serviceName,
          row.durationMinutes,
          row.priceCents,
          row.customerName,
          row.customerPhone,
          row.startsAt,
          row.endsAt,
          row.status ?? 'confirmed',
          row.createdAt,
          row.updatedAt ?? row.createdAt,
        ],
      );
    },

    /**
     * Linha completa + nome do profissional por JOIN, mesmo removido (AF-14, AF-18 e testes).
     * @returns {Promise<(AppointmentRow & { professionalName: string })|undefined>}
     */
    async findById(id, businessId, conn = db) {
      const row = await conn.get(
        `SELECT ${COLUMNS}, p.name AS professional_name FROM appointments a
           JOIN professionals p ON p.id = a.professional_id AND p.business_id = a.business_id
          WHERE a.id = ? AND a.business_id = ?`,
        [id, businessId],
      );
      if (!row) return undefined;
      return { ...fromRow(row), professionalName: row.professional_name };
    },

    /**
     * Ocupados não cancelados de profissionais ativos que intersectam [fromIso, toIso). Uma consulta
     * por business_id (`professionalId` null = todos os ativos).
     * @returns {Promise<Array<{ professionalId: string, startsAt: string, endsAt: string }>>}
     */
    async findBusy(businessId, professionalId, fromIso, toIso, conn = db) {
      const params = [businessId, lowerBound(fromIso), toIso, fromIso];
      let filter = '';
      if (professionalId) {
        filter = ' AND a.professional_id = ?';
        params.push(professionalId);
      }
      const rows = await conn.all(
        `SELECT a.professional_id, a.starts_at, a.ends_at FROM appointments a ${ACTIVE_PROFESSIONAL_JOIN}
          WHERE a.business_id = ? AND ${ACTIVE} AND a.starts_at >= ? AND a.starts_at < ? AND a.ends_at > ?${filter}
          ORDER BY a.starts_at ASC, a.id ASC`,
        params,
      );
      return rows.map((r) => ({ professionalId: r.professional_id, startsAt: r.starts_at, endsAt: r.ends_at }));
    },

    /** @returns {Promise<number>} conflitos do bloqueio (total real) */
    async countConflicts(businessId, block, conn = db) {
      const { where, params } = conflictWhere(businessId, block);
      const row = await conn.get(
        `SELECT COUNT(*) AS n FROM appointments a ${ACTIVE_PROFESSIONAL_JOIN} WHERE ${where}`,
        params,
      );
      return Number(row.n);
    },

    /**
     * Até `limit` conflitos, por início e id, com os snapshots (`customerName` é o do agendamento,
     * nunca `customers.name`) e o nome do profissional por JOIN.
     */
    async listConflicts(businessId, block, limit, conn = db) {
      const { where, params } = conflictWhere(businessId, block);
      const rows = await conn.all(
        `SELECT a.id, a.starts_at, a.ends_at, a.service_name, a.professional_id, p.name AS professional_name,
                a.customer_name
           FROM appointments a ${ACTIVE_PROFESSIONAL_JOIN}
          WHERE ${where}
          ORDER BY a.starts_at ASC, a.id ASC LIMIT ?`,
        [...params, limit],
      );
      return rows.map((r) => ({
        id: r.id,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        serviceName: r.service_name,
        professionalId: r.professional_id,
        professionalName: r.professional_name,
        customerName: r.customer_name,
      }));
    },

    /** O conjunto inteiro de conflitos (id e updated_at), por id: base do `versionKey`. */
    async conflictVersionRows(businessId, block, conn = db) {
      const { where, params } = conflictWhere(businessId, block);
      return conn.all(
        `SELECT a.id, a.updated_at FROM appointments a ${ACTIVE_PROFESSIONAL_JOIN} WHERE ${where} ORDER BY a.id ASC`,
        params,
      );
    },

    /**
     * Não cancelados com início em [fromIso, toIso), por profissional (desempate do "qualquer").
     * @returns {Promise<Map<string, number>>}
     */
    async countByProfessionalStartingIn(businessId, fromIso, toIso, conn = db) {
      const rows = await conn.all(
        `SELECT a.professional_id, COUNT(*) AS n FROM appointments a
          WHERE a.business_id = ? AND ${ACTIVE} AND a.starts_at >= ? AND a.starts_at < ?
          GROUP BY a.professional_id`,
        [businessId, fromIso, toIso],
      );
      return new Map(rows.map((r) => [r.professional_id, Number(r.n)]));
    },

    /** Não cancelados do serviço com início > nowIso (AF-06). @returns {Promise<number>} */
    async countFutureByService(businessId, serviceId, nowIso, conn = db) {
      const row = await conn.get(
        `SELECT COUNT(*) AS n FROM appointments a
          WHERE a.business_id = ? AND a.starts_at > ? AND ${ACTIVE} AND a.service_id = ?`,
        [businessId, nowIso, serviceId],
      );
      return Number(row.n);
    },

    /** Não cancelados do profissional com início > nowIso (AF-07). @returns {Promise<number>} */
    async countFutureByProfessional(businessId, professionalId, nowIso, conn = db) {
      const row = await conn.get(
        `SELECT COUNT(*) AS n FROM appointments a
          WHERE a.business_id = ? AND a.professional_id = ? AND a.ends_at > ? AND ${ACTIVE} AND a.starts_at > ?`,
        [businessId, professionalId, nowIso, nowIso],
      );
      return Number(row.n);
    },

    /**
     * Até `limit` futuros não cancelados do profissional, por início e id, e o fuso do negócio.
     * @returns {Promise<{ rows: Array<{ startsAt: string, endsAt: string }>, timezone: string|null }>}
     */
    async findFutureByProfessional(businessId, professionalId, nowIso, limit, conn = db) {
      const rows = await conn.all(
        `SELECT a.starts_at, a.ends_at, b.timezone FROM appointments a
           JOIN businesses b ON b.id = a.business_id
          WHERE a.business_id = ? AND a.professional_id = ? AND a.ends_at > ? AND ${ACTIVE} AND a.starts_at > ?
          ORDER BY a.starts_at ASC, a.id ASC LIMIT ?`,
        [businessId, professionalId, nowIso, nowIso, limit],
      );
      return {
        rows: rows.map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at })),
        timezone: rows.length > 0 ? rows[0].timezone : null,
      };
    },

    /**
     * Futuros não cancelados do cliente (o e-mail é único por negócio, então `customer_id` o
     * representa) e do telefone do snapshot, numa consulta só (critério 42).
     * @returns {Promise<{ byCustomer: number, byPhone: number }>}
     */
    async countFutureForCustomer(businessId, { customerId, phone }, nowIso, conn = db) {
      const row = await conn.get(
        `SELECT COALESCE(SUM(a.customer_id = ?), 0) AS by_customer, COALESCE(SUM(a.customer_phone = ?), 0) AS by_phone
           FROM appointments a
          WHERE a.business_id = ? AND ${ACTIVE} AND a.starts_at > ? AND (a.customer_id = ? OR a.customer_phone = ?)`,
        [customerId, phone, businessId, nowIso, customerId, phone],
      );
      return { byCustomer: Number(row.by_customer), byPhone: Number(row.by_phone) };
    },

    // Idempotência (critério 25).

    /** @returns {Promise<{ requestHash: string, responseBody: string, appointmentId: string }|undefined>} */
    async findIdempotency(businessId, key, nowIso, conn = db) {
      const row = await conn.get(
        `SELECT request_hash, response_body, appointment_id FROM booking_idempotency_keys
          WHERE business_id = ? AND idempotency_key = ? AND expires_at > ?`,
        [businessId, key, nowIso],
      );
      if (!row) return undefined;
      return { requestHash: row.request_hash, responseBody: row.response_body, appointmentId: row.appointment_id };
    },

    /**
     * Uma chave expirada com o mesmo valor é substituída (a chave expirada vale como nova).
     * @throws {import('../../db/errors.js').UniqueViolationError} chave viva já gravada
     */
    async insertIdempotency({ businessId, key, requestHash, appointmentId, responseBody, createdAt, expiresAt }, conn = db) {
      await conn.run(
        'DELETE FROM booking_idempotency_keys WHERE business_id = ? AND idempotency_key = ? AND expires_at <= ?',
        [businessId, key, createdAt],
      );
      await conn.run(
        `INSERT INTO booking_idempotency_keys
           (business_id, idempotency_key, request_hash, appointment_id, response_body, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [businessId, key, requestHash, appointmentId, responseBody, createdAt, expiresAt],
      );
    },

    /** Purga oportunista do negócio. @returns {Promise<{ changes: number }>} */
    async purgeIdempotency(businessId, nowIso, conn = db) {
      return conn.run('DELETE FROM booking_idempotency_keys WHERE business_id = ? AND expires_at <= ?', [
        businessId,
        nowIso,
      ]);
    },

    /**
     * Purga global (boot), em lotes de `batch` até não sobrar expirada (lição do AF-16 item 3).
     * @returns {Promise<number>} linhas apagadas
     */
    async purgeIdempotencyAll(nowIso, { batch = 500 } = {}, conn = db) {
      let total = 0;
      for (;;) {
        const { changes } = await conn.run(
          `DELETE FROM booking_idempotency_keys WHERE rowid IN (
             SELECT rowid FROM booking_idempotency_keys WHERE expires_at <= ? LIMIT ?)`,
          [nowIso, batch],
        );
        total += changes;
        if (changes === 0 || changes < batch) return total;
      }
    },
  };
}
