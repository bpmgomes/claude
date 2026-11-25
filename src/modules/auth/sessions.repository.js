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

    /** Sessão não revogada e não expirada. */
    async findActiveByTokenHash(tokenHash, nowIso, conn = db) {
      const row = await conn.get(
        `SELECT id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at
           FROM sessions
          WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
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

    /** Revoga a sessão (idempotente). */
    async revoke(id, nowIso, conn = db) {
      await conn.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [nowIso, id]);
    },
  };
}
