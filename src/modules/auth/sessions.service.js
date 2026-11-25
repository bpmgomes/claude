import { randomBytes, randomUUID, createHash } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionsService({ sessionsRepository, config, now = () => new Date() }) {
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
      const expiresAt = new Date(current.getTime() + config.sessionTtlDays * DAY_MS).toISOString();
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

    /** @returns {Promise<{ userId: string, sessionId: string } | null>} */
    async resolveSession(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
      const session = await sessionsRepository.findActiveByTokenHash(
        hashToken(token),
        now().toISOString(),
      );
      return session ? { userId: session.userId, sessionId: session.id } : null;
    },
  };
}
