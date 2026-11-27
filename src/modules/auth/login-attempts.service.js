import { createHash } from 'node:crypto';

const MINUTE_MS = 60 * 1000;

/**
 * Normaliza o IP usado na chave do bloqueio. Hoje só remove o prefixo
 * IPv4-mapeado (`::ffff:1.2.3.4` -> `1.2.3.4`). O agrupamento de IPv6 por /64
 * (risco R3) entra aqui sem mudar a interface.
 * @param {string|undefined} ip
 */
export function normalizeIp(ip) {
  const text = typeof ip === 'string' ? ip.trim().toLowerCase() : '';
  const mapped = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? mapped[1] : text;
}

/**
 * Chave do bloqueio: SHA-256 hex de "<email normalizado>\n<ip normalizado>".
 * Não guarda e-mail nem IP em claro (minimização de dados).
 */
export function attemptKey(email, ip) {
  return createHash('sha256').update(`${email}\n${normalizeIp(ip)}`).digest('hex');
}

export function createLoginAttemptsService({ db, loginAttemptsRepository, config, now = () => new Date() }) { // utc
  const { maxFailures, lockMinutes } = config.loginLock;

  return {
    /**
     * Reserva atômica de uma tentativa: conta a tentativa como falha antes da
     * verificação da senha (desfeita por `clear` se o login der certo).
     * @returns {Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }>}
     */
    async reserve(key) {
      return db.transaction(async (tx) => {
        const current = now();
        const nowMs = current.getTime();
        const nowIso = current.toISOString();

        await loginAttemptsRepository.touch(key, nowIso, tx);
        const row = await loginAttemptsRepository.find(key, tx);
        const lockedUntilMs = row.lockedUntil ? Date.parse(row.lockedUntil) : null;

        if (lockedUntilMs !== null && lockedUntilMs > nowMs) {
          // Durante o bloqueio nada muda: a tentativa não prorroga o prazo.
          return { allowed: false, retryAfterSeconds: Math.ceil((lockedUntilMs - nowMs) / 1000) };
        }

        // Bloqueio vencido: o contador recomeça.
        const base = lockedUntilMs !== null ? 0 : row.failedCount;
        const failedCount = base + 1;
        const lockedUntil =
          failedCount >= maxFailures ? new Date(nowMs + lockMinutes * MINUTE_MS).toISOString() : null;

        await loginAttemptsRepository.update(key, { failedCount, lockedUntil, updatedAt: nowIso }, tx);
        return { allowed: true };
      });
    },

    /** Zera o contador e remove o bloqueio (login bem-sucedido). */
    async clear(key, { conn } = {}) {
      await loginAttemptsRepository.clear(key, conn);
    },
  };
}
