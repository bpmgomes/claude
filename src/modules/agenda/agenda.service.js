import { instantToLocal, localToInstant, addLocalDays } from '../../shared/zoned-time.js';
import { DEFAULT_TIME_ZONE, TIME_BLOCKS_LIST_MAX } from '../../shared/time-blocks.js';
import { PROFESSIONAL_ID_RE, professionalNameKey } from '../../shared/professionals.js';
import {
  validateAgendaQuery,
  AGENDA_MESSAGES as M,
  AGENDA_ITEMS_MAX,
  AGENDA_ALL_PROFESSIONALS,
} from '../../shared/agenda.js';
import {
  validateCancelInput,
  APPOINTMENT_STATUS_CONFIRMED,
  APPOINTMENT_STATUS_CANCELLED,
  CANCELLED_BY_OWNER,
} from '../../shared/appointments.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  ServiceUnavailableError,
  AppointmentChangedError,
  AppointmentNotChangeableError,
} from '../../http/errors.js';
import { appointmentVersionOf } from '../appointments/manage-token.js';
import { noAppointmentEvents, emitAfterCommit } from '../appointments/appointment-events-port.js';
import { enqueueEmail as enqueueEmailDefault } from '../email/enqueue-email.js';
import { EMAIL_KIND_CANCELLED_BY_OWNER } from '../email/email-rules.js';
import { toOwnerAgendaAppointment, toOwnerAgendaBlock, toOwnerAppointmentDetail, emptyAgendaDays } from './agenda.view.js';

const noopLog = { info() {}, warn() {}, error() {} };
const UUID_LENGTH = 36;

const isAppointmentId = (v) => typeof v === 'string' && v.length === UUID_LENGTH && PROFESSIONAL_ID_RE.test(v);
const notFound = () => new NotFoundError('APPOINTMENT_NOT_FOUND', M.notFound);
const iso = (ms) => new Date(ms).toISOString();

/** 'YYYY-MM-DD' -> instante ISO da meia-noite local (ou da 1ª hora válida, num salto às 00:00). */
function midnightIso(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  return iso(localToInstant({ year, month, day, hour: 0, minute: 0 }, timeZone).ms);
}

/** Erros que passam como estão (nunca viram 503). */
function isBusinessError(err) {
  return (
    err instanceof NotFoundError ||
    err instanceof ValidationError ||
    err instanceof AppointmentChangedError ||
    err instanceof AppointmentNotChangeableError ||
    (err instanceof ConflictError && err.code === 'BUSINESS_REQUIRED')
  );
}

