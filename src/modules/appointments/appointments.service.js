import { randomUUID, createHash } from 'node:crypto';
import { parsePublicSlug } from '../../shared/slug.js';
import { DEFAULT_TIME_ZONE } from '../../shared/time-blocks.js';
import { instantToLocal, addLocalDays } from '../../shared/zoned-time.js';
import { ANY_PROFESSIONAL, MIN_LEAD_MINUTES } from '../../shared/availability.js';
import {
  validateBookingInput,
  parseIdempotencyKey,
  APPOINTMENT_MESSAGES as M,
  APPOINTMENT_STATUS_CONFIRMED,
  CUSTOMER_FUTURE_APPOINTMENTS_MAX,
  IDEMPOTENCY_TTL_HOURS,
} from '../../shared/appointments.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  SlotUnavailableError,
  IdempotencyKeyReusedError,
  ServiceUnavailableError,
} from '../../http/errors.js';
import { ExclusionViolationError, UniqueViolationError } from '../../db/errors.js';
import { toServiceSnapshot } from '../services/services.repository.js';
import { computeAvailability, isoWeekdayOf } from '../availability/availability-engine.js';
import { midnightIso } from '../availability/availability.service.js';
import { resolveBookable } from '../availability/bookable.js';
import { readLayers, BusyUnavailableError } from '../availability/availability-layers.js';
import { toPublicAppointment } from './appointments.view.js';
import { noAppointmentEvents } from './appointment-events-port.js';

const noopLog = { info() {}, warn() {}, error() {} };
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Índice único parcial do mesmo início (rede mínima portátil, 3.1). */
const SAME_START_CONSTRAINT = 'appointments_professional_id_starts_at_unique';
/** PK de booking_idempotency_keys, pelo nome que o translateError reconstrói. */
const IDEMPOTENCY_CONSTRAINT = 'booking_idempotency_keys_business_id_idempotency_key_unique';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

/** Comparação por código de caractere, igual ao ORDER BY do SQLite (BINARY). */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Recusa do banco por sobreposição (trigger ou índice parcial): o mesmo 409 (critério 21). */
function isOverlapViolation(err) {
  if (err instanceof ExclusionViolationError) return true;
  return err instanceof UniqueViolationError && err.constraint === SAME_START_CONSTRAINT;
}

/** Erros de negócio que passam como estão (nunca viram 503). */
function isBusinessError(err) {
  return (
    err instanceof NotFoundError ||
    err instanceof ValidationError ||
    err instanceof SlotUnavailableError ||
    err instanceof IdempotencyKeyReusedError ||
    (err instanceof ConflictError && err.code === 'BOOKING_LIMIT_REACHED')
  );
}

/**
 * Hash do corpo NORMALIZADO (critério 25): mesmo conteúdo depois de trim, NFC, minúsculas no e-mail
 * e só dígitos no telefone é o mesmo corpo.
 */
function requestHashOf({ serviceId, professionalId, start }, customer) {
  return createHash('sha256')
    .update(JSON.stringify([serviceId, professionalId, start, customer.name, customer.phone, customer.email]))
    .digest('hex');
}

/**
 * Reserva do cliente final (AF-11). Nada aqui loga nome, telefone, e-mail, `customerId`, horário
 * local, slug ou a `Idempotency-Key` (critério 38).
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   businessesRepository: object, servicesRepository: object, professionalsRepository: object,
 *   workingHoursRepository: object, timeBlocksRepository: object,
 *   appointmentsRepository: ReturnType<typeof import('./appointments.repository.js').createAppointmentsRepository>,
 *   appointments: import('./appointments-port.js').AppointmentsPort,
 *   customersService: import('../customers/customers.service.js').CustomersPort,
 *   availabilityService: ReturnType<typeof import('../availability/availability.service.js').createAvailabilityService>,
 *   appointmentEvents?: import('./appointment-events-port.js').AppointmentEventsPort,
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 *   newId?: () => string,
 *   engine?: typeof computeAvailability,
 * }} deps
 */
