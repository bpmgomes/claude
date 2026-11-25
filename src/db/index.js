import { SqliteDatabase } from './sqlite.js';

/**
 * Interface assíncrona de banco (independente do driver).
 *
 * @typedef {Object} Database
 * @property {(sql: string, params?: unknown[]) => Promise<{ changes: number }>} run
 * @property {(sql: string, params?: unknown[]) => Promise<object|undefined>} get
 * @property {(sql: string, params?: unknown[]) => Promise<object[]>} all
 * @property {<T>(fn: (tx: Database) => Promise<T>) => Promise<T>} transaction
 * @property {(sql: string) => Promise<void>} exec   // usado só pelas migrações
 * @property {() => Promise<void>} close
 */

/**
 * @param {{ databasePath: string }} options
 * @returns {Database}
 */
export function createDatabase({ databasePath }) {
  return new SqliteDatabase(databasePath);
}
