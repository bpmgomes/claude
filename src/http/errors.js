import { MANAGE_MESSAGES } from '../shared/appointments.js';
import { PASSWORD_RESET_MESSAGES } from '../shared/password-reset.js';

const RATE_LIMITED_MESSAGE = 'Muitas tentativas. Aguarde um momento e tente novamente.';

export class AppError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code
   * @param {string} message
   * @param {Record<string,string>} [fields]
   */
  constructor(statusCode, code, message, fields) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (fields) this.fields = fields;
  }
}

export class ValidationError extends AppError {
  constructor(fields, message = 'Verifique os campos destacados.') {
    super(400, 'VALIDATION_ERROR', message, fields);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(code, message, fields) {
    super(409, code, message, fields);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends AppError {
  constructor(code = 'NOT_FOUND', message = 'Recurso não encontrado.') {
    super(404, code, message);
    this.name = 'NotFoundError';
  }
}

export const SLUG_TAKEN_MESSAGE = 'Este link já está em uso.';

export class SlugTakenError extends ConflictError {
  /** @param {string|null} suggestion alternativa livre no momento da resposta */
  constructor(suggestion = null) {
    super('SLUG_TAKEN', SLUG_TAKEN_MESSAGE, { slug: SLUG_TAKEN_MESSAGE });
    this.name = 'SlugTakenError';
    this.suggestion = typeof suggestion === 'string' ? suggestion : null;
  }
}

export class InvalidImageError extends AppError {
  constructor(message = 'Envie uma imagem PNG ou JPG válida.') {
    super(422, 'INVALID_IMAGE', message);
    this.name = 'InvalidImageError';
  }
}

export const IMAGE_BUSY_MESSAGE = 'Muitas imagens sendo processadas agora. Tente novamente em instantes.';

/** Limitador de processamento de imagem cheio (design AF-07, 4.2). 503: carga do servidor, não uso da pessoa. */
export class ImageBusyError extends AppError {
  /** @param {number} retryAfterSeconds só vai no header Retry-After */
  constructor(retryAfterSeconds = 5) {
    super(503, 'IMAGE_BUSY', IMAGE_BUSY_MESSAGE);
    this.name = 'ImageBusyError';
    this.retryAfterHeader = retryAfterSeconds;
  }
}

export const PROFESSIONAL_HAS_APPOINTMENTS_MESSAGE =
  'Este profissional tem agendamentos futuros. Realoque ou cancele esses agendamentos antes de remover.';

export class ProfessionalHasAppointmentsError extends ConflictError {
  /** @param {number} count agendamentos futuros (vai no corpo como `futureAppointmentsCount`) */
  constructor(count) {
    super('PROFESSIONAL_HAS_FUTURE_APPOINTMENTS', PROFESSIONAL_HAS_APPOINTMENTS_MESSAGE);
    this.name = 'ProfessionalHasAppointmentsError';
    this.futureAppointmentsCount = count;
  }
}

/**
 * Agendamentos em conflito com o bloqueio (design AF-16, 4.1): nada foi gravado e a tela pede
 * confirmação. `code`: 'TIME_BLOCK_CONFLICTS' (sem token) ou 'TIME_BLOCK_CONFLICTS_CHANGED'
 * (token enviado, mas a lista mudou ou o token é inválido).
 */
export class TimeBlockConflictsError extends ConflictError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ conflicts: object[], conflictsTotal: number, conflictsToken: string }} details
   */
  constructor(code, message, { conflicts, conflictsTotal, conflictsToken }) {
    super(code, message);
    this.name = 'TimeBlockConflictsError';
    this.conflicts = conflicts;
    this.conflictsTotal = conflictsTotal;
    this.conflictsToken = conflictsToken;
  }
}

export const SLOT_UNAVAILABLE_MESSAGE = 'Este horário acabou de ser ocupado. Escolha outro.';

/**
 * O início pedido não está livre (AF-11, critério 15): agendamento, bloqueio, grade, antecedência
 * ou sobreposição recusada pelo banco, sem diferenciar. `suggestions` (até 3 `{ start, end }`
 * locais) é preenchido DEPOIS do rollback, fora da transação.
 */
