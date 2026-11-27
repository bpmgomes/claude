import { randomBytes, randomUUID, createHash } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionsService({ sessionsRepository, config, now = () => new Date() }) { // utc
  /** Prazo deslizante (inatividade) limitado pelo teto absoluto desde a criação. */
  function nextExpiry(nowMs, createdAtMs) {
    return new Date(
      Math.min(nowMs + config.sessionTtlDays * DAY_MS, createdAtMs + config.sessionAbsoluteTtlDays * DAY_MS),
    ).toISOString();
  }

  return {
    /**
     * @param {string} userId
     * @param {{ conn?: import('../../db/index.js').Database }} [options] conexão/transação a usar
     * @returns {Promise<{ token: string, expiresAt: string }>}
     */
    async createSession(userId, { conn } = {}) {
      const token = randomBytes(32).toString('base64url');
      const current = now();
      const nowIso = current.toISOString();
      const expiresAt = nextExpiry(current.getTime(), current.getTime());
      await sessionsRepository.insert(
        {
          id: randomUUID(),
          userId,
          tokenHash: hashToken(token),
          createdAt: nowIso,
          lastSeenAt: nowIso,
          expiresAt,
        },
        conn,
      );
      return { token, expiresAt };
    },

    /**
     * Resolve a sessão do token e renova o prazo (no máximo uma escrita a cada
     * `sessionTouchIntervalSeconds`).
     * @returns {Promise<{ userId: string, sessionId: string } | null>}
     */
    async resolveSession(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
      const current = now();
      const nowMs = current.getTime();
      const session = await sessionsRepository.findActiveByTokenHash(hashToken(token), current.toISOString());
      if (!session) return null;

      if (nowMs - Date.parse(session.lastSeenAt) >= config.sessionTouchIntervalSeconds * 1000) {
        await sessionsRepository.touch(session.id, {
          lastSeenAt: current.toISOString(),
          expiresAt: nextExpiry(nowMs, Date.parse(session.createdAt)),
        });
      }
      return { userId: session.userId, sessionId: session.id };
    },

    /** Idempotente; `sessionId` nulo não faz nada. */
    async revokeSession(sessionId, { conn } = {}) {
      if (!sessionId) return;
      await sessionsRepository.revoke(sessionId, now().toISOString(), conn);
    },
  };
}
