// Repositório da fila de e-mails (AF-18, design 4.3). `conn` é a conexão ou a transação do chamador
// (padrão: o `db` global). Nenhuma função aqui insere linha: isso é só de enqueue-email.js.
import { EMAIL_MAX_SENDS } from './email-rules.js';

/**
 * @typedef {{
 *   id: string, businessId: string, kind: string, appointmentId: string,
 *   previousAppointmentId: string|null, status: string, attempts: number, nextAttemptAt: string,
 *   lockedUntil: string|null, lastErrorCode: string|null, createdAt: string, updatedAt: string,
 *   sentAt: string|null, maybeDeliveredAt: string|null,
 * }} OutboxRow
 * @typedef {{ lockedUntil: string, attempts: number }} Lease
 */

const COLUMNS = `id, business_id, kind, appointment_id, previous_appointment_id, status, attempts, next_attempt_at,
       locked_until, last_error_code, created_at, updated_at, sent_at, maybe_delivered_at`;

const TERMINAL = "status IN ('sent', 'failed', 'skipped', 'expired')";

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    businessId: row.business_id,
    kind: row.kind,
    appointmentId: row.appointment_id,
    previousAppointmentId: row.previous_appointment_id ?? null,
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    lockedUntil: row.locked_until ?? null,
    lastErrorCode: row.last_error_code ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at ?? null,
    maybeDeliveredAt: row.maybe_delivered_at ?? null,
  };
}

/** Condição do arrendamento: a linha ainda é desta reivindicação. */
const LEASE_WHERE = "id = ? AND status = 'sending' AND locked_until = ? AND attempts = ?";