export class SlotUnavailableError extends ConflictError {
  /** @param {Array<{ start: string, end: string }>} [suggestions] */
  constructor(suggestions = []) {
    super('SLOT_UNAVAILABLE', SLOT_UNAVAILABLE_MESSAGE);
    this.name = 'SlotUnavailableError';
    this.suggestions = Array.isArray(suggestions) ? suggestions : [];
  }
}

// Gerenciar o agendamento pelo link (AF-12, design 4.3). Mensagens fixas de MANAGE_MESSAGES.

/** Status, prazo ou estado não permitem a alteração (409). `message`: uma das variantes fixas. */
export class AppointmentNotChangeableError extends ConflictError {
  constructor(message = MANAGE_MESSAGES.notChangeable) {
    super('APPOINTMENT_NOT_CHANGEABLE', message);
    this.name = 'AppointmentNotChangeableError';
  }
}

/**
 * A `version` enviada não é a do agendamento atual (409). `message`: a variante fixa do chamador
 * (o AF-12 usa a padrão; a agenda do dono, AF-14, passa `AGENDA_MESSAGES.changed`).
 */
export class AppointmentChangedError extends ConflictError {
  constructor(message = MANAGE_MESSAGES.changed) {
    super('APPOINTMENT_CHANGED', message);
    this.name = 'AppointmentChangedError';
  }
}

/** A cadeia já tem 3 remarcações (409). */
export class RescheduleLimitReachedError extends ConflictError {
  constructor() {
    super('RESCHEDULE_LIMIT_REACHED', MANAGE_MESSAGES.rescheduleLimit);
    this.name = 'RescheduleLimitReachedError';
  }
}

export const IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'Esta tentativa já foi usada com outros dados. Recarregue a página e tente de novo.';

/** `Idempotency-Key` já usada neste negócio com outro corpo (AF-11, critério 25). */
export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super(422, 'IDEMPOTENCY_KEY_REUSED', IDEMPOTENCY_KEY_REUSED_MESSAGE);
    this.name = 'IdempotencyKeyReusedError';
  }
}

/** Dependência indisponível (ex.: porta de agendamentos, CONFLICTS_UNAVAILABLE). Nada foi gravado. */
export class ServiceUnavailableError extends AppError {
  constructor(code, message) {
    super(503, code, message);
    this.name = 'ServiceUnavailableError';
  }
}

export class RateLimitedError extends AppError {
  /** @param {number} retryAfterSeconds só vai no header Retry-After (o corpo segue o formato do RATE_LIMITED) */
  constructor(retryAfterSeconds) {
    super(429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE);
    this.name = 'RateLimitedError';
    this.retryAfterHeader = retryAfterSeconds;
  }
}

// Recuperação de senha (AF-03, design 4.3). Textos de PASSWORD_RESET_MESSAGES.

/** Token malformado, inexistente, vencido, usado ou invalidado: o MESMO 400 (critério 12). */
export class PasswordResetLinkInvalidError extends AppError {
  constructor() {
    super(400, 'PASSWORD_RESET_LINK_INVALID', PASSWORD_RESET_MESSAGES.linkInvalid);
    this.name = 'PasswordResetLinkInvalidError';
  }
}

/** Limite persistido por IP (critérios 22 e 23): 429 com corpo fixo; o prazo só no `Retry-After`. */
export class AuthRateLimitedError extends AppError {
  /** @param {number} retryAfterSeconds */
  constructor(retryAfterSeconds) {
    super(429, 'RATE_LIMITED', PASSWORD_RESET_MESSAGES.tooMany);
    this.name = 'AuthRateLimitedError';
    this.retryAfterHeader = retryAfterSeconds;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Você precisa estar autenticado.') {
    super(401, 'UNAUTHENTICATED', message);
    this.name = 'UnauthorizedError';
  }
}

