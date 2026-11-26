import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { UniqueViolationError, ExclusionViolationError } from './errors.js';

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_TRIGGER = 1811;

/**
 * Restrições de exclusão implementadas por trigger com RAISE(ABORT, '<nome>') (AF-11, 3.1). A
 * mensagem do erro é exatamente o nome; outra mensagem de trigger passa como está.
 */
export const EXCLUSION_CONSTRAINTS = Object.freeze(['appointments_no_overlap']);

/**
 * Traduz erros do driver SQLite para erros neutros.
 * O SQLite não informa o nome da constraint, só as colunas
 * ("UNIQUE constraint failed: users.email"). Pela convenção do projeto,
 * constraints únicas se chamam `<tabela>_<colunas>_unique`, e o nome é
 * reconstruído a partir da mensagem.
 */
export function translateError(err) {
  const message = String(err?.message ?? '');
  const isTrigger = err?.errcode === SQLITE_CONSTRAINT_TRIGGER || err?.code === 'SQLITE_CONSTRAINT_TRIGGER';
  if (isTrigger && EXCLUSION_CONSTRAINTS.includes(message)) {
    return new ExclusionViolationError(message, { cause: err });
  }
  const isUnique =
    err?.errcode === SQLITE_CONSTRAINT_UNIQUE ||
    err?.errcode === SQLITE_CONSTRAINT_PRIMARYKEY ||
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    message.includes('UNIQUE constraint failed');
  if (!isUnique) return err;

  let constraint;
  const match = message.match(/(?:UNIQUE|PRIMARY KEY) constraint failed: (.+)$/);
  if (match) {
    const parts = match[1].split(',').map((s) => s.trim());
    const table = parts[0].split('.')[0];
    const cols = parts.map((p) => p.split('.').slice(1).join('.'));
    constraint = `${table}_${cols.join('_')}_unique`;
  }
  return new UniqueViolationError(constraint, { cause: err });
}

function toPlain(row) {
  return row === undefined ? undefined : { ...row };
}

/**
 * Executor síncrono sobre uma conexão; envolto em Promises pelos métodos públicos.
 */
function makeExecutor(conn) {
  const wrap = (fn) => {
    try {
      return fn();
    } catch (err) {
      throw translateError(err);
    }
  };
  return {
    run: (sql, params = []) =>
      wrap(() => {
        const r = conn.prepare(sql).run(...params);
        return { changes: Number(r.changes) };
      }),
    get: (sql, params = []) => wrap(() => toPlain(conn.prepare(sql).get(...params))),
    all: (sql, params = []) => wrap(() => conn.prepare(sql).all(...params).map(toPlain)),
    exec: (sql) => wrap(() => void conn.exec(sql)),
  };
}

/**
 * Implementação SQLite da interface Database (ver ./index.js).
 *
 * UMA conexão por processo (AF-11, R6): o driver é síncrono, e com duas conexões do adapter no
 * mesmo processo o `busy_timeout` de uma bloquearia o event loop enquanto a outra precisa dele
 * para terminar a transação (a espera só acabaria no timeout). Vários PROCESSOS no mesmo arquivo
 * (WAL) funcionam: o `BEGIN IMMEDIATE` de um espera o do outro. Não abra outra instância desta
 * classe sobre o mesmo arquivo dentro do processo.
 *
 * A conexão é única e o driver é síncrono, mas `transaction(fn)` aceita
 * callbacks assíncronos. Para que duas transações não se misturem na mesma
 * conexão, transações (e operações fora delas) são serializadas por uma fila.
 */
export class SqliteDatabase {
  constructor(databasePath) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.conn = new DatabaseSync(databasePath);
    this.conn.exec('PRAGMA foreign_keys = ON;');
    if (databasePath !== ':memory:') this.conn.exec('PRAGMA journal_mode = WAL;');
    this.conn.exec('PRAGMA busy_timeout = 5000;');
    this.exe = makeExecutor(this.conn);
    /** @type {Promise<void>} */
    this.queue = Promise.resolve();
  }

  /** Enfileira uma tarefa para rodar com exclusividade sobre a conexão. */
  #enqueue(task) {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  run(sql, params) {
    return this.#enqueue(() => this.exe.run(sql, params));
  }

  get(sql, params) {
    return this.#enqueue(() => this.exe.get(sql, params));
  }

  all(sql, params) {
    return this.#enqueue(() => this.exe.all(sql, params));
  }

  exec(sql) {
    return this.#enqueue(() => this.exe.exec(sql));
  }

  /**
   * @template T
   * @param {(tx: import('./index.js').Database) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  transaction(fn) {
    return this.#enqueue(async () => {
      const exe = this.exe;
      const tx = {
        run: async (sql, params) => exe.run(sql, params),
        get: async (sql, params) => exe.get(sql, params),
        all: async (sql, params) => exe.all(sql, params),
        exec: async (sql) => exe.exec(sql),
        transaction: async (inner) => inner(tx), // aninhada: reaproveita a transação atual
        close: async () => {
          throw new Error('Não é possível fechar a conexão dentro de uma transação.');
        },
      };
      exe.exec('BEGIN IMMEDIATE');
      try {
        const value = await fn(tx);
        exe.exec('COMMIT');
        return value;
      } catch (err) {
        try {
          exe.exec('ROLLBACK');
        } catch {
          // transação já encerrada pelo SQLite
        }
        throw err;
      }
    });
  }

  close() {
    return this.#enqueue(() => {
      if (this.conn.isOpen) this.conn.close();
    });
  }
}
