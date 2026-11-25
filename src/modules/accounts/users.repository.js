/**
 * @typedef {{ id: string, name: string, email: string, passwordHash: string, createdAt: string, updatedAt: string }} User
 * @typedef {{ id: string, name: string, email: string, createdAt: string }} PublicUser
 */

const COLUMNS = 'id, name, email, password_hash, created_at, updated_at';

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
        `INSERT INTO users (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, email, passwordHash, createdAt, createdAt],
      );
      return { id, name, email, passwordHash, createdAt, updatedAt: createdAt };
    },

    /** @returns {Promise<User|undefined>} */
    async findById(id, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]));
    },

    /** @returns {Promise<User|undefined>} */
    async findByEmail(email, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM users WHERE email = ?`, [email]));
    },
  };
}