/** @param {import('../../db/index.js').Database} db */
export function createEmailOutboxRepository(db) {
  return {
    /**
     * Pendentes vencidos e `sending` com arrendamento vencido e envios sobrando.
     * @returns {Promise<string[]>}
     */
    async findCandidates(nowIso, limit, conn = db) {
      const rows = await conn.all(
        `SELECT id FROM email_outbox
          WHERE (status = 'pending' AND next_attempt_at <= ?)
             OR (status = 'sending' AND locked_until <= ? AND attempts < ?)
          ORDER BY next_attempt_at ASC, id ASC
          LIMIT ?`,
        [nowIso, nowIso, EMAIL_MAX_SENDS, limit],
      );
      return rows.map((r) => r.id);
    },

    /**
     * Reivindicação por UPDATE condicional (critério 7). O chamador EXIGE `changes === 1`.
     * @returns {Promise<{ changes: number }>}
     */
    async claim(id, { nowIso, lockedUntil }, conn = db) {
      // Reivindicar um `sending` vencido é recuperar uma queda: a tentativa anterior pode ter chegado.
      return conn.run(
        `UPDATE email_outbox
            SET maybe_delivered_at = CASE WHEN status = 'sending' THEN ? ELSE maybe_delivered_at END,
                status = 'sending', locked_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND attempts < ?
            AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND locked_until <= ?))`,
        [nowIso, lockedUntil, nowIso, id, EMAIL_MAX_SENDS, nowIso, nowIso],
      );
    },

    /** @returns {Promise<OutboxRow|undefined>} */
    async findById(id, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM email_outbox WHERE id = ?`, [id]));
    },

    /** @param {Lease} lease @returns {Promise<{ changes: number }>} */
    async markSent(id, lease, nowIso, conn = db) {
      return conn.run(
        `UPDATE email_outbox SET status = 'sent', locked_until = NULL, last_error_code = NULL, sent_at = ?, updated_at = ?
          WHERE ${LEASE_WHERE}`,
        [nowIso, nowIso, id, lease.lockedUntil, lease.attempts],
      );
    },

    /** @param {Lease} lease @returns {Promise<{ changes: number }>} */
    async markRetry(id, lease, { nextAttemptAt, errorCode, nowIso, maybeDelivered = false }, conn = db) {
      return conn.run(
        `UPDATE email_outbox SET status = 'pending', locked_until = NULL, next_attempt_at = ?, last_error_code = ?, updated_at = ?,
                maybe_delivered_at = CASE WHEN ? THEN ? ELSE maybe_delivered_at END
          WHERE ${LEASE_WHERE}`,
        [nextAttemptAt, errorCode, nowIso, maybeDelivered ? 1 : 0, nowIso, id, lease.lockedUntil, lease.attempts],
      );
    },

    /** @param {Lease} lease @returns {Promise<{ changes: number }>} */
    async markFailed(id, lease, { errorCode, nowIso, maybeDelivered = false }, conn = db) {
      return conn.run(
        `UPDATE email_outbox SET status = 'failed', locked_until = NULL, last_error_code = ?, updated_at = ?,
                maybe_delivered_at = CASE WHEN ? THEN ? ELSE maybe_delivered_at END
          WHERE ${LEASE_WHERE}`,
        [errorCode, nowIso, maybeDelivered ? 1 : 0, nowIso, id, lease.lockedUntil, lease.attempts],
      );
    },

    /** @param {Lease} lease @returns {Promise<{ changes: number }>} */
    async markSkipped(id, lease, { reason, nowIso }, conn = db) {
      return conn.run(
        `UPDATE email_outbox SET status = 'skipped', locked_until = NULL, last_error_code = ?, updated_at = ?
          WHERE ${LEASE_WHERE}`,
        [reason, nowIso, id, lease.lockedUntil, lease.attempts],
      );
    },

    /** `sending` vencido sem envios sobrando: `failed` com `lease_expired`. @returns {Promise<number>} */
    async failExhausted(nowIso, conn = db) {
      const { changes } = await conn.run(
        `UPDATE email_outbox SET status = 'failed', locked_until = NULL, last_error_code = 'lease_expired', updated_at = ?,
                maybe_delivered_at = ?
          WHERE status = 'sending' AND locked_until <= ? AND attempts >= ?`,
        [nowIso, nowIso, nowIso, EMAIL_MAX_SENDS],
      );
      return changes;
    },

    /** `pending` (ou `sending` vencido) criado até `cutoffIso`: `expired`. @returns {Promise<number>} */
    async expireStale(cutoffIso, nowIso, conn = db) {
      const { changes } = await conn.run(
        `UPDATE email_outbox SET updated_at = ?,
                maybe_delivered_at = CASE WHEN status = 'sending' THEN ? ELSE maybe_delivered_at END,
                status = 'expired', locked_until = NULL, last_error_code = 'expired'
          WHERE (status = 'pending' OR (status = 'sending' AND locked_until <= ?)) AND created_at <= ?`,
        [nowIso, nowIso, nowIso, cutoffIso],
      );
      return changes;
    },

    /** Um lote das terminais com `updated_at <= cutoffIso` (ciclo do worker). @returns {Promise<number>} */
    async purgeTerminal(cutoffIso, { batch = 100 } = {}, conn = db) {
      const { changes } = await conn.run(
        `DELETE FROM email_outbox WHERE rowid IN (
           SELECT rowid FROM email_outbox WHERE ${TERMINAL} AND updated_at <= ? LIMIT ?)`,
        [cutoffIso, batch],
      );
      return changes;
    },

    /** Boot: em lotes até não sobrar (padrão AF-11/AF-12). @returns {Promise<number>} */
    async purgeTerminalAll(cutoffIso, { batch = 500 } = {}, conn = db) {
      let total = 0;
      for (;;) {
        const changes = await this.purgeTerminal(cutoffIso, { batch }, conn);
        total += changes;
        if (changes === 0 || changes < batch) return total;
      }
    },

    /**
     * E-mails recentes para o mesmo endereço normalizado, de QUALQUER negócio (critério 27): `sent`
     * depois de `sinceIso`, `sending`, ou com tentativa que pode ter sido entregue (`maybe_delivered_at`)
     * depois de `sinceIso` (B2), exceto a própria linha. Cada linha conta uma vez. É a única leitura sem filtro de
     * `business_id` e devolve só um número (design 4.5).
     * @returns {Promise<number>}
     */
    async countRecentToRecipient(email, { sinceIso, excludeId }, conn = db) {
      const row = await conn.get(
        `SELECT COUNT(*) AS n FROM customers c
           JOIN appointments a ON a.business_id = c.business_id AND a.customer_id = c.id
           JOIN email_outbox o ON o.business_id = a.business_id AND o.appointment_id = a.id
          WHERE c.email = ? AND o.id <> ?
            AND ((o.status = 'sent' AND o.sent_at > ?) OR o.status = 'sending' OR o.maybe_delivered_at > ?)`,
        [email, excludeId, sinceIso, sinceIso],
      );
      return Number(row?.n ?? 0);
    },
  };
}