export function createAppointmentsService({
  db,
  businessesRepository,
  servicesRepository,
  professionalsRepository,
  workingHoursRepository,
  timeBlocksRepository,
  appointmentsRepository,
  appointments,
  customersService,
  availabilityService,
  appointmentEvents = noAppointmentEvents,
  now = () => new Date(),
  log = noopLog,
  newId = randomUUID,
  engine = computeAvailability,
}) {
  const bookableDeps = { servicesRepository, professionalsRepository };
  const layersDeps = { workingHoursRepository, timeBlocksRepository, appointments };

  function logEventFailed(appointmentId, err) {
    log.warn({ event: 'appointment_event_failed', appointmentId, errCode: err?.code, errName: err?.name });
  }

  /** Depois do COMMIT, sem await: nada do que a porta faça muda o 201 (critério 44). */
  function emitConfirmed(appointmentId, businessId) {
    try {
      queueMicrotask(() => {
        let pending;
        try {
          pending = appointmentEvents.confirmed({ appointmentId, businessId });
        } catch (err) {
          logEventFailed(appointmentId, err);
          return;
        }
        Promise.resolve(pending).catch((err) => logEventFailed(appointmentId, err));
      });
    } catch (err) {
      logEventFailed(appointmentId, err);
    }
  }

  /**
   * Checagem e gravação transacional reaproveitável (critério 45; AF-12 remarcar, AF-15 manual).
   * Precisa rodar dentro de db.transaction e usa SÓ `tx` (critério 24). Não captura erros: o
   * chamador desfaz. Ordem (critério 46): resolução, travas (services -> professionals por id),
   * cliente, recheck pelo motor, escolha do profissional, limite por cliente e inserção.
   * @param {import('../../db/index.js').Database} tx
   * @param {{
   *   business: { id: string, timezone: string },
   *   serviceId: string, professionalId: string, start: string,   // já validados (formato)
   *   customerInput: unknown,                 // validado de novo por findOrCreate
   *   nowMs: number,
   *   leadMinutes?: number,                   // padrão MIN_LEAD_MINUTES (60); o AF-15 passa 0
   *   customerLimit?: number|null,            // padrão 3; null desliga (AF-15, dono)
   * }} args
   * @returns {Promise<{ appointmentId: string, professional: { id: string, name: string },
   *   service: import('../services/services.repository.js').ServiceSnapshot,
   *   startsAt: string, endsAt: string, start: string, end: string, weekday: number }>}
   * @throws {NotFoundError|SlotUnavailableError|ConflictError|import('../availability/availability-layers.js').BusyUnavailableError}
   */
  async function bookSlot(tx, args) {
    const {
      business,
      serviceId,
      professionalId,
      start,
      customerInput,
      nowMs,
      leadMinutes = MIN_LEAD_MINUTES,
      customerLimit = CUSTOMER_FUTURE_APPOINTMENTS_MAX,
    } = args;
    const timeZone = business.timezone || DEFAULT_TIME_ZONE;
    const specificId = professionalId === ANY_PROFESSIONAL ? null : professionalId;

    // 1. Resolução autoritativa (o serviço ou o profissional podem ter mudado desde a pré-checagem).
    const resolved = await resolveBookable(bookableDeps, business.id, { serviceId, professionalId }, tx);
    const { service } = resolved;
    let { eligible } = resolved;

    // 2. Travas, na ordem global: services -> professionals (por id). Nunca businesses.
    if ((await servicesRepository.lockBookable(serviceId, business.id, tx)).changes === 0) throw new NotFoundError();
    if (specificId) {
      if ((await professionalsRepository.claimForBooking(specificId, business.id, tx)).changes === 0) {
        throw new NotFoundError();
      }
    } else {
      const claimed = await professionalsRepository.claimManyForBooking(
        eligible.map((p) => p.id),
        business.id,
        tx,
      );
      eligible = eligible.filter((p) => claimed.has(p.id));
      if (eligible.length === 0) throw new NotFoundError();
    }

    // 3. Cliente: sempre INSERT ... DO NOTHING + SELECT (mesmo caminho para novo e antigo, critério 40).
    const { customerId, snapshot } = await customersService.findOrCreate(business.id, customerInput, tx);

    // 4. Recheck com o motor do AF-10, só com leituras na `tx` (critério 10).
    const date = start.slice(0, 10);
    const fromIso = midnightIso(date, timeZone);
    const toIso = midnightIso(addLocalDays(date, 1), timeZone);
    const professionals = await readLayers(layersDeps, business.id, eligible, specificId, fromIso, toIso, tx);
    const result = engine({
      timeZone,
      fromDate: date,
      toDate: date,
      durationMinutes: service.durationMinutes,
      notBeforeMs: nowMs + leadMinutes * MINUTE_MS,
      professionals,
    });
    const slot = result.days[0]?.slots.find((s) => s.start === start);
    const eligibleById = new Map(eligible.map((p) => [p.id, p]));
    const free = slot ? slot.professionalIds.filter((id) => eligibleById.has(id)) : [];
    if (free.length === 0) throw new SlotUnavailableError();

    // 5. Escolha (critérios 12 a 14): menos agendamentos no dia local, depois name_key, depois id.
    let chosenId = free[0];
    if (!specificId && free.length > 1) {
      const counts = await appointmentsRepository.countByProfessionalStartingIn(business.id, fromIso, toIso, tx);
      const ranked = free
        .map((id) => eligibleById.get(id))
        .sort(
          (a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || byCode(a.nameKey, b.nameKey) || byCode(a.id, b.id),
        );
      chosenId = ranked[0].id;
    }
    const chosen = eligibleById.get(chosenId);

    // 6. Limite por cliente (critério 42), sem dizer qual dado estourou.
    const nowIso = new Date(nowMs).toISOString();
    if (customerLimit !== null && customerLimit !== undefined) {
      const { byCustomer, byPhone } = await appointmentsRepository.countFutureForCustomer(
        business.id,
        { customerId, phone: snapshot.phone },
        nowIso,
        tx,
      );
      if (byCustomer >= customerLimit || byPhone >= customerLimit) {
        throw new ConflictError('BOOKING_LIMIT_REACHED', M.limitReached);
      }
    }

    // 7. Inserção. O trigger e o índice parcial são a última barreira (critério 21).
    const snapshotOfService = toServiceSnapshot(service);
    const appointmentId = newId();
    const startsAt = new Date(slot.startMs).toISOString();
    const endsAt = new Date(slot.startMs + service.durationMinutes * MINUTE_MS).toISOString();
    await appointmentsRepository.insert(
      {
        id: appointmentId,
        businessId: business.id,
        professionalId: chosenId,
        customerId,
        serviceId: service.id,
        serviceName: snapshotOfService.name,
        durationMinutes: snapshotOfService.durationMinutes,
        priceCents: snapshotOfService.priceCents,
        customerName: snapshot.name,
        customerPhone: snapshot.phone,
        startsAt,
        endsAt,
        status: APPOINTMENT_STATUS_CONFIRMED,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      tx,
    );

    return {
      appointmentId,
      professional: { id: chosen.id, name: chosen.name },
      service: snapshotOfService,
      startsAt,
      endsAt,
      start: slot.start,
      end: slot.end,
      weekday: isoWeekdayOf(date),
    };
  }

  return {
    bookSlot,

    /**
     * Fluxo público (design 5.1). `idempotencyKey` vem do cabeçalho (string ou undefined).
     * @param {string} rawSlug
     * @param {unknown} body
     * @param {{ idempotencyKey?: unknown }} [options]
     * @returns {Promise<{ status: 201, body: object }>}
     * @throws {NotFoundError|ValidationError|SlotUnavailableError|ConflictError|IdempotencyKeyReusedError|ServiceUnavailableError}
     */
    async book(rawSlug, body, { idempotencyKey } = {}) {
      // Fora da transação, sem trava.
      const parsed = parsePublicSlug(rawSlug);
      if (parsed.kind !== 'ok') throw new NotFoundError();
      const nowMs = now().getTime();
      const nowIso = new Date(nowMs).toISOString();
      const business = await businessesRepository.findBySlug(parsed.slug);
      const timeZone = business?.timezone ?? DEFAULT_TIME_ZONE;
      const today = instantToLocal(nowMs, timeZone).slice(0, 10);

      // Validação de formato, com todos os erros juntos (critério 2), antes de qualquer 404.
      const slot = validateBookingInput(body, { today });
      const fields = { ...(slot.fields || {}) };
      const customerInput = own(body, 'customer');
      let customer = null;
      try {
        customer = customersService.validate(customerInput);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        Object.assign(fields, err.fields || {});
      }
      if (Object.keys(fields).length > 0) throw new ValidationError(fields, M.checkFields);
      const key = parseIdempotencyKey(idempotencyKey);
      if (key === null) throw new ValidationError(undefined, M.badRequest);
      if (!slot.ok || !business) throw new NotFoundError();
      const { serviceId, professionalId, start } = slot.value;
      const target = professionalId === ANY_PROFESSIONAL ? 'any' : 'professional';

      // Pré-checagem do 404, sem BEGIN IMMEDIATE; a resolução autoritativa é repetida na transação.
      await resolveBookable(bookableDeps, business.id, { serviceId, professionalId });

      const requestHash = requestHashOf(slot.value, customer);

      const attempt = () =>
        db.transaction(async (tx) => {
          if (key) {
            const hit = await appointmentsRepository.findIdempotency(business.id, key, nowIso, tx);
            if (hit) {
              if (hit.requestHash !== requestHash) throw new IdempotencyKeyReusedError();
              return { replay: JSON.parse(hit.responseBody), appointmentId: hit.appointmentId };
            }
          }
          const booked = await bookSlot(tx, { business, serviceId, professionalId, start, customerInput, nowMs });
          const responseBody = toPublicAppointment({ booked, business, timezone: timeZone });
          if (key) {
            await appointmentsRepository.insertIdempotency(
              {
                businessId: business.id,
                key,
                requestHash,
                appointmentId: booked.appointmentId,
                responseBody: JSON.stringify(responseBody),
                createdAt: nowIso,
                expiresAt: new Date(nowMs + IDEMPOTENCY_TTL_HOURS * HOUR_MS).toISOString(),
              },
              tx,
            );
          }
          await appointmentsRepository.purgeIdempotency(business.id, nowIso, tx);
          return { booked, responseBody };
        });

      let outcome;
      try {
        try {
          outcome = await attempt();
        } catch (err) {
          // Só no PostgreSQL (duas transações simultâneas com a mesma chave): repete uma vez, e a
          // segunda execução cai no replay.
          if (!(key && err instanceof UniqueViolationError && err.constraint === IDEMPOTENCY_CONSTRAINT)) throw err;
          outcome = await attempt();
        }
      } catch (err) {
        // O ROLLBACK já desfez tudo, inclusive o cliente criado na transação.
        if (err instanceof SlotUnavailableError || isOverlapViolation(err)) {
          const suggestions = await availabilityService.findSuggestions({
            business,
            serviceId,
            professionalId,
            afterStart: start,
            nowMs,
          });
          log.info({ event: 'appointment_slot_taken', businessId: business.id, target, suggestionsCount: suggestions.length });
          throw new SlotUnavailableError(suggestions);
        }
        if (err instanceof ConflictError && err.code === 'BOOKING_LIMIT_REACHED') {
          log.info({ event: 'appointment_limit_reached', businessId: business.id });
          throw err;
        }
        if (isBusinessError(err)) throw err;
        const cause = err instanceof BusyUnavailableError && err.cause ? err.cause : err;
        log.warn({
          event: 'appointment_booking_failed',
          businessId: business.id,
          errCode: cause?.code,
          errName: cause?.name,
        });
        throw new ServiceUnavailableError('BOOKING_UNAVAILABLE', M.unavailable);
      }

      if (outcome.replay) {
        log.info({ event: 'appointment_replayed', businessId: business.id, appointmentId: outcome.appointmentId });
        return { status: 201, body: outcome.replay };
      }
      const { booked, responseBody } = outcome;
      log.info({
        event: 'appointment_created',
        businessId: business.id,
        appointmentId: booked.appointmentId,
        professionalId: booked.professional.id,
        target,
        durationMinutes: booked.service.durationMinutes,
      });
      emitConfirmed(booked.appointmentId, business.id);
      return { status: 201, body: responseBody };
    },

    /** Boot: purga as chaves expiradas em lotes; nunca impede a subida (falha só é logada). */
    async purgeExpiredIdempotencyKeys() {
      try {
        const count = await appointmentsRepository.purgeIdempotencyAll(now().toISOString());
        if (count > 0) log.info({ event: 'booking_idempotency_purged', count });
        return count;
      } catch (err) {
        log.warn({ event: 'booking_idempotency_purge_failed', errCode: err?.code, errName: err?.name });
        return 0;
      }
    },
  };
}
