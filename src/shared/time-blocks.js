// Regras de bloqueio de horários compartilhadas entre backend e browser (/shared/time-blocks.js).
// Módulo puro: só importa ./validation.js, ./professionals.js e ./zoned-time.js (também puros).
// Entrada e saída em hora local do negócio ('YYYY-MM-DDTHH:MM'); gravação em instantes UTC
// (design AF-16, 4.2). O fuso do servidor e o do navegador nunca entram no cálculo.
import { validateText, normalizeText } from './validation.js';
import { PROFESSIONAL_ID_RE } from './professionals.js';
import {
  parseLocalDateTime,
  parseLocalDate,
  addLocalDays,
  wallMinutes,
  localToInstant,
  instantToLocal,
  instantToIso,
  isoToInstant,
} from './zoned-time.js';

export const TIME_BLOCK_STEP_MINUTES = 15;
/** Duração máxima, medida em hora local (wallMinutes). */
export const TIME_BLOCK_MAX_DAYS = 366;
/** Por negócio, ends_at > now. */
export const TIME_BLOCKS_ACTIVE_MAX = 500;
/** Encerrados retidos por negócio (defesa, design 5.5). */
export const TIME_BLOCKS_ENDED_RETAINED_MAX = 500;
export const TIME_BLOCKS_RETENTION_DAYS = 90;
export const TIME_BLOCKS_LIST_MAX = 500;
export const TIME_BLOCKS_LIST_RANGE_MAX_DAYS = 366;
export const CONFLICTS_LIST_MAX = 50;
export const REASON_NOTE_MAX = 60;
export const REASON_KINDS = Object.freeze(['day_off', 'holiday', 'vacation', 'other']);
export const REASON_LABELS = Object.freeze({ day_off: 'Folga', holiday: 'Feriado', vacation: 'Férias', other: 'Outro' });
/** Fuso usado quando nenhum é informado (o mesmo padrão de businesses.timezone). */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** Identificador de bloqueio: UUID v4 em minúsculas (igual a PROFESSIONAL_ID_RE). */
export const TIME_BLOCK_ID_RE = PROFESSIONAL_ID_RE;

const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Mensagens fixas: a única interpolação é a hora HH:MM de `timeAdjusted`, calculada pelo servidor. */
export const TIME_BLOCK_MESSAGES = Object.freeze({
  checkFields: 'Verifique os campos destacados.',
  targetRequired: 'Escolha um profissional ou Todos os profissionais.',
  dateTimeInvalid: 'Informe data e hora válidas.',
  timeStep: 'Use minutos 00, 15, 30 ou 45.',
  endBeforeStart: 'O fim deve ser depois do início.',
  endInPast: 'Este período já terminou. Escolha um fim no futuro.',
  tooLong: 'Um bloqueio pode durar no máximo 366 dias.',
  reasonKindInvalid: 'Motivo inválido.',
  reasonNoteTooLong: 'O motivo deve ter no máximo 60 caracteres.',
  reasonNoteInvalid: 'O motivo contém caracteres inválidos.',
  dateInvalid: 'Informe uma data válida.',
  rangeInvalid: 'O período deve ter de 1 a 366 dias.',
  limitReached: 'Limite de 500 bloqueios ativos atingido. Remova bloqueios antes de criar outros.',
  businessRequired: 'Cadastre seu negócio antes de bloquear horários.',
  notFound: 'Bloqueio não encontrado.',
  conflicts: 'Há agendamentos neste período. Eles continuam marcados. Confirme para bloquear mesmo assim.',
  conflictsChanged: 'A lista de agendamentos mudou. Confira e confirme de novo.',
  conflictsUnavailable: 'Não foi possível verificar os agendamentos. Tente novamente.',
  timeAdjusted: (hhmm) =>
    `O horário caiu na mudança de horário de verão e foi ajustado para ${
      typeof hhmm === 'string' && HHMM_RE.test(hhmm) ? hhmm : ''
    }.`,
});

const M = TIME_BLOCK_MESSAGES;
const MINUTES_PER_DAY = 1440;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** start/end: formato e passo de 15 min. */
function parseBoundary(raw, fields, key) {
  const parsed = parseLocalDateTime(raw);
  if (!parsed.ok) {
    fields[key] = M.dateTimeInvalid;
    return null;
  }
  if (parsed.value.minute % TIME_BLOCK_STEP_MINUTES !== 0) {
    fields[key] = M.timeStep;
    return null;
  }
  return parsed.value;
}