export class InvalidCredentialsError extends AppError {
  constructor() {
    super(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    this.name = 'InvalidCredentialsError';
  }
}

export class ForbiddenOriginError extends AppError {
  constructor() {
    super(403, 'FORBIDDEN_ORIGIN', 'Requisição não permitida.');
    this.name = 'ForbiddenOriginError';
  }
}

export class LoginLockedError extends AppError {
  /** @param {number} retryAfterSeconds */
  constructor(retryAfterSeconds) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    const label = minutes === 1 ? '1 minuto' : `${minutes} minutos`;
    super(429, 'LOGIN_LOCKED', `Muitas tentativas de login. Tente novamente em ${label}.`);
    this.name = 'LoginLockedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const GENERIC_500 = 'Erro inesperado. Tente novamente.';

/** Cada sugestão reduzida a `{ start, end }` string (nada interno sai, critério 17 do AF-11). */
function cleanSuggestions(list) {
  return list
    .filter((s) => s && typeof s.start === 'string' && typeof s.end === 'string')
    .map((s) => ({ start: s.start, end: s.end }));
}

function body(
  code,
  message,
  fields,
  retryAfterSeconds,
  suggestion,
  futureAppointmentsCount,
  conflictInfo = {},
  suggestions = undefined,
) {
  const error = { code, message };
  if (fields && Object.keys(fields).length > 0) error.fields = fields;
  if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
  if (typeof suggestion === 'string') error.suggestion = suggestion;
  if (Number.isInteger(futureAppointmentsCount) && futureAppointmentsCount >= 0) {
    error.futureAppointmentsCount = futureAppointmentsCount;
  }
  const { conflicts, conflictsTotal, conflictsToken } = conflictInfo;
  if (Number.isInteger(conflictsTotal) && conflictsTotal >= 0) error.conflictsTotal = conflictsTotal;
  if (Array.isArray(conflicts)) error.conflicts = conflicts;
  if (typeof conflictsToken === 'string') error.conflictsToken = conflictsToken;
  if (Array.isArray(suggestions)) error.suggestions = cleanSuggestions(suggestions);
  return { error };
}

/**
 * Error handler do Fastify: converte qualquer erro para o formato padrão.
 */
export function errorHandler(error, request, reply) {
  if (error instanceof AppError) {
    if (error.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(error.retryAfterSeconds));
    } else if (error.retryAfterHeader !== undefined) {
      reply.header('Retry-After', String(error.retryAfterHeader));
    }
    return reply
      .status(error.statusCode)
      .send(
        body(
          error.code,
          error.message,
          error.fields,
          error.retryAfterSeconds,
          error.suggestion,
          error.futureAppointmentsCount,
          {
            conflicts: error.conflicts,
            conflictsTotal: error.conflictsTotal,
            conflictsToken: error.conflictsToken,
          },
          error.suggestions,
        ),
      );
  }

  // Validação de schema do Fastify
  if (error.validation) {
    return reply.status(400).send(body('VALIDATION_ERROR', 'Verifique os campos destacados.'));
  }

  // Rate limit
  if (error.statusCode === 429) {
    return reply
      .status(429)
      .send(body('RATE_LIMITED', RATE_LIMITED_MESSAGE));
  }

  const status = error.statusCode;
  if (status === 415) {
    return reply.status(415).send(body('UNSUPPORTED_MEDIA_TYPE', 'Envie os dados em formato JSON.'));
  }
  if (status === 413) {
    // A rota pode definir código e mensagem próprios (ex.: logo, LOGO_TOO_LARGE).
    const custom = request.routeOptions?.config?.payloadTooLarge;
    if (custom && typeof custom.code === 'string' && typeof custom.message === 'string') {
      return reply.status(413).send(body(custom.code, custom.message));
    }
    return reply.status(413).send(body('PAYLOAD_TOO_LARGE', 'Os dados enviados são grandes demais.'));
  }
  if (status && status >= 400 && status < 500) {
    // ex.: JSON malformado (FST_ERR_CTP_INVALID_JSON_BODY / FST_ERR_CTP_EMPTY_JSON_BODY)
    return reply.status(400).send(body('VALIDATION_ERROR', 'Requisição inválida.'));
  }

  request.log.error({ err: error }, 'unhandled error');
  return reply.status(500).send(body('INTERNAL_ERROR', GENERIC_500));
}
