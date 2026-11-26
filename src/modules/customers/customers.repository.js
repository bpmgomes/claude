/**
 * @typedef {{ id: string, businessId: string, name: string, phone: string, email: string,
 *   createdAt: string, updatedAt: string }} Customer
 */

const COLUMNS = 'id, business_id, name, phone, email, created_at, updated_at';

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Clientes finais (AF-04). Todo acesso filtra por `business_id`; `conn` é a conexão ou a transação
 * do chamador (padrão: o `db` global).
 * @param {import('../../db/index.js').Database} db
 */
export function createCustomersRepository(db) {
  return {
    /**
     * INSERT ... ON CONFLICT (business_id, email) DO NOTHING. Nunca lança por e-mail repetido e
     * nunca altera a linha existente (decisão 1). No PostgreSQL, a violação de unicidade abortaria
     * a transação do chamador; o DO NOTHING evita isso. Mesma sintaxe no SQLite (3.24+).
     * @returns {Promise<{ changes: number }>} 1 = criado, 0 = já existia (uso interno)
     */
    async insertIfAbsent({ id, businessId, name, phone, email, createdAt }, conn = db) {
      const result = await conn.run(
        `INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (business_id, email) DO NOTHING`,
        [id, businessId, name, phone, email, createdAt, createdAt],
      );
      return { changes: Number(result?.changes ?? 0) };
    },

    /** @returns {Promise<string|undefined>} */
    async findIdByEmail(businessId, email, conn = db) {
      const row = await conn.get('SELECT id FROM customers WHERE business_id = ? AND email = ?', [businessId, email]);
      return row ? row.id : undefined;
    },

    /** Para o AF-14 e os testes. @returns {Promise<Customer|undefined>} */
    async findById(id, businessId, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM customers WHERE id = ? AND business_id = ?`, [id, businessId]));
    },
  };
}
