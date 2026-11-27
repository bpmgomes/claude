import { randomUUID } from 'node:crypto';
import { PROFESSIONAL_ID_RE, PROFESSIONAL_MESSAGES } from '../../shared/professionals.js';
import {
  validateTimeBlockInput,
  validateListQuery,
  toOwnerTimeBlock,
  toOwnerConflict,
  TIME_BLOCK_MESSAGES as M,
  TIME_BLOCK_ID_RE,
  TIME_BLOCKS_ACTIVE_MAX,
  TIME_BLOCKS_ENDED_RETAINED_MAX,
  TIME_BLOCKS_RETENTION_DAYS,
  TIME_BLOCKS_LIST_MAX,
  CONFLICTS_LIST_MAX,
} from '../../shared/time-blocks.js';
import { instantToLocal, wallMinutes, parseLocalDateTime } from '../../shared/zoned-time.js';
import {
  ValidationError,
  ConflictError,
  NotFoundError,
  TimeBlockConflictsError,
  ServiceUnavailableError,
} from '../../http/errors.js';
import { noAppointments } from '../appointments/appointments-port.js';
import { signConflictsToken, verifyConflictsToken } from './conflicts-token.js';

const noopLog = { info() {}, warn() {}, error() {} };
const DAY_MS = 86_400_000;
/** Formato do `versionKey` da porta real (sha256 base64url): exigido quando há conflitos. */
const VERSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export const TIME_ADJUSTED_CODE = 'TIME_BLOCK_TIME_ADJUSTED';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Porta de conflitos com resultado inutilizável (AF-11, critério 37): tratado como falha da porta. */
class MalformedConflictsError extends Error {
  constructor() {
    super('Resultado de findConflictsForBlock inválido.');
    this.name = 'MalformedConflictsError';
    this.code = 'CONFLICTS_MALFORMED';
  }
}

/**
 * Resultado da porta normalizado (defesa contra implementação malformada). Com `total > 0`, o
 * `versionKey` precisa ser string no formato da porta real: vazio, não string ou fora do formato
 * é falha da porta (503), nunca `''` (AF-16 item 2). Com `total === 0`, o `versionKey` não é usado.
 * @throws {MalformedConflictsError}
 */
function normalizeConflicts(found) {
  const total = Number.isInteger(found?.total) && found.total >= 0 ? found.total : 0;
  const items = Array.isArray(found?.items) ? found.items.slice(0, CONFLICTS_LIST_MAX) : [];
  const versionKey = found?.versionKey;
  if (total > 0 && !(typeof versionKey === 'string' && VERSION_KEY_RE.test(versionKey))) {
    throw new MalformedConflictsError();
  }
  return { total, items, versionKey: total > 0 ? versionKey : '' };
}

/** Duração em minutos de parede (só para o log). */
function durationMinutes(start, end) {
  const s = parseLocalDateTime(start);
  const e = parseLocalDateTime(end);
  return s.ok && e.ok ? wallMinutes(e.value) - wallMinutes(s.value) : null;
}

