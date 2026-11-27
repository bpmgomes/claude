import { instantToLocal } from '../../shared/zoned-time.js';
import { DEFAULT_TIME_ZONE } from '../../shared/time-blocks.js';
import { ANY_PROFESSIONAL } from '../../shared/availability.js';
import {
  parseManageToken,
  changeWindow,
  validateCancelInput,
  validateRescheduleInput,
  validateManageAvailabilityQuery,
  MANAGE_MESSAGES as MM,
  MANAGE_TOKEN_RETENTION_DAYS,
  RESCHEDULES_PER_CHAIN_MAX,
  APPOINTMENT_STATUS_CONFIRMED,
  APPOINTMENT_STATUS_CANCELLED,
  CANCELLED_BY_CUSTOMER,
  CANCELLED_BY_RESCHEDULE,
} from '../../shared/appointments.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  SlotUnavailableError,
  ServiceUnavailableError,
  AppointmentNotChangeableError,
  AppointmentChangedError,
  RescheduleLimitReachedError,
} from '../../http/errors.js';
import { ExclusionViolationError, UniqueViolationError } from '../../db/errors.js';
import { hashManageToken, appointmentVersionOf } from './manage-token.js';
import { enqueueEmail as enqueueEmailDefault } from '../email/enqueue-email.js';
import { EMAIL_KIND_CANCELLED, EMAIL_KIND_RESCHEDULED } from '../email/email-rules.js';
import { toPublicManage, toPublicManageAvailability } from './manage.view.js';
import { noAppointmentEvents, emitAfterCommit } from './appointment-events-port.js';

const noopLog = { info() {}, warn() {}, error() {} };
const DAY_MS = 86_400_000;

/** Índice único parcial do mesmo início (AF-11): sobreposição recusada pelo banco = horário ocupado. */
const SAME_START_CONSTRAINT = 'appointments_professional_id_starts_at_unique';
/** PK e UNIQUE de appointment_reschedules, pelo nome que o translateError reconstrói. */
const RESCHEDULE_CONSTRAINTS = Object.freeze([
  'appointment_reschedules_previous_appointment_id_unique',
  'appointment_reschedules_appointment_id_unique',
]);

const linkNotFound = () => new NotFoundError('NOT_FOUND', MM.linkInvalid);
const unavailable = () => new ServiceUnavailableError('MANAGE_UNAVAILABLE', MM.unavailable);

function isSlotTaken(err) {
  if (err instanceof SlotUnavailableError || err instanceof ExclusionViolationError) return true;
  return err instanceof UniqueViolationError && err.constraint === SAME_START_CONSTRAINT;
}

/** Erros que passam como estão (nunca viram 503). */
function isBusinessError(err) {
  return (
    err instanceof NotFoundError ||
    err instanceof ValidationError ||
    err instanceof SlotUnavailableError ||
    err instanceof AppointmentNotChangeableError ||
    err instanceof AppointmentChangedError ||
    err instanceof RescheduleLimitReachedError ||
    (err instanceof ConflictError && err.code === 'BOOKING_LIMIT_REACHED')
  );
}

