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

export class RateLimitedError extends AppError {
  /** @param {number} retryAfterSeconds só vai no header Retry-After (o corpo segue o formato do RATE_LIMITED) */
  constructor(retryAfterSeconds) {
    super(429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE);
    this.name = 'RateLimitedError';
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

function body(code, message, fields, retryAfterSeconds, suggestion, futureAppointmentsCount) {
  const error = { code, message };
  if (fields && Object.keys(fields).length > 0) error.fields = fields;
  if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
  if (typeof suggestion === 'string') error.suggestion = suggestion;
  if (Number.isInteger(futureAppointmentsCount) && futureAppointmentsCount >= 0) {
    error.futureAppointmentsCount = futureAppointmentsCount;
  }
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
