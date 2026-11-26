import { randomUUID } from 'node:crypto';
import { validateCustomerInput } from '../../shared/customers.js';
import { ValidationError } from '../../http/errors.js';

/**
 * Snapshot dos dados digitados num agendamento (decisão 1). Valores já normalizados, congelados.
 * O AF-11 grava name e phone no próprio agendamento (design 4.5). O e-mail é a chave do cliente e
 * é igual a customers.email por construção.
 * @typedef {Readonly<{ name: string, phone: string, email: string }>} CustomerSnapshot
 *
 * Porta customers (critério 13). Só o AF-11 (e depois o AF-15) chama, nunca uma rota pública direta.
 * @typedef {{
 *   validate(input: unknown): import('../../shared/customers.js').CustomerInput,
 *   findOrCreate(businessId: string, input: unknown, conn: import('../../db/index.js').Database)
 *     : Promise<{ customerId: string, snapshot: CustomerSnapshot }>,
 * }} CustomersPort
 */

/**
 * Nada aqui loga: nome, telefone e e-mail nunca vão para log, erro ou contador (critério 20).
 * @param {{
 *   customersRepository: ReturnType<typeof import('./customers.repository.js').createCustomersRepository>,
 *   now: () => Date,
 *   newId?: () => string,
 * }} deps
 * @returns {CustomersPort}
 */
export function createCustomersService({ customersRepository, now, newId = randomUUID }) {
  /** @throws {ValidationError} */
  function validate(input) {
    const result = validateCustomerInput(input);
    if (!result.ok) throw new ValidationError(result.fields);
    return result.value;
  }

  return {
    validate,

    /**
     * Obtém ou cria o cliente por (negócio, e-mail normalizado), na conexão ou transação do
     * chamador (design 5.1). Nunca altera um cliente existente e não informa se criou ou
     * reaproveitou (critério 11). `conn` é obrigatório: dentro de uma transação, usar o `db`
     * global travaria a fila do adapter SQLite.
     */
    async findOrCreate(businessId, input, conn) {
      if (!conn || typeof conn.run !== 'function' || typeof conn.get !== 'function') {
        throw new TypeError('customers.findOrCreate exige a conexão ou transação do chamador.');
      }
      const value = validate(input);
      const createdAt = now().toISOString();
      await customersRepository.insertIfAbsent({ id: newId(), businessId, ...value, createdAt }, conn);
      const customerId = await customersRepository.findIdByEmail(businessId, value.email, conn);
      // Não deve acontecer sob READ COMMITTED ou com o SQLite (R5): falha alta, sem dado pessoal.
      if (!customerId) throw new Error('customer_upsert_missing');
      return { customerId, snapshot: Object.freeze({ ...value }) };
    },
  };
}