/**
 * Gerenciar o agendamento pelo link (AF-12, design 5). O token determina o negócio: toda leitura e
 * escrita filtra pelo `business_id` do token (critério 36). Nada aqui loga token, hash, URL, horário
 * local nem dado do cliente (critério 10). `nowMs` é lido UMA vez por requisição (critério 20).
 *
 * Ordem global de travas: businesses -> services -> professionals (por id) -> appointments ->
 * appointment_manage_tokens / appointment_reschedules. Remarcar trava serviço e profissional(is)
 * (`lockForBooking`) ANTES de cancelar o antigo; cancelar só toca appointments e tokens.
 *
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   businessesRepository: object, servicesRepository: object, professionalsRepository: object,
 *   appointmentsRepository: object, manageTokensRepository: object, reschedulesRepository: object,
 *   appointmentsService: { bookSlot: Function, lockForBooking: Function },
 *   availabilityService: { findForReschedule: Function, findSuggestions: Function },
 *   appointmentEvents?: import('./appointment-events-port.js').AppointmentEventsPort,
 *   enqueueEmail?: typeof enqueueEmailDefault,   // fila de e-mails na tx (AF-18)
 *   config: { publicBaseUrl: string },
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createManageService({
  db,
  businessesRepository,
  servicesRepository,
  professionalsRepository,
  appointmentsRepository,
  manageTokensRepository,
  reschedulesRepository,
  appointmentsService,
  availabilityService,
  appointmentEvents = noAppointmentEvents,
  enqueueEmail = enqueueEmailDefault,
  config,
  now = () => new Date(), // utc
  log = noopLog,
}) {
  const publicBaseUrl = config.publicBaseUrl;

  /**
   * 5.1: hash, token vivo, agendamento (pelo business_id do token) e negócio (antecedência ATUAL,
   * critério 3). Inexistente e vencido percorrem o mesmo SQL (critério 35). Tudo em `conn`.
   * @returns {Promise<{ token: string, t: object, row: object, business: object }|null>}
   */
  async function resolve(token, nowIso, conn) {
    const t = await manageTokensRepository.findLiveByHash(hashManageToken(token), nowIso, conn);
    if (!t) return null;
    const row = await appointmentsRepository.findById(t.appointmentId, t.businessId, conn);
    if (!row || row.endsAt <= nowIso) return null;
    const business = await businessesRepository.findById(t.businessId, conn);
    if (!business) return null;
    return { token, t, row, business };
  }

  function windowOf(row, business, nowMs) {
    return changeWindow({
      status: row.status,
      startsAtMs: Date.parse(row.startsAt),
      nowMs,
      leadMinutes: business.cancellationLeadMinutes,
    });
  }

  /** Profissionais listados que realizam o serviço (o mesmo critério do resolveBookable). */
  async function eligibleFor(businessId, serviceId, conn) {
    const listed = await professionalsRepository.findListedByBusinessId(businessId, conn);
    return listed.filter((p) => (p.services || []).some((s) => s.id === serviceId));
  }

  /** `reschedule.allowed`, `sameProfessional` e `notice` do resumo (design 4.1). Só leitura. */
  async function rescheduleInfo({ row, business }, nowMs, conn) {
    if (!windowOf(row, business, nowMs).canChange) return { allowed: false, sameProfessional: false, notice: null };
    const eligible = await eligibleFor(business.id, row.serviceId, conn);
    const sameProfessional = eligible.some((p) => p.id === row.professionalId);
    const sequence = await reschedulesRepository.sequenceOf(row.id, business.id, conn);
    if (sequence >= RESCHEDULES_PER_CHAIN_MAX) return { allowed: false, sameProfessional, notice: MM.rescheduleLimit };
    const service = await servicesRepository.findBookable(business.id, row.serviceId, conn);
    if (!service || eligible.length === 0) {
      return { allowed: false, sameProfessional, notice: MM.rescheduleServiceUnavailable };
    }
    return { allowed: true, sameProfessional, notice: null };
  }

  async function summaryOf(resolved, nowMs, conn) {
    return toPublicManage({
      row: resolved.row,
      business: resolved.business,
      publicBaseUrl,
      nowMs,
      reschedule: await rescheduleInfo(resolved, nowMs, conn),
    });
  }

  /** NotFoundError das travas/reserva -> a variante fixa do 409 (design 5.4 passo 8). */
  async function notBookableError(business, serviceId, target, conn) {
    if (target === ANY_PROFESSIONAL) return new AppointmentNotChangeableError(MM.rescheduleServiceUnavailable);
    const eligible = await eligibleFor(business.id, serviceId, conn);
    return new AppointmentNotChangeableError(
      eligible.length === 0 ? MM.rescheduleServiceUnavailable : MM.professionalUnavailable,
    );
  }

  function failed(err, operation) {
    const cause = err?.cause && err.name === 'BusyUnavailableError' ? err.cause : err;
    log.warn({ event: 'appointment_manage_failed', operation, errCode: cause?.code, errName: cause?.name });
    return unavailable();
  }

  function refused(businessId, reason) {
    log.info({ event: 'appointment_change_refused', businessId, reason });
  }

  /** Erros de negócio passam; o resto vira 503 MANAGE_UNAVAILABLE (nada gravado). */
  async function guarded(operation, fn) {
    try {
      return await fn();
    } catch (err) {
      if (isBusinessError(err)) throw err;
      throw failed(err, operation);
    }
  }

  return {
    /**
     * Resumo do agendamento do link (5.2). Fora de transação (só leitura).
     * @returns {Promise<{ status: 200, body: object }>}
     */
    async get(rawToken) {
      const token = parseManageToken(rawToken);
      if (!token) throw linkNotFound();
      return guarded('get', async () => {
        const nowMs = now().getTime();
        const nowIso = new Date(nowMs).toISOString();
        const resolved = await resolve(token, nowIso, db);
        if (!resolved) throw linkNotFound();
        return { status: 200, body: await summaryOf(resolved, nowMs, db) };
      });
    },

    /**
     * Horários para remarcar (5.5). Só leitura; o reschedule repete tudo na transação.
     * @returns {Promise<{ status: 200, body: object }>}
     */
    async availability(rawToken, query) {
      const token = parseManageToken(rawToken);
      if (!token) throw linkNotFound();
      return guarded('availability', async () => {
        const nowMs = now().getTime();
        const nowIso = new Date(nowMs).toISOString();
        const resolved = await resolve(token, nowIso, db);
        const timeZone = resolved?.business.timezone || DEFAULT_TIME_ZONE;
        const today = instantToLocal(nowMs, timeZone).slice(0, 10);
        const checked = validateManageAvailabilityQuery(query, { today });
        if (!checked.ok) throw new ValidationError(checked.fields);
        if (!resolved) throw linkNotFound();
        const { row, business } = resolved;
        if (!windowOf(row, business, nowMs).canChange) throw new AppointmentNotChangeableError();
        if ((await reschedulesRepository.sequenceOf(row.id, business.id, db)) >= RESCHEDULES_PER_CHAIN_MAX) {
          throw new RescheduleLimitReachedError();
        }
        if (!(await servicesRepository.findBookable(business.id, row.serviceId, db))) {
          throw new AppointmentNotChangeableError(MM.rescheduleServiceUnavailable);
        }
        const target = checked.value.professionalId ?? row.professionalId;
        let result;
        try {
          result = await availabilityService.findForReschedule({
            business,
            serviceId: row.serviceId,
            professionalId: target,
            date: checked.value.date,
            nowMs,
            excludeAppointmentId: row.id,
          });
        } catch (err) {
          if (err instanceof NotFoundError) throw await notBookableError(business, row.serviceId, target, db);
          throw err;
        }
        return { status: 200, body: toPublicManageAvailability(result) };
      });
    },

    /**
     * Cancela (5.3, critérios 17 a 21). A autorização é refeita na transação, só com `tx`.
     * @returns {Promise<{ status: 200, body: object }>}
     */
    async cancel(rawToken, body) {
      const token = parseManageToken(rawToken);
      if (!token) throw linkNotFound();
      const input = validateCancelInput(body);
      if (!input.ok) throw new ValidationError(undefined, MM.badRequest);
      const nowMs = now().getTime();
      const nowIso = new Date(nowMs).toISOString();
      let outcome;
      try {
        // Pré-checagem do 404 sem BEGIN IMMEDIATE.
        if (!(await resolve(token, nowIso, db))) throw linkNotFound();
        outcome = await db.transaction(async (tx) => {
          const current = await resolve(token, nowIso, tx);
          if (!current) throw linkNotFound();
          const { t, row, business } = current;
          const isRepeat = (r) => r.row.status === APPOINTMENT_STATUS_CANCELLED && r.t.revokedReason === 'cancelled';
          // 2. Repetição (critério 19): antes da versão, porque o retry depois do sucesso leva a antiga.
          if (isRepeat(current)) return { repeated: true, current, body: await summaryOf(current, nowMs, tx) };
          if (input.version !== appointmentVersionOf(row)) {
            refused(business.id, 'version');
            throw new AppointmentChangedError();
          }
          if (row.status !== APPOINTMENT_STATUS_CONFIRMED || t.revokedAt !== null) {
            refused(business.id, 'status');
            throw new AppointmentNotChangeableError();
          }
          if (!windowOf(row, business, nowMs).canChange) {
            refused(business.id, 'deadline');
            throw new AppointmentNotChangeableError();
          }
          const { changes } = await appointmentsRepository.cancelIfConfirmed(row.id, business.id, nowIso, tx, {
            cancelledBy: CANCELLED_BY_CUSTOMER,
          });
          if (changes !== 1) {
            // PostgreSQL: o segundo de dois cancelamentos simultâneos espera o primeiro e vê 0 linhas.
            const again = await resolve(token, nowIso, tx);
            if (again && isRepeat(again)) return { repeated: true, current: again, body: await summaryOf(again, nowMs, tx) };
            refused(business.id, 'status');
            throw new AppointmentNotChangeableError();
          }
          await manageTokensRepository.revokeForAppointment(business.id, row.id, 'cancelled', nowIso, tx);
          // AF-18 (critérios 3 e 6): o e-mail de cancelamento nasce NESTA transação, como última escrita.
          const email = await enqueueEmail(tx, {
            kind: EMAIL_KIND_CANCELLED,
            businessId: business.id,
            appointmentId: row.id,
            nowIso,
          });
          const updated = { ...current, row: await appointmentsRepository.findById(row.id, business.id, tx) };
          return { repeated: false, current: updated, email, body: await summaryOf(updated, nowMs, tx) };
        });
      } catch (err) {
        if (isBusinessError(err)) throw err;
        throw failed(err, 'cancel');
      }
      const { row, business } = outcome.current;
      if (outcome.repeated) {
        log.info({ event: 'appointment_cancel_repeated', businessId: business.id, appointmentId: row.id });
      } else {
        log.info({ event: 'appointment_cancelled', businessId: business.id, appointmentId: row.id });
        if (outcome.email.enqueued) log.info({ event: 'email_enqueued', outboxId: outcome.email.id, kind: EMAIL_KIND_CANCELLED });
        emitAfterCommit(appointmentEvents, 'cancelled', { appointmentId: row.id, businessId: business.id }, log);
      }
      return { status: 200, body: outcome.body };
    },

    /**
     * Remarca (5.4, critérios 25 a 32): numa transação, autoriza o antigo, trava serviço e
     * profissional(is) do novo, cancela o antigo com `changes === 1` e SÓ ENTÃO chama `bookSlot`.
     * Qualquer falha: ROLLBACK completo, o antigo continua `confirmed`.
     * @returns {Promise<{ status: 200, body: object }>}
     */
    async reschedule(rawToken, body) {
      const token = parseManageToken(rawToken);
      if (!token) throw linkNotFound();
      const nowMs = now().getTime();
      const nowIso = new Date(nowMs).toISOString();
      let precheck;
      try {
        precheck = await resolve(token, nowIso, db);
      } catch (err) {
        throw failed(err, 'reschedule');
      }
      const timeZone = precheck?.business.timezone || DEFAULT_TIME_ZONE;
      const input = validateRescheduleInput(body, { today: instantToLocal(nowMs, timeZone).slice(0, 10) });
      if (!input.ok && input.fields) throw new ValidationError(input.fields);
      if (!input.ok) throw new ValidationError(undefined, MM.badRequest);
      if (!precheck) throw linkNotFound();
      const { start, professionalId, version } = input.value;

      // Contexto lido na transação, para as sugestões e os logs depois do ROLLBACK/COMMIT.
      let ctx = { row: precheck.row, business: precheck.business, target: professionalId ?? precheck.row.professionalId };
      let outcome;
      try {
        outcome = await db.transaction(async (tx) => {
          const current = await resolve(token, nowIso, tx);
          if (!current) throw linkNotFound();
          const { row, business } = current;
          const target = professionalId ?? row.professionalId;
          ctx = { row, business, target };

          // 3. Nada muda (critério 31): sem gravar, sem conferir a versão (retry depois do sucesso).
          if (
            row.status === APPOINTMENT_STATUS_CONFIRMED &&
            instantToLocal(Date.parse(row.startsAt), business.timezone || DEFAULT_TIME_ZONE) === start &&
            (target === ANY_PROFESSIONAL || target === row.professionalId)
          ) {
            return { noop: true, current, body: await summaryOf(current, nowMs, tx) };
          }
          // 4. Versão (critério 22 (a)): os perdedores de uma disputa caem aqui.
          if (version !== appointmentVersionOf(row)) {
            refused(business.id, 'version');
            throw new AppointmentChangedError();
          }
          // 5. Status e prazo.
          if (row.status !== APPOINTMENT_STATUS_CONFIRMED || current.t.revokedAt !== null) {
            refused(business.id, 'status');
            throw new AppointmentNotChangeableError();
          }
          if (!windowOf(row, business, nowMs).canChange) {
            refused(business.id, 'deadline');
            throw new AppointmentNotChangeableError();
          }
          // 6. Limite da cadeia.
          const sequence = await reschedulesRepository.sequenceOf(row.id, business.id, tx);
          if (sequence >= RESCHEDULES_PER_CHAIN_MAX) {
            refused(business.id, 'limit');
            throw new RescheduleLimitReachedError();
          }
          // 7. Serviço ainda reservável (critério 42).
          if (!(await servicesRepository.findBookable(business.id, row.serviceId, tx))) {
            refused(business.id, 'service');
            throw new AppointmentNotChangeableError(MM.rescheduleServiceUnavailable);
          }
          // 8. Travas ANTES do cancelamento (ordem global; R6).
          try {
            await appointmentsService.lockForBooking(tx, { business, serviceId: row.serviceId, professionalId: target });
          } catch (err) {
            if (!(err instanceof NotFoundError)) throw err;
            const translated = await notBookableError(business, row.serviceId, target, tx);
            refused(business.id, translated.message === MM.professionalUnavailable ? 'professional' : 'service');
            throw translated;
          }
          // 9. Cancela o antigo (decisão 1), exigindo changes === 1 (critério 21). Origem `reschedule` (AF-14).
          const { changes } = await appointmentsRepository.cancelIfConfirmed(row.id, business.id, nowIso, tx, {
            cancelledBy: CANCELLED_BY_RESCHEDULE,
          });
          if (changes !== 1) {
            refused(business.id, 'status');
            throw new AppointmentNotChangeableError();
          }
          // 10. Cria o novo pelo ponto único de reserva (sem INSERT próprio), com o cliente e o
          // snapshot do antigo; snapshot do serviço lido de novo (critério 26).
          let booked;
          try {
            booked = await appointmentsService.bookSlot(tx, {
              business,
              serviceId: row.serviceId,
              professionalId: target,
              start,
              customerId: row.customerId,
              customerSnapshot: { name: row.customerName, phone: row.customerPhone },
              nowMs,
            });
          } catch (err) {
            if (!(err instanceof NotFoundError)) throw err;
            throw await notBookableError(business, row.serviceId, target, tx);
          }
          // 11. Elo da cadeia.
          await reschedulesRepository.insert(
            {
              businessId: business.id,
              previousAppointmentId: row.id,
              appointmentId: booked.appointmentId,
              sequence: sequence + 1,
              createdAt: nowIso,
            },
            tx,
          );
          // 12. O mesmo token passa a apontar para o novo (decisão 4, critério 29).
          const moved = await manageTokensRepository.moveToAppointment(
            business.id,
            row.id,
            booked.appointmentId,
            booked.endsAt,
            tx,
          );
          if (moved.changes === 0) throw new AppointmentNotChangeableError();
          // 13. AF-18 (critérios 3 e 6): o e-mail de remarcação nasce NESTA transação, como última escrita.
          const email = await enqueueEmail(tx, {
            kind: EMAIL_KIND_RESCHEDULED,
            businessId: business.id,
            appointmentId: booked.appointmentId,
            previousAppointmentId: row.id,
            nowIso,
          });
          const next = await appointmentsRepository.findById(booked.appointmentId, business.id, tx);
          const updated = { ...current, row: next };
          return { noop: false, booked, previous: row, current: updated, email, body: await summaryOf(updated, nowMs, tx) };
        });
      } catch (err) {
        // O ROLLBACK já devolveu o antigo a `confirmed`.
        const { row, business, target } = ctx;
        if (isSlotTaken(err)) {
          const suggestions = await availabilityService.findSuggestions({
            business,
            serviceId: row.serviceId,
            professionalId: target,
            afterStart: start,
            nowMs,
            excludeAppointmentId: row.id,
          });
          refused(business.id, 'slot');
          throw new SlotUnavailableError(suggestions);
        }
        if (err instanceof UniqueViolationError && RESCHEDULE_CONSTRAINTS.includes(err.constraint)) {
          refused(business.id, 'status');
          throw new AppointmentNotChangeableError();
        }
        if (isBusinessError(err)) throw err;
        throw failed(err, 'reschedule');
      }

      const { business } = outcome.current;
      if (outcome.noop) {
        log.info({ event: 'appointment_reschedule_noop', businessId: business.id });
        return { status: 200, body: outcome.body };
      }
      const { booked, previous } = outcome;
      log.info({
        event: 'appointment_rescheduled',
        businessId: business.id,
        previousAppointmentId: previous.id,
        appointmentId: booked.appointmentId,
        professionalId: booked.professional.id,
        target: ctx.target === ANY_PROFESSIONAL ? 'any' : 'professional',
      });
      if (outcome.email.enqueued) log.info({ event: 'email_enqueued', outboxId: outcome.email.id, kind: EMAIL_KIND_RESCHEDULED });
      // Só ids (AF-18, decisão 3): a porta apenas acorda o worker; o e-mail leva um token novo.
      emitAfterCommit(
        appointmentEvents,
        'rescheduled',
        { previousAppointmentId: previous.id, appointmentId: booked.appointmentId, businessId: business.id },
        log,
      );
      return { status: 200, body: outcome.body };
    },

    /** Boot (5.6): vencidos há mais de 30 dias, em lotes; nunca impede a subida (falha só é logada). */
    async purgeExpiredTokens() {
      try {
        const cutoff = new Date(now().getTime() - MANAGE_TOKEN_RETENTION_DAYS * DAY_MS).toISOString();
        const count = await manageTokensRepository.purgeExpiredAll(cutoff);
        if (count > 0) log.info({ event: 'manage_tokens_purged', count });
        return count;
      } catch (err) {
        log.warn({ event: 'manage_tokens_purge_failed', errCode: err?.code, errName: err?.name });
        return 0;
      }
    },
  };
}