/**
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   timeBlocksRepository: ReturnType<typeof import('./time-blocks.repository.js').createTimeBlocksRepository>,
 *   professionalsRepository: ReturnType<typeof import('../professionals/professionals.repository.js').createProfessionalsRepository>,
 *   businessesRepository: ReturnType<typeof import('../businesses/businesses.repository.js').createBusinessesRepository>,
 *   appointments?: import('../appointments/appointments-port.js').AppointmentsPort,
 *   conflictsTokenSecret: string,   // obrigatório: resolveConflictsTokenSecret (AF-11, critério 36)
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createTimeBlocksService({
  db,
  timeBlocksRepository,
  professionalsRepository,
  businessesRepository,
  appointments = noAppointments,
  conflictsTokenSecret,
  now = () => new Date(), // utc
  log = noopLog,
}) {
  if (typeof conflictsTokenSecret !== 'string' || conflictsTokenSecret.length === 0) {
    throw new TypeError('createTimeBlocksService exige conflictsTokenSecret.');
  }
  /** O negócio vem sempre da sessão; nunca do cliente (critério 20). */
  async function businessOf(ownerId) {
    const business = await businessesRepository.findByOwnerId(ownerId);
    if (!business) throw new ConflictError('BUSINESS_REQUIRED', M.businessRequired);
    return business;
  }

  /** Mesmo corpo do AF-07: inexistente, de outro negócio, removido e malformado não se diferenciam. */
  const professionalNotFound = () => new NotFoundError('PROFESSIONAL_NOT_FOUND', PROFESSIONAL_MESSAGES.notFound);
  const blockNotFound = () => new NotFoundError('TIME_BLOCK_NOT_FOUND', M.notFound);

  const cutoffIso = (nowMs) => new Date(nowMs - TIME_BLOCKS_RETENTION_DAYS * DAY_MS).toISOString();

  function adjustmentWarnings(value, timeZone) {
    const warnings = [];
    for (const [field, iso] of [
      ['start', value.startsAt],
      ['end', value.endsAt],
    ]) {
      if (value.adjusted[field] !== 'gap') continue;
      const hhmm = instantToLocal(Date.parse(iso), timeZone).slice(11);
      warnings.push({ code: TIME_ADJUSTED_CODE, field, message: M.timeAdjusted(hhmm) });
    }
    return warnings;
  }

  return {
    /**
     * Listagem do dono (critério 13). Filtro por profissional alheio, removido ou inexistente:
     * lista vazia, igual nos três casos (critério 20).
     * @returns {Promise<{ timeBlocks: object[], timezone: string, now: string, truncated: boolean }>}
     * @throws {ConflictError|ValidationError}
     */
    async list(ownerId, query) {
      const business = await businessOf(ownerId);
      const timeZone = business.timezone;
      const result = validateListQuery(query, { timeZone });
      if (!result.ok) throw new ValidationError(result.fields);
      const { professionalId, fromIso, toIso } = result.value;
      const nowDate = now();
      const payload = { timeBlocks: [], timezone: timeZone, now: instantToLocal(nowDate.getTime(), timeZone), truncated: false };

      if (professionalId && professionalId !== 'all') {
        const professional = await professionalsRepository.findById(professionalId, business.id);
        if (!professional) return payload;
      }
      const { rows, truncated } = await timeBlocksRepository.list(business.id, {
        professionalId,
        fromIso,
        toIso,
        nowIso: nowDate.toISOString(),
        limit: TIME_BLOCKS_LIST_MAX,
      });
      payload.timeBlocks = rows.map((row) => toOwnerTimeBlock(row, timeZone));
      payload.truncated = truncated;
      return payload;
    },

    /**
     * Cria o bloqueio (critérios 2 a 12). Os conflitos são calculados DENTRO da transação de
     * criação; com conflitos e sem o token que confere, nada é gravado (409).
     * @returns {Promise<{ timeBlock: object, acknowledgedConflictsCount: number, warnings: object[] }>}
     * @throws {ConflictError|ValidationError|NotFoundError|TimeBlockConflictsError|ServiceUnavailableError}
     */
    async create(ownerId, input) {
      const business = await businessOf(ownerId);
      const timeZone = business.timezone;
      const src = isObject(input) ? input : {};
      if (typeof src.professionalId === 'string' && !PROFESSIONAL_ID_RE.test(src.professionalId)) {
        throw professionalNotFound();
      }
      const nowDate = now();
      const nowMs = nowDate.getTime();
      const result = validateTimeBlockInput(src, { timeZone, nowMs });
      if (!result.ok) throw new ValidationError(result.fields);
      const value = result.value;
      const block = { professionalId: value.professionalId, startsAt: value.startsAt, endsAt: value.endsAt };
      const sentToken = src.confirmConflictsToken;
      const nowIso = nowDate.toISOString();
      const id = randomUUID();

      let found;
      try {
        found = await db.transaction(async (tx) => {
          // Ordem de travas: businesses antes de professionals (design 4.5, R4).
          await businessesRepository.lockById(business.id, tx);
          if (value.professionalId) {
            const { changes } = await professionalsRepository.lockActive(value.professionalId, business.id, tx);
            if (changes === 0) throw professionalNotFound();
          } else {
            await professionalsRepository.lockAllActive(business.id, tx);
          }
          await timeBlocksRepository.purgeEnded(business.id, cutoffIso(nowMs), tx);
          await timeBlocksRepository.trimEnded(business.id, nowIso, TIME_BLOCKS_ENDED_RETAINED_MAX, tx);
          if ((await timeBlocksRepository.countActive(business.id, nowIso, tx)) >= TIME_BLOCKS_ACTIVE_MAX) {
            throw new ConflictError('TIME_BLOCK_LIMIT_REACHED', M.limitReached);
          }

          let conflicts;
          try {
            conflicts = normalizeConflicts(
              await appointments.findConflictsForBlock(business.id, block, CONFLICTS_LIST_MAX, tx),
            );
          } catch (err) {
            // A causa é logada sem dado de cliente (AF-16 item 4): só o código e o tipo.
            log.warn({
              event: 'time_block_conflicts_failed',
              userId: ownerId,
              businessId: business.id,
              errCode: err?.code,
              errName: err?.name,
            });
            throw new ServiceUnavailableError('CONFLICTS_UNAVAILABLE', M.conflictsUnavailable);
          }

          if (conflicts.total > 0) {
            // O token é preso ao usuário da sessão, ao negócio, ao alvo, ao período, à lista e ao
            // prazo (AF-16 item 1). Qualquer divergência é "a lista mudou", nunca 400 e sem eco.
            const claims = { userId: ownerId, businessId: business.id, ...block, versionKey: conflicts.versionKey };
            if (!verifyConflictsToken(conflictsTokenSecret, sentToken, claims, nowMs)) {
              const changed = sentToken !== undefined && sentToken !== null;
              throw new TimeBlockConflictsError(
                changed ? 'TIME_BLOCK_CONFLICTS_CHANGED' : 'TIME_BLOCK_CONFLICTS',
                changed ? M.conflictsChanged : M.conflicts,
                {
                  conflicts: conflicts.items.map((item) => toOwnerConflict(item, timeZone)),
                  conflictsTotal: conflicts.total,
                  conflictsToken: signConflictsToken(conflictsTokenSecret, claims, nowMs),
                },
              );
            }
          }

          await timeBlocksRepository.insert(
            {
              id,
              businessId: business.id,
              professionalId: value.professionalId,
              startsAt: value.startsAt,
              endsAt: value.endsAt,
              reasonKind: value.reasonKind,
              reasonNote: value.reasonNote,
              createdAt: nowIso,
            },
            tx,
          );
          // Lido na própria transação: depois do COMMIT, uma remoção concorrente do profissional
          // pode apagar o bloqueio antes da resposta (a remoção vence e o bloqueio some, 5.4).
          const row = await timeBlocksRepository.findById(id, business.id, tx);
          return { conflicts, row };
        });
      } catch (err) {
        if (err instanceof TimeBlockConflictsError) {
          log.info({
            event: 'time_block_conflicts_pending',
            userId: ownerId,
            businessId: business.id,
            conflictsTotal: err.conflictsTotal,
            changed: err.code === 'TIME_BLOCK_CONFLICTS_CHANGED',
          });
        }
        throw err;
      }

      const timeBlock = toOwnerTimeBlock(found.row, timeZone);
      log.info({
        event: 'time_block_created',
        userId: ownerId,
        businessId: business.id,
        timeBlockId: id,
        target: value.professionalId ? 'professional' : 'all',
        professionalId: value.professionalId,
        durationMinutes: durationMinutes(timeBlock.start, timeBlock.end),
        conflictsTotal: found.conflicts.total,
      });
      return {
        timeBlock,
        acknowledgedConflictsCount: found.conflicts.total,
        warnings: adjustmentWarnings(value, timeZone),
      };
    },

    /**
     * Remove o bloqueio (critério 14). Malformado, inexistente e de outro negócio: o mesmo 404.
     * @throws {ConflictError|NotFoundError}
     */
    async remove(ownerId, id) {
      const business = await businessOf(ownerId);
      if (typeof id !== 'string' || !TIME_BLOCK_ID_RE.test(id)) throw blockNotFound();
      const nowMs = now().getTime();
      await db.transaction(async (tx) => {
        await businessesRepository.lockById(business.id, tx);
        const { changes } = await timeBlocksRepository.deleteById(id, business.id, tx);
        if (changes === 0) throw blockNotFound();
        await timeBlocksRepository.purgeEnded(business.id, cutoffIso(nowMs), tx);
      });
      log.info({ event: 'time_block_removed', userId: ownerId, businessId: business.id, timeBlockId: id });
    },

    /**
     * Purga global no boot: encerrados há mais de 90 dias (design 5.5).
     * @returns {Promise<number>} linhas apagadas
     */
    async purgeExpired() {
      const { changes } = await timeBlocksRepository.purgeEndedAll(cutoffIso(now().getTime()));
      if (changes > 0) log.info({ event: 'time_blocks_purged', count: changes });
      return changes;
    },
  };
}