/** Motivo: tipo da lista ou ausente; texto pela regra de texto do AF-06 (até 60). */
function validateReason(src, fields) {
  let reasonKind = null;
  const kind = src.reasonKind;
  if (kind !== undefined && kind !== null) {
    if (typeof kind === 'string' && REASON_KINDS.includes(kind)) reasonKind = kind;
    else fields.reasonKind = M.reasonKindInvalid;
  }
  let reasonNote = null;
  const note = src.reasonNote;
  if (note !== undefined && note !== null && note !== '') {
    const error = validateText(note, REASON_NOTE_MAX, {
      required: M.reasonNoteInvalid,
      tooLong: M.reasonNoteTooLong,
      invalid: M.reasonNoteInvalid,
    });
    if (error) fields.reasonNote = error;
    else reasonNote = normalizeText(note);
  }
  if (reasonNote !== null && reasonKind === null) reasonKind = 'other';
  return { reasonKind, reasonNote };
}

/**
 * Valida o corpo do POST e converte para UTC no fuso do negócio. `nowMs` é opcional: sem ele
 * (navegador), a regra "fim no futuro" não é aplicada, porque o servidor é a autoridade.
 * Todas as falhas de campo voltam juntas; nenhuma mensagem contém a entrada.
 * `professionalId` string fora do formato UUID é tratada pelo serviço (404); aqui vira
 * `targetRequired` (só alcançável no navegador ou em teste).
 * @param {unknown} input
 * @param {{ timeZone?: string, nowMs?: number }} options
 * @returns {{ ok: true, value: { professionalId: string|null, startsAt: string, endsAt: string,
 *             reasonKind: string|null, reasonNote: string|null,
 *             adjusted: { start: 'none'|'fold'|'gap', end: 'none'|'fold'|'gap' } } }
 *         | { ok: false, fields: Record<string, string> }}
 */
export function validateTimeBlockInput(input, { timeZone = DEFAULT_TIME_ZONE, nowMs } = {}) {
  const src = isObject(input) ? input : {};
  const fields = {};

  // 1. Alvo: a chave é obrigatória; null = todos os profissionais.
  let professionalId = null;
  if (!has(src, 'professionalId')) fields.professionalId = M.targetRequired;
  else if (src.professionalId === null) professionalId = null;
  else if (typeof src.professionalId === 'string' && PROFESSIONAL_ID_RE.test(src.professionalId)) {
    professionalId = src.professionalId;
  } else fields.professionalId = M.targetRequired;

  // 2. Formato e passo.
  const start = parseBoundary(src.start, fields, 'start');
  const end = parseBoundary(src.end, fields, 'end');

  // 3 e 4. Ordem e duração em hora local; depois a conversão e o "fim no futuro".
  let startsAt = null;
  let endsAt = null;
  const adjusted = { start: 'none', end: 'none' };
  if (start && end) {
    const duration = wallMinutes(end) - wallMinutes(start);
    if (duration <= 0) fields.end = M.endBeforeStart;
    else if (duration > TIME_BLOCK_MAX_DAYS * MINUTES_PER_DAY) fields.end = M.tooLong;
    else {
      const s = localToInstant(start, timeZone);
      const e = localToInstant(end, timeZone);
      adjusted.start = s.adjusted;
      adjusted.end = e.adjusted;
      // Dentro de um salto de horário de verão a conversão não é monótona (02:45 -> 03:45 vem
      // depois de 03:00): sem esta checagem, o período poderia ficar vazio ou invertido em UTC.
      if (e.ms <= s.ms) fields.end = M.endBeforeStart;
      else if (Number.isFinite(nowMs) && e.ms <= nowMs) fields.end = M.endInPast;
      else {
        startsAt = instantToIso(s.ms);
        endsAt = instantToIso(e.ms);
      }
    }
  }

  // 5. Motivo.
  const { reasonKind, reasonNote } = validateReason(src, fields);

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { professionalId, startsAt, endsAt, reasonKind, reasonNote, adjusted } };
}

/**
 * Query do GET. `professionalId`: UUID v4 ou 'all'; `from`/`to`: 'YYYY-MM-DD', `to` inclusive.
 * Sem período: fromIso/toIso null (a listagem padrão mostra só ativos). Só `from`: até 366 dias
 * a partir dele; só `to`: os 366 dias que terminam nele.
 * @param {unknown} query
 * @param {{ timeZone?: string }} options
 * @returns {{ ok: true, value: { professionalId: string|'all'|null, fromIso: string|null, toIso: string|null } }
 *         | { ok: false, fields: Record<string, string> }}
 */
