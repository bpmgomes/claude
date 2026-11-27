// Recuperação de senha (AF-03, design 5.1, 5.4 e 5.7). O pedido só grava a linha da fila: o token
// nasce no worker (decisão 12), e só a emissão invalida os links anteriores (revisão de segurança,
// decisão 1 do Gerente: um pedido barrado pela cota não destrói o link já recebido). A redefinição consome o token com UPDATE condicional na MESMA
// transação que troca o hash, revoga as sessões, apaga os outros tokens, zera o bloqueio do AF-02 e
// enfileira o aviso. Ordem de travas (design 3.4): auth_rate_limits -> password_reset_tokens -> users
// -> sessions -> login_attempts -> email_outbox (sempre a última escrita); `auth_rate_events` vem logo
// depois de `auth_rate_limits`.
import { validatePasswordResetRequest, validatePasswordReset, PASSWORD_RESET_TOKEN_RE } from '../../shared/password-reset.js';
import { hashPassword } from './password.js';
import { hashResetToken } from './password-reset-token.js';
import { attemptEmailKey } from './login-attempts.service.js';
import { rateLimitKey } from '../../http/ip-key.js';
import { ValidationError, PasswordResetLinkInvalidError, AuthRateLimitedError } from '../../http/errors.js';
import { EMAIL_KIND_PASSWORD_RESET, EMAIL_KIND_PASSWORD_CHANGED } from '../email/email-rules.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const noopLog = { info() {}, warn() {}, error() {} };

export const SCOPE_REQUEST_EMAIL = 'password_reset_request_email';
export const SCOPE_REQUEST_IP = 'password_reset_request_ip';
export const SCOPE_CONFIRM_IP = 'password_reset_confirm_ip';
/** Tokens vencidos e baldes velhos saem (no boot e no ciclo do worker) depois disto. */
export const PASSWORD_RESET_PURGE_AFTER_MS = DAY_MS;
/** Ciclo do worker (B2): um lote limitado por tabela. */
export const PASSWORD_RESET_PURGE_CYCLE = Object.freeze({ batch: 100, maxBatches: 1 });

/**
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   usersRepository: object, passwordResetTokensRepository: object, sessionsRepository: object,
 *   loginAttemptsRepository: object, authRateLimitsRepository?: object,
 *   rateLimiter: ReturnType<typeof import('./auth-rate-limits.service.js').createAuthRateLimiter>,
 *   enqueueEmail: typeof import('../email/enqueue-email.js').enqueueEmail,
 *   wakeEmailWorker?: () => void,
 *   config: { bcryptCost: number, passwordReset: object },
 *   now?: () => Date, log?: object, hash?: typeof hashPassword,
 * }} deps
 */
