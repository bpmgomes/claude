/**
 * @typedef {{ id: string, name: string, email: string, passwordHash: string, createdAt: string, updatedAt: string,
 *   passwordChangedAt: string|null }} User
 * `passwordChangedAt` (AF-03, critério 35): última troca por redefinição; null = nunca.
 * @typedef {{ id: string, name: string, email: string, createdAt: string }} PublicUser
 */

const INSERT_COLUMNS = 'id, name, email, password_hash, created_at, updated_at';
const COLUMNS = `${INSERT_COLUMNS}, password_changed_at`;

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    passwordChangedAt: row.password_changed_at ?? null,
  };
}

/** Único caminho para serializar um usuário para fora do backend. */
export function toPublicUser(user) {
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
}

/** @param {import('../../db/index.js').Database} db */
export function createUsersRepository(db) {
  return {
    /**
     * @returns {Promise<User>}
     * @throws {import('../../db/errors.js').UniqueViolationError}
     */
    async insert({ id, name, email, passwordHash, createdAt }, conn = db) {
      await conn.run(
        `INSERT INTO users (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, email, passwordHash, createdAt, createdAt],
      );
      return { id, name, email, passwordHash, createdAt, updatedAt: createdAt, passwordChangedAt: null };
    },

    /** @returns {Promise<User|undefined>} */
    async findById(id, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]));
    },

    /** @returns {Promise<User|undefined>} */
    async findByEmail(email, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM users WHERE email = ?`, [email]));
    },

    /**
     * Troca o hash e grava `password_changed_at` (AF-03, 5.4). Na transação da redefinição.
     * @returns {Promise<{ changes: number }>}
     */
    async updatePassword(id, { passwordHash, changedAt }, conn = db) {
      return conn.run(
        'UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?',
        [passwordHash, changedAt, changedAt, id],
      );
    },

    /** Só o hash atual (releitura do login dentro da transação, AF-03 5.5). @returns {Promise<string|undefined>} */
    async findPasswordHash(id, conn = db) {
      const row = await conn.get('SELECT password_hash FROM users WHERE id = ?', [id]);
      return row ? row.password_hash : undefined;
    },
  };
}
