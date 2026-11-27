// Tokens de redefinição de senha (AF-03, design 3.1 e 4.3). Só o SHA-256 do token; o texto puro
// nunca é gravado. `conn` é a conexão ou a transação do chamador (padrão: o `db` global).
import { purgeInBatches } from './auth-rate-limits.repository.js';

/** @param {import('../../db/index.js').Database} db */
export function createPasswordResetTokensRepository(db) {
  return {
    /** @throws {import('../../db/errors.js').UniqueViolationError} outro pendente da mesma conta */
    async insert({ tokenHash, userId, createdAt, expiresAt }, conn = db) {
      await conn.run(
        'INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)',
        [tokenHash, userId, createdAt, expiresAt],
      );
    },

    /**
     * Token utilizável: não usado e `agora < expires_at` (critério 9). Só leitura.
     * @returns {Promise<{ userId: string } | undefined>}
     */
    async findUsable(tokenHash, nowIso, conn = db) {
      const row = await conn.get(
        'SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
        [tokenHash, nowIso],
      );
      return row ? { userId: row.user_id } : undefined;
    },

    /**
     * Uso único (critério 10): UPDATE condicional. O chamador EXIGE `changes === 1`.
     * @returns {Promise<{ changes: number }>}
     */
    async consume(tokenHash, userId, nowIso, conn = db) {
      return conn.run(
        `UPDATE password_reset_tokens SET used_at = ?
          WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?`,
        [nowIso, tokenHash, userId, nowIso],
      );
    },

    /** Apaga os pendentes da conta, vencidos ou não (critérios 11 e 21). @returns {Promise<number>} */
    async deletePendingForUser(userId, conn = db) {
      const { changes } = await conn.run('DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL', [userId]);
      return changes;
    },

    /** Descarte do token de um envio que falhou (critério 31). @returns {Promise<number>} */
    async deleteByHash(tokenHash, conn = db) {
      const { changes } = await conn.run('DELETE FROM password_reset_tokens WHERE token_hash = ?', [tokenHash]);
      return changes;
    },

    /**
     * `expires_at <= cutoffIso`, usados ou não, em lotes: até 0 no boot; `maxBatches` lotes no ciclo
     * do worker. @returns {Promise<number>}
     */
    async purgeExpired(cutoffIso, { batch = 500, maxBatches = Infinity } = {}, conn = db) {
      return purgeInBatches(
        conn,
        `DELETE FROM password_reset_tokens WHERE rowid IN (
           SELECT rowid FROM password_reset_tokens WHERE expires_at <= ? LIMIT ?)`,
        cutoffIso,
        { batch, maxBatches },
      );
    },
  };
}