/** Ordem dentro do dia (4.1): início (o do dia para bloqueio que começou antes), bloqueio antes, name_key, id. */
function compareItems(a, b) {
  if (a.sortStart !== b.sortStart) return a.sortStart < b.sortStart ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.nameKey !== b.nameKey) return a.nameKey < b.nameKey ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Agenda do dono (AF-14). O negócio vem sempre da sessão. Nada aqui loga nome, telefone, e-mail,
 * horário local nem o corpo das respostas (critério 16). `nowMs` é lido UMA vez por requisição.
 * Ordem global de travas: o cancelamento toca appointments -> appointment_manage_tokens -> email_outbox,
 * nessa ordem, e nunca trava businesses, services ou professionals.
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   businessesRepository: object, professionalsRepository: object, appointmentsRepository: object,
 *   timeBlocksRepository: object, customersRepository: object, manageTokensRepository: object,
 *   reschedulesRepository: object,
 *   appointmentEvents?: import('../appointments/appointment-events-port.js').AppointmentEventsPort,
 *   enqueueEmail?: typeof enqueueEmailDefault,
 *   emailEnabled: boolean,
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createAgendaService({
  db,
  businessesRepository,
  professionalsRepository,
  appointmentsRepository,
  timeBlocksRepository,
  customersRepository,
  manageTokensRepository,
  reschedulesRepository,
  appointmentEvents = noAppointmentEvents,
  enqueueEmail = enqueueEmailDefault,
  emailEnabled,
  now = () => new Date(),
  log = noopLog,
}) {
  async function businessOf(ownerId) {
    const business = await businessesRepository.findByOwnerId(ownerId);
    if (!business) throw new ConflictError('BUSINESS_REQUIRED', M.businessRequired);
    return business;
  }

  function failed(err, operation) {
    const cause = err?.cause && err.name === 'BusyUnavailableError' ? err.cause : err;
    log.warn({ event: 'agenda_failed', operation, errCode: cause?.code, errName: cause?.name });
    return new ServiceUnavailableError('AGENDA_UNAVAILABLE', operation === 'cancel' ? M.cancelUnavailable : M.unavailable);
  }

  /** Erros de negócio passam; o resto vira 503 AGENDA_UNAVAILABLE (nada gravado). */
  async function guarded(operation, fn) {
    try {
      return await fn();
    } catch (err) {
      if (isBusinessError(err)) throw err;
      throw failed(err, operation);
    }
  }

  /** Corpo do detalhe (5.2 passos 3 e 4), lido em `conn` (o `db` ou a `tx` do cancelamento). */
  async function detailOf(row, business, nowMs, conn) {
    const timeZone = business.timezone || DEFAULT_TIME_ZONE;
    const customer = await customersRepository.findById(row.customerId, business.id, conn);
    const prevId = await reschedulesRepository.previousOf(row.id, business.id, conn);
    const nextId = await reschedulesRepository.nextOf(row.id, business.id, conn);
    const previous = prevId ? await appointmentsRepository.findById(prevId, business.id, conn) : null;
    const next = nextId ? await appointmentsRepository.findById(nextId, business.id, conn) : null;
    return toOwnerAppointmentDetail({ row, customer, previous, next, timeZone, nowMs, emailEnabled });
  }

  return {
    /**
     * GET /api/agenda (5.1). Fora de transação, só leitura, três consultas fixas.
     * @throws {ConflictError|ValidationError|ServiceUnavailableError}
     */
    async list(ownerId, query) {
      return guarded('list', async () => {
        const nowMs = now().getTime();
        const business = await businessOf(ownerId);
        const timeZone = business.timezone || DEFAULT_TIME_ZONE;
        const nowLocal = instantToLocal(nowMs, timeZone);
        const checked = validateAgendaQuery(query, { today: nowLocal.slice(0, 10) });
        if (!checked.ok) throw new ValidationError(checked.fields);
        const { from, to, dates, professionalId, includeCancelled } = checked.value;
        const payload = { timezone: timeZone, now: nowLocal, from, to, days: emptyAgendaDays(dates), truncated: false };

        const filter = professionalId === AGENDA_ALL_PROFESSIONALS ? null : professionalId;
        if (filter) {
          // Só ativo e do negócio: outro negócio, inexistente e removido dão a mesma lista vazia (C-2).
          const professional = await professionalsRepository.findById(filter, business.id);
          if (!professional) return payload;
        }
        // Fronteiras por localToInstant de cada meia-noite (nunca + 24 h).
        const boundaries = [...dates, addLocalDays(to, 1) || '2100-01-01'].map((d) => midnightIso(d, timeZone));
        const fromIso = boundaries[0];
        const toIso = boundaries[boundaries.length - 1];

        const rows = await appointmentsRepository.listForAgenda(business.id, {
          fromIso,
          toIso,
          professionalId: filter,
          includeCancelled,
          limit: AGENDA_ITEMS_MAX + 1,
        });
        const counts = await appointmentsRepository.countForAgenda(business.id, { boundaries, professionalId: filter });
        // C-5: null = todos os bloqueios do negócio (no AF-16, 'all' é "só os de todos").
        const blocks = await timeBlocksRepository.list(business.id, {
          professionalId: filter,
          fromIso,
          toIso,
          nowIso: iso(nowMs),
          limit: TIME_BLOCKS_LIST_MAX,
        });

        const perDay = dates.map(() => []);
        let day = 0;
        for (const row of rows) {
          while (day < dates.length - 1 && row.startsAt >= boundaries[day + 1]) day += 1;
          perDay[day].push({
            sortStart: row.startsAt,
            rank: 1,
            nameKey: row.professionalNameKey ?? '',
            id: row.id,
            item: toOwnerAgendaAppointment(row, timeZone),
          });
        }
        for (const block of blocks.rows) {
          const item = toOwnerAgendaBlock(block, timeZone);
          const nameKey = block.professionalId ? professionalNameKey(block.professionalName ?? '') : '';
          for (let i = 0; i < dates.length; i++) {
            if (block.startsAt < boundaries[i + 1] && block.endsAt > boundaries[i]) {
              perDay[i].push({
                sortStart: block.startsAt > boundaries[i] ? block.startsAt : boundaries[i],
                rank: 0,
                // Bloqueio de "todos" primeiro: chave vazia vem antes de qualquer nome.
                nameKey: block.professionalId ? `\u0001${nameKey}` : '',
                id: block.id,
                item,
              });
            }
          }
        }

        let budget = AGENDA_ITEMS_MAX;
        let truncated = rows.length > AGENDA_ITEMS_MAX || blocks.truncated;
        payload.days = payload.days.map((d, i) => {
          const sorted = perDay[i].sort(compareItems);
          const kept = sorted.slice(0, Math.max(budget, 0));
          if (kept.length < sorted.length) truncated = true;
          budget -= kept.length;
          return { ...d, counts: counts[i], items: kept.map((entry) => entry.item) };
        });
        payload.truncated = truncated;
        return payload;
      });
    },

    /**
     * GET /api/agenda/appointments/:id (5.2). Malformado, inexistente e de outro negócio: o mesmo 404.
     * @throws {ConflictError|NotFoundError|ServiceUnavailableError}
     */
    async detail(ownerId, rawId) {
      return guarded('detail', async () => {
        const nowMs = now().getTime();
        const business = await businessOf(ownerId);
        if (!isAppointmentId(rawId)) throw notFound();
        const row = await appointmentsRepository.findById(rawId, business.id);
        if (!row) throw notFound();
        return detailOf(row, business, nowMs, db);
      });
    },

    /**
     * POST /api/agenda/appointments/:id/cancel (5.3, critérios 21 a 30). Tudo na transação, só com `tx`:
     * autoriza, `cancelIfConfirmed` com `changes === 1` e `cancelled_by = 'owner'`, revoga os tokens
     * (`cancelled`, C-7) e enfileira o e-mail como ÚLTIMA escrita. Qualquer falha: ROLLBACK completo.
     * @returns {Promise<object>} o detalhe com `outcome: 'cancelled' | 'unchanged'`
     */
    async cancel(ownerId, rawId, body) {
      const nowMs = now().getTime();
      const nowIso = iso(nowMs);
      const business = await guarded('cancel', () => businessOf(ownerId));
      if (!isAppointmentId(rawId)) throw notFound();
      const input = validateCancelInput(body);
      if (!input.ok) throw new ValidationError(undefined, M.badRequest);
      const refused = (reason) => log.info({ event: 'appointment_owner_cancel_refused', userId: ownerId, businessId: business.id, reason });

      const outcome = await guarded('cancel', () =>
        db.transaction(async (tx) => {
          /** Passo 2: já cancelado. Com sucessor (antigo de remarcação, C-9): 409; sem: repetição. */
          const repeatOrChanged = async (row) => {
            if (await reschedulesRepository.nextOf(row.id, business.id, tx)) {
              refused('rescheduled');
              throw new AppointmentChangedError(M.changed);
            }
            return { repeated: true, row, body: await detailOf(row, business, nowMs, tx) };
          };

          const row = await appointmentsRepository.findById(rawId, business.id, tx);
          if (!row) throw notFound();
          if (row.status === APPOINTMENT_STATUS_CANCELLED) return repeatOrChanged(row);
          if (input.version !== appointmentVersionOf(row)) {
            refused('version');
            throw new AppointmentChangedError(M.changed);
          }
          if (row.status !== APPOINTMENT_STATUS_CONFIRMED) {
            refused('status');
            throw new AppointmentNotChangeableError(M.notChangeable);
          }
          // Sem antecedência (critério 22): só antes do fim, inclusive em andamento.
          if (row.endsAt <= nowIso) {
            refused('ended');
            throw new AppointmentNotChangeableError(M.notChangeable);
          }
          const { changes } = await appointmentsRepository.cancelIfConfirmed(row.id, business.id, nowIso, tx, {
            cancelledBy: CANCELLED_BY_OWNER,
          });
          if (changes !== 1) {
            // PostgreSQL: o perdedor de uma disputa espera o vencedor e vê 0 linhas; relê e decide.
            const again = await appointmentsRepository.findById(row.id, business.id, tx);
            if (again && again.status === APPOINTMENT_STATUS_CANCELLED) return repeatOrChanged(again);
            refused('status');
            throw new AppointmentNotChangeableError(M.notChangeable);
          }
          await manageTokensRepository.revokeForAppointment(business.id, row.id, 'cancelled', nowIso, tx);
          // AF-18 (critério 6): o e-mail nasce NESTA transação, como última escrita (decisão 2: sempre).
          const email = await enqueueEmail(tx, {
            kind: EMAIL_KIND_CANCELLED_BY_OWNER,
            businessId: business.id,
            appointmentId: row.id,
            nowIso,
          });
          const updated = await appointmentsRepository.findById(row.id, business.id, tx);
          return { repeated: false, row: updated, email, body: await detailOf(updated, business, nowMs, tx) };
        }),
      );

      const ids = { userId: ownerId, businessId: business.id, appointmentId: outcome.row.id };
      if (outcome.repeated) {
        log.info({ event: 'appointment_owner_cancel_repeated', ...ids });
        return { ...outcome.body, outcome: 'unchanged' };
      }
      log.info({ event: 'appointment_cancelled_by_owner', ...ids });
      if (outcome.email?.enqueued) {
        log.info({ event: 'email_enqueued', outboxId: outcome.email.id, kind: EMAIL_KIND_CANCELLED_BY_OWNER });
      }
      // Só acorda o worker; falha da porta não muda nada.
      emitAfterCommit(appointmentEvents, 'cancelled', { appointmentId: outcome.row.id, businessId: business.id }, log);
      return { ...outcome.body, outcome: 'cancelled' };
    },
  };
}
