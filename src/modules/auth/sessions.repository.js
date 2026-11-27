/** @param {import('../../db/index.js').Database} db */
export function createSessionsRepository(db) {
  return {
    async insert({ id, userId, tokenHash, createdAt, lastSeenAt, expiresAt }, conn = db) {
      await conn.run(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, userId, tokenHash, createdAt, lastSeenAt, expiresAt],
      );
      return { id, userId, tokenHash, createdAt, lastSeenAt, expiresAt, revokedAt: null };
    },

    /**
     * Sessão não revogada e não expirada. AF-03 (critério 35, defesa em profundidade): também recusa
     * a sessão criada antes da última troca de senha (`users.password_changed_at`). `>=` porque o
     * login seguinte pode cair no mesmo milissegundo da troca; a sessão de antes já foi revogada.
     */
    async findActiveByTokenHash(tokenHash, nowIso, conn = db) {
      const row = await conn.get(
        `SELECT s.id, s.user_id, s.token_hash, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
            AND (u.password_changed_at IS NULL OR s.created_at >= u.password_changed_at)`,
        [tokenHash, nowIso],
      );
      if (!row) return undefined;
      return {
        id: row.id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      };
    },

    /** Renova o prazo de uma sessão não revogada. */
    async touch(id, { lastSeenAt, expiresAt }, conn = db) {
      await conn.run(
        'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL',
        [lastSeenAt, expiresAt, id],
      );
    },

    /** Revoga todas as sessões ativas da conta (AF-03, critério 19). @returns {Promise<number>} */
    async revokeAllForUser(userId, nowIso, conn = db) {
      const { changes } = await conn.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
        nowIso,
        userId,
      ]);
      return changes;
    },

    /** Revoga a sessão (idempotente). */
    async revoke(id, nowIso, conn = db) {
      await conn.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [nowIso, id]);
    },
  };
}
