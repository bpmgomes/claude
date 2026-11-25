/** @param {import('../../db/index.js').Database} db */
export function createLoginAttemptsRepository(db) {
  return {
    /**
     * Cria a linha (failed_count = 0) se não existir e trava a linha. Deve ser a
     * primeira instrução da transação de reserva: no PostgreSQL o
     * INSERT ... ON CONFLICT DO UPDATE trava a linha; no SQLite a transação é
     * BEGIN IMMEDIATE e já é exclusiva.
     */
    async touch(keyHash, nowIso, conn = db) {
      await conn.run(
        `INSERT INTO login_attempts (key_hash, failed_count, locked_until, updated_at)
         VALUES (?, 0, NULL, ?)
         ON CONFLICT (key_hash) DO UPDATE SET updated_at = excluded.updated_at`,
        [keyHash, nowIso],
      );
    },

    /** @returns {Promise<{ failedCount: number, lockedUntil: string|null, updatedAt: string } | undefined>} */
    async find(keyHash, conn = db) {
      const row = await conn.get(
        'SELECT failed_count, locked_until, updated_at FROM login_attempts WHERE key_hash = ?',
        [keyHash],
      );
      if (!row) return undefined;
      return {
        failedCount: Number(row.failed_count),
        lockedUntil: row.locked_until ?? null,
        updatedAt: row.updated_at,
      };
    },

    async update(keyHash, { failedCount, lockedUntil, updatedAt }, conn = db) {
      await conn.run(
        'UPDATE login_attempts SET failed_count = ?, locked_until = ?, updated_at = ? WHERE key_hash = ?',
        [failedCount, lockedUntil, updatedAt, keyHash],
      );
    },

    async clear(keyHash, conn = db) {
      await conn.run('DELETE FROM login_attempts WHERE key_hash = ?', [keyHash]);
    },
  };
}
