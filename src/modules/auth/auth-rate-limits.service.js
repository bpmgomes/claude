// Limitador persistido da recuperação de senha (AF-03, design 4.3), sempre ativo (independente de
// `rateLimit.enabled`), reservado na transação do chamador. `reserve`: janela FIXA a partir do
// primeiro acerto, no padrão do `loginAttemptsService.reserve` (IP). `reserveSliding`: janela
// DESLIZANTE sobre os acertos aceitos, com várias janelas ao mesmo tempo (e-mail; revisão de
// segurança, decisão 3 do Gerente: sem a borda da janela fixa).
import { createHash } from 'node:crypto';

/** SHA-256 hex de `${scope}\n${value}` (valor: e-mail normalizado ou `rateLimitKey(ip)`). */
export function rateKey(scope, value) {
  return createHash('sha256').update(`${scope}\n${value}`).digest('hex');
}

/**
 * @param {{ authRateLimitsRepository: ReturnType<typeof import('./auth-rate-limits.repository.js').createAuthRateLimitsRepository>,
 *   now?: () => Date }} deps
 */
export function createAuthRateLimiter({ authRateLimitsRepository, now = () => new Date() }) { // utc
  return {
    /**
     * Na transação do chamador: touch, find; janela vencida (window + windowMs <= agora) recomeça em 1;
     * hits >= max -> { allowed: false, retryAfterSeconds } SEM alterar nada; senão hits + 1.
     * @param {import('../../db/index.js').Database} tx
     * @param {{ scope: string, value: string, max: number, windowMs: number }} bucket
     * @returns {Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }>}
     */
    async reserve(tx, { scope, value, max, windowMs }) {
      const current = now();
      const nowMs = current.getTime();
      const nowIso = current.toISOString();
      const keyHash = rateKey(scope, value);
      await authRateLimitsRepository.touch(scope, keyHash, nowIso, tx);
      const row = await authRateLimitsRepository.find(scope, keyHash, tx);
      const startedMs = Date.parse(row.windowStartedAt);
      if (startedMs + windowMs <= nowMs) {
        await authRateLimitsRepository.update(scope, keyHash, { windowStartedAt: nowIso, hits: 1 }, tx);
        return { allowed: true };
      }
      if (row.hits >= max) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((startedMs + windowMs - nowMs) / 1000)) };
      }
      await authRateLimitsRepository.update(scope, keyHash, { windowStartedAt: row.windowStartedAt, hits: row.hits + 1 }, tx);
      return { allowed: true };
    },

    /**
     * Na transação do chamador: lê os acertos aceitos da chave dentro da maior janela; se alguma
     * janela já tem `max` acertos com `occurred_at > agora - windowMs`, devolve
     * `{ allowed: false, retryAfterSeconds }` SEM gravar (o recusado não conta); senão grava o acerto.
     * `retryAfterSeconds`: quando sai da janela o acerto que a enche, o maior entre as janelas cheias.
     * @param {import('../../db/index.js').Database} tx
     * @param {{ scope: string, value: string, windows: Array<{ max: number, windowMs: number }> }} bucket
     * @returns {Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }>}
     */
    async reserveSliding(tx, { scope, value, windows }) {
      const current = now();
      const nowMs = current.getTime();
      const nowIso = current.toISOString();
      const keyHash = rateKey(scope, value);
      const longest = Math.max(...windows.map((w) => w.windowMs));
      const recent = await authRateLimitsRepository.eventsSince(scope, keyHash, new Date(nowMs - longest).toISOString(), tx);
      let waitMs = 0;
      for (const { max, windowMs } of windows) {
        const since = new Date(nowMs - windowMs).toISOString();
        const inWindow = recent.filter((at) => at > since);
        if (inWindow.length >= max) waitMs = Math.max(waitMs, Date.parse(inWindow[max - 1]) + windowMs - nowMs);
      }
      if (waitMs > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
      await authRateLimitsRepository.insertEvent(scope, keyHash, nowIso, tx);
      return { allowed: true };
    },
  };
}