export function createPasswordResetService({
  db,
  usersRepository,
  passwordResetTokensRepository,
  sessionsRepository,
  loginAttemptsRepository,
  authRateLimitsRepository,
  rateLimiter,
  enqueueEmail,
  wakeEmailWorker = () => {},
  config,
  now = () => new Date(), // utc
  log = noopLog,
  hash = hashPassword,
}) {
  const limits = config.passwordReset;
  const bucket = (scope, value, { max, windowMinutes }) => ({ scope, value, max, windowMs: windowMinutes * MINUTE_MS });
  const emailWindows = (limits.requestPerEmail ?? []).map(({ max, windowMinutes }) => ({ max, windowMs: windowMinutes * MINUTE_MS }));
  // Os eventos só podem sair depois da maior janela (e nunca antes de 24 h).
  const eventsKeepMs = Math.max(PASSWORD_RESET_PURGE_AFTER_MS, ...emailWindows.map((w) => w.windowMs));

  return {
    /**
     * Pedido (5.1). Uma transação: IP (sempre, antes de validar), validação, e-mail (janela
     * deslizante), conta e enfileiramento. NÃO mexe nos tokens: os links que saíram continuam valendo
     * até o worker emitir o novo. Sem rede, sem bcrypt.
     * @param {unknown} input
     * @param {{ ip: string }} context
     * @returns {Promise<{ accepted: true, outcome: 'enqueued'|'no_account'|'email_limited', userId: string|null }>}
     * @throws {AuthRateLimitedError|ValidationError}
     */
    async request(input, { ip } = {}) {
      const result = await db.transaction(async (tx) => {
        const byIp = await rateLimiter.reserve(tx, bucket(SCOPE_REQUEST_IP, rateLimitKey(ip), limits.requestPerIp));
        if (!byIp.allowed) return { limited: byIp.retryAfterSeconds };
        const check = validatePasswordResetRequest(input);
        if (!check.ok) return { invalid: check.fields };
        const { email } = check.value;
        const emailOk = (await rateLimiter.reserveSliding(tx, { scope: SCOPE_REQUEST_EMAIL, value: email, windows: emailWindows })).allowed;
        // Leitura SEMPRE, mesmo limitado: os caminhos fazem as mesmas consultas (critério 3).
        const user = await usersRepository.findByEmail(email, tx);
        if (!user) return { outcome: 'no_account', userId: null };
        if (!emailOk) return { outcome: 'email_limited', userId: user.id };
        const nowIso = now().toISOString();
        const queued = await enqueueEmail(tx, { kind: EMAIL_KIND_PASSWORD_RESET, userId: user.id, nowIso });
        return { outcome: 'enqueued', userId: user.id, outboxId: queued.id };
      });
      if (result.limited !== undefined) throw new AuthRateLimitedError(result.limited);
      if (result.invalid) throw new ValidationError(result.invalid);
      if (result.outcome === 'enqueued') {
        log.info({ event: 'email_enqueued', outboxId: result.outboxId, kind: EMAIL_KIND_PASSWORD_RESET });
        wakeEmailWorker();
      }
      return { accepted: true, outcome: result.outcome, userId: result.userId };
    },

    /**
     * Redefinição (5.4). Ordem: IP -> forma do token -> token utilizável (leitura) -> política ->
     * bcrypt (fora da transação) -> transação de troca.
     * @param {unknown} input
     * @param {{ ip: string }} context
     * @returns {Promise<{ ok: true, userId: string }>}
     * @throws {AuthRateLimitedError|PasswordResetLinkInvalidError|ValidationError} os dois últimos com
     *   `reason` (`invalid_link`, `race`, `policy`, `mismatch`) para o log da rota
     */
    async confirm(input, { ip } = {}) {
      const byIp = await db.transaction((tx) => rateLimiter.reserve(tx, bucket(SCOPE_CONFIRM_IP, rateLimitKey(ip), limits.confirmPerIp)));
      if (!byIp.allowed) throw new AuthRateLimitedError(byIp.retryAfterSeconds);
      const src = input && typeof input === 'object' ? input : {};
      const token = src.token;
      if (typeof token !== 'string' || !PASSWORD_RESET_TOKEN_RE.test(token)) throw withReason(new PasswordResetLinkInvalidError(), 'invalid_link');
      const tokenHash = hashResetToken(token);
      const found = await passwordResetTokensRepository.findUsable(tokenHash, now().toISOString());
      if (!found) throw withReason(new PasswordResetLinkInvalidError(), 'invalid_link');
      const check = validatePasswordReset(src);
      if (!check.ok) throw withReason(new ValidationError(check.fields), check.fields.password ? 'policy' : 'mismatch');
      const passwordHash = await hash(check.value.password, config.bcryptCost);

      const outboxId = await db.transaction(async (tx) => {
        const nowIso = now().toISOString();
        const { changes } = await passwordResetTokensRepository.consume(tokenHash, found.userId, nowIso, tx);
        if (changes !== 1) throw withReason(new PasswordResetLinkInvalidError(), 'race');
        const user = await usersRepository.findById(found.userId, tx);
        if (!user) throw withReason(new PasswordResetLinkInvalidError(), 'race');
        await passwordResetTokensRepository.deletePendingForUser(user.id, tx);
        await usersRepository.updatePassword(user.id, { passwordHash, changedAt: nowIso }, tx);
        await sessionsRepository.revokeAllForUser(user.id, nowIso, tx);
        await loginAttemptsRepository.clearByEmailHash(attemptEmailKey(user.email), tx);
        const queued = await enqueueEmail(tx, { kind: EMAIL_KIND_PASSWORD_CHANGED, userId: user.id, nowIso });
        return queued.id;
      });
      log.info({ event: 'email_enqueued', outboxId, kind: EMAIL_KIND_PASSWORD_CHANGED });
      wakeEmailWorker();
      return { ok: true, userId: found.userId };
    },

    /**
     * 5.7: tokens vencidos há mais de 24 h, baldes velhos e eventos fora da maior janela. No boot, em
     * lotes até 0 (sem opções); no ciclo do worker (B2), `PASSWORD_RESET_PURGE_CYCLE`. Nunca lança.
     * @param {{ batch?: number, maxBatches?: number }} [opts]
     */
    async purgeExpired(opts = {}) {
      try {
        const nowMs = now().getTime();
        const cutoff = new Date(nowMs - PASSWORD_RESET_PURGE_AFTER_MS).toISOString();
        const tokens = await passwordResetTokensRepository.purgeExpired(cutoff, opts);
        const buckets = authRateLimitsRepository ? await authRateLimitsRepository.purgeOld(cutoff, opts) : 0;
        const events = authRateLimitsRepository
          ? await authRateLimitsRepository.purgeEvents(new Date(nowMs - eventsKeepMs).toISOString(), opts)
          : 0;
        if (tokens + buckets + events > 0) log.info({ event: 'password_reset_purged', tokens, buckets, events });
      } catch (err) {
        log.warn({ event: 'password_reset_purge_failed', errCode: err?.code, errName: err?.name });
      }
    },
  };
}

/** Motivo fixo do log `password_reset_rejected` (4.5); nunca vai na resposta. */
function withReason(err, reason) {
  err.reason = reason;
  return err;
}
