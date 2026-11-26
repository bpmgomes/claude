// Ponto ÚNICO de enfileiramento de e-mails (AF-18, design 4.3, critério 6). É o único arquivo de
// src/ com `INSERT INTO email_outbox` (teste de varredura).
import { randomUUID } from 'node:crypto';
import { EMAIL_KINDS, EMAIL_KIND_RESCHEDULED } from './email-rules.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isUuid = (v) => typeof v === 'string' && v.length === 36 && UUID_RE.test(v);
const isIso = (v) => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v));

/**
 * Enfileira um e-mail NA transação do chamador. Contrato para AF-14, AF-15 e AF-19.
 * - `tx` é obrigatório e é a transação que muda o estado; nunca o `db` global.
 * - INSERT ... ON CONFLICT (business_id, kind, appointment_id) DO NOTHING: no máximo uma linha por
 *   (agendamento, tipo). `next_attempt_at = created_at = updated_at = nowIso`, `status = 'pending'`.
 * - Não faz rede, não lê dado pessoal, não loga (o chamador loga depois do COMMIT).
 * - Ordem global de travas: a fila é sempre a ÚLTIMA escrita da transação.
 * @param {import('../../db/index.js').Database} tx
 * @param {{ kind: string, businessId: string, appointmentId: string,
 *   previousAppointmentId?: string|null, nowIso: string }} e
 * @param {{ newId?: () => string }} [options]
 * @returns {Promise<{ id: string|null, enqueued: boolean }>}  enqueued=false: já existia (id null)
 * @throws {TypeError} kind fora de EMAIL_KINDS, id fora do formato UUID, previous ausente em
 *   rescheduled ou presente nos outros, nowIso fora de 24 caracteres (erro de programação:
 *   o chamador responde 503 e a transação desfaz tudo)
 */
export async function enqueueEmail(tx, e, { newId = randomUUID } = {}) {
  if (!tx || typeof tx.run !== 'function') throw new TypeError('enqueueEmail: tx obrigatório.');
  const { kind, businessId, appointmentId, nowIso } = e ?? {};
  const previous = e?.previousAppointmentId ?? null;
  if (!EMAIL_KINDS.includes(kind)) throw new TypeError('enqueueEmail: kind desconhecido.');
  if (!isUuid(businessId) || !isUuid(appointmentId)) throw new TypeError('enqueueEmail: id inválido.');
  if ((kind === EMAIL_KIND_RESCHEDULED) !== (previous !== null)) {
    throw new TypeError('enqueueEmail: previousAppointmentId só (e sempre) em appointment_rescheduled.');
  }
  if (previous !== null && (!isUuid(previous) || previous === appointmentId)) {
    throw new TypeError('enqueueEmail: previousAppointmentId inválido.');
  }
  if (!isIso(nowIso)) throw new TypeError('enqueueEmail: nowIso inválido.');
  const id = newId();
  if (!isUuid(id)) throw new TypeError('enqueueEmail: id da linha inválido.');
  const { changes } = await tx.run(
    `INSERT INTO email_outbox
       (id, business_id, kind, appointment_id, previous_appointment_id, status, attempts, next_attempt_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT (business_id, kind, appointment_id) DO NOTHING`,
    [id, businessId, kind, appointmentId, previous, nowIso, nowIso, nowIso],
  );
  return changes === 1 ? { id, enqueued: true } : { id: null, enqueued: false };
}
