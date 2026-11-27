// Regras fixas da fila de e-mails (AF-18, design 4.2). Módulo puro, só servidor. Nada aqui é
// configuração: atrasos, tetos, prazos e timeouts são constantes (decisão do design 2.1).

export const EMAIL_KIND_CONFIRMED = 'appointment_confirmed';
export const EMAIL_KIND_CANCELLED = 'appointment_cancelled';
export const EMAIL_KIND_RESCHEDULED = 'appointment_rescheduled';
/** Cancelamento pelo dono (AF-14, critério 25; CHECK ampliado na migração 014). */
export const EMAIL_KIND_CANCELLED_BY_OWNER = 'appointment_cancelled_by_owner';
/** E-mails de conta (AF-03, migração 015): alvo `user_id`, sem agendamento. */
export const EMAIL_KIND_PASSWORD_RESET = 'password_reset';
export const EMAIL_KIND_PASSWORD_CHANGED = 'password_changed';
export const EMAIL_ACCOUNT_KINDS = Object.freeze([EMAIL_KIND_PASSWORD_RESET, EMAIL_KIND_PASSWORD_CHANGED]);
/** Tipos de agendamento: alvo `business_id` + `appointment_id`. */
export const EMAIL_APPOINTMENT_KINDS = Object.freeze([
  EMAIL_KIND_CONFIRMED,
  EMAIL_KIND_CANCELLED,
  EMAIL_KIND_RESCHEDULED,
  EMAIL_KIND_CANCELLED_BY_OWNER,
]);
/** = CHECK `email_outbox_kind_check` vigente (015; teste). */
export const EMAIL_KINDS = Object.freeze([...EMAIL_APPOINTMENT_KINDS, ...EMAIL_ACCOUNT_KINDS]);
/** Tipos de cancelamento: relê `cancelled` no envio, não emite token, `.ics` CANCEL (AF-14). */
export const EMAIL_CANCELLATION_KINDS = Object.freeze([EMAIL_KIND_CANCELLED, EMAIL_KIND_CANCELLED_BY_OWNER]);
export const EMAIL_STATUSES = Object.freeze(['pending', 'sending', 'sent', 'failed', 'skipped', 'expired']);
export const EMAIL_TERMINAL_STATUSES = Object.freeze(['sent', 'failed', 'skipped', 'expired']);

/**
 * Atraso antes de cada RETENTATIVA (2º a 5º envio), critério 8 com a decisão 2 do Gerente: "no
 * máximo 5 tentativas" = 5 envios no total, com 1 min, 5 min, 30 min e 2 h entre eles.
 */
export const EMAIL_RETRY_DELAYS_MS = Object.freeze([60_000, 300_000, 1_800_000, 7_200_000]);
/** Atraso × (1 + 0,2 × random): nunca antes do nominal, nunca 20% ou mais depois. */
export const EMAIL_RETRY_JITTER = 0.2;
/** Envios no total por linha (= CHECK `attempts BETWEEN 0 AND 5` da migração 013). */
export const EMAIL_MAX_SENDS = 5;
/** Arrendamento da linha `sending` (5 min), bem acima do teto de envio. */
export const EMAIL_LEASE_MS = 300_000;
/** Teto rígido do worker por envio. */
export const EMAIL_SEND_TIMEOUT_MS = 60_000;
/** `pending` mais velho que isto vira `expired`. */
export const EMAIL_PENDING_MAX_AGE_DAYS = 7;
/** Linhas terminais apagadas depois disto. */
export const EMAIL_RETENTION_DAYS = 30;
export const EMAIL_RECIPIENT_WINDOW_HOURS = 24;
/** Por e-mail normalizado, somando todos os negócios (critério 27). */
export const EMAIL_RECIPIENT_MAX = 10;
/**
 * Cota própria dos e-mails de conta (AF-03, decisão 5 do Gerente): por endereço normalizado, em
 * EMAIL_RECIPIENT_WINDOW_HOURS, separada da de agendamento (uma não esgota a outra).
 */
export const EMAIL_ACCOUNT_RECIPIENT_MAX = 5;
/** `password_reset` mais velho que isto no preparo vira `skipped stale` (cobre 1 + 4 retentativas, ~3 h 08 min). */
export const PASSWORD_RESET_SEND_MAX_AGE_MS = 14_400_000;
/** Linhas por ciclo do worker. */
export const EMAIL_BATCH_SIZE = 10;
/** Lote da purga no boot; no ciclo do worker, EMAIL_PURGE_CYCLE_BATCH. */
export const EMAIL_PURGE_BATCH = 500;
export const EMAIL_PURGE_CYCLE_BATCH = 100;
export const SMTP_TIMEOUTS = Object.freeze({ connectionMs: 10_000, greetingMs: 10_000, socketMs: 30_000 });

/** Falhas temporárias (retentativa com backoff). */
export const EMAIL_TRANSIENT_CODES = Object.freeze([
  'network',
  'timeout',
  'send_timeout',
  'tls',
  'smtp_4xx',
  'smtp_auth',
  'smtp_sender',
  'unknown',
]);
/** Falhas permanentes (direto a `failed`). */
export const EMAIL_PERMANENT_CODES = Object.freeze(['smtp_5xx', 'recipient_rejected', 'invalid_header', 'render_failed']);
/** Motivos de `skipped`. */
export const EMAIL_SKIP_CODES = Object.freeze([
  'not_confirmed',
  'not_cancelled',
  'ended',
  'missing',
  'recipient_limited',
  // AF-03 (só password_reset): há pedido mais novo ou a senha já foi trocada; pedido velho demais.
  'superseded',
  'stale',
]);
/** Falhas de configuração do SMTP: temporárias, com log próprio (decisão 3 do Gerente). */
export const EMAIL_MISCONFIGURED_CODES = Object.freeze(['smtp_auth', 'smtp_sender', 'tls']);

/** Todos os códigos que podem ir para `last_error_code` (passam no CHECK da migração). */
export const EMAIL_ERROR_CODES = Object.freeze([
  ...EMAIL_TRANSIENT_CODES,
  ...EMAIL_PERMANENT_CODES,
  ...EMAIL_SKIP_CODES,
  'expired',
  'lease_expired',
]);

/**
 * Atraso da retentativa depois do envio número `attempts` (1 a 4; o 5º envio não tem sucessor).
 * @param {number} attempts
 * @param {() => number} [random]
 * @returns {number} ms
 * @throws {RangeError} fora de 1..EMAIL_MAX_SENDS-1
 */
export function retryDelayMs(attempts, random = Math.random) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > EMAIL_RETRY_DELAYS_MS.length) {
    throw new RangeError('retryDelayMs: attempts fora do intervalo.');
  }
  const r = Math.min(Math.max(Number(random()) || 0, 0), 0.999_999);
  return Math.floor(EMAIL_RETRY_DELAYS_MS[attempts - 1] * (1 + EMAIL_RETRY_JITTER * r));
}