export function validateListQuery(query, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  const src = isObject(query) ? query : {};
  const fields = {};

  let professionalId = null;
  const rawId = src.professionalId;
  if (rawId !== undefined && rawId !== '') {
    if (rawId === 'all') professionalId = 'all';
    else if (typeof rawId === 'string' && PROFESSIONAL_ID_RE.test(rawId)) professionalId = rawId;
    else fields.professionalId = M.targetRequired;
  }

  const present = (v) => v !== undefined && v !== '';
  let from = null;
  let to = null;
  if (present(src.from)) {
    const parsed = parseLocalDate(src.from);
    if (parsed.ok) from = src.from;
    else fields.from = M.dateInvalid;
  }
  if (present(src.to)) {
    const parsed = parseLocalDate(src.to);
    if (parsed.ok) to = src.to;
    else fields.to = M.dateInvalid;
  }

  let fromIso = null;
  let toIso = null;
  if (!fields.from && !fields.to && (from || to)) {
    if (!from) from = addLocalDays(to, -(TIME_BLOCKS_LIST_RANGE_MAX_DAYS - 1));
    if (!to) to = addLocalDays(from, TIME_BLOCKS_LIST_RANGE_MAX_DAYS - 1);
    const fromDate = parseLocalDate(from);
    const toDate = parseLocalDate(to);
    if (!fromDate.ok || !toDate.ok) {
      // A data derivada saiu da faixa 2000..2099.
      fields[fromDate.ok ? 'to' : 'from'] = M.dateInvalid;
    } else {
      const days = (wallMinutes(toDate.value) - wallMinutes(fromDate.value)) / MINUTES_PER_DAY + 1;
      if (days < 1 || days > TIME_BLOCKS_LIST_RANGE_MAX_DAYS) fields.to = M.rangeInvalid;
      else {
        const startMs = localToInstant({ ...fromDate.value, hour: 0, minute: 0 }, timeZone).ms;
        const next = parseLocalDate(addLocalDays(to, 1));
        // 2099-12-31 + 1 sai da faixa do parser: a aritmética é a mesma (dias corridos).
        const nextValue = next.ok ? next.value : { year: 2100, month: 1, day: 1 };
        const endMs = localToInstant({ ...nextValue, hour: 0, minute: 0 }, timeZone).ms;
        fromIso = instantToIso(startMs);
        toIso = instantToIso(endMs);
      }
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { professionalId, fromIso, toIso } };
}

/**
 * Único caminho de serialização do bloqueio para o dono (design 4.1). `start`/`end` são
 * recalculados a partir dos instantes no fuso ATUAL do negócio; `allDay` é derivado.
 * @param {{ id: string, professionalId: string|null, professionalName: string|null, startsAt: string,
 *           endsAt: string, reasonKind: string|null, reasonNote: string|null, createdAt: string }} row
 * @param {string} timeZone
 */
export function toOwnerTimeBlock(row, timeZone) {
  const start = instantToLocal(isoToInstant(row.startsAt), timeZone);
  const end = instantToLocal(isoToInstant(row.endsAt), timeZone);
  return {
    id: row.id,
    professional: row.professionalId ? { id: row.professionalId, name: row.professionalName ?? '' } : null,
    start,
    end,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: start.endsWith('T00:00') && end.endsWith('T00:00'),
    reason: row.reasonKind ? { kind: row.reasonKind, note: row.reasonNote ?? null } : null,
    createdAt: row.createdAt,
  };
}

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * Item da porta de agendamentos -> representação para o dono (sem ids).
 * @param {{ startsAt: string, endsAt: string, serviceName: string, professionalName: string, customerName: string }} item
 * @param {string} timeZone
 * @returns {{ start: string, end: string, serviceName: string, professionalName: string, customerName: string }}
 */
export function toOwnerConflict(item, timeZone) {
  return {
    start: instantToLocal(isoToInstant(item.startsAt), timeZone),
    end: instantToLocal(isoToInstant(item.endsAt), timeZone),
    serviceName: str(item.serviceName),
    professionalName: str(item.professionalName),
    customerName: str(item.customerName),
  };
}
