// Banco instrumentado (AF-11, critério 24): registra o SQL de cada chamada e LANÇA se o `db` global
// for usado enquanto uma transação está aberta (no SQLite, o adapter enfileiraria e travaria).

/**
 * Envolve o `db` real. Devolve um objeto com a mesma interface (`run`, `get`, `all`, `exec`,
 * `transaction`, `close`) e o registro `calls` (`{ sql, params, inTx }` em ordem).
 * @param {import('../../src/db/index.js').Database} db
 */
export function instrumentDb(db) {
  const calls = [];
  let openTransactions = 0;

  function guardGlobal(method) {
    return (sql, params) => {
      if (openTransactions > 0) {
        throw new Error(`db global usado dentro de uma transação (${method}): ${String(sql).slice(0, 60)}`);
      }
      calls.push({ sql, params, inTx: false });
      return db[method](sql, params);
    };
  }

  function wrapTx(tx) {
    const wrapped = {};
    for (const method of ['run', 'get', 'all', 'exec']) {
      wrapped[method] = (sql, params) => {
        calls.push({ sql, params, inTx: true });
        return tx[method](sql, params);
      };
    }
    wrapped.transaction = (fn) => fn(wrapped);
    wrapped.close = tx.close;
    return wrapped;
  }

  return {
    calls,
    run: guardGlobal('run'),
    get: guardGlobal('get'),
    all: guardGlobal('all'),
    exec: guardGlobal('exec'),
    close: () => db.close(),
    transaction(fn) {
      return db.transaction(async (tx) => {
        openTransactions += 1;
        try {
          return await fn(wrapTx(tx));
        } finally {
          openTransactions -= 1;
        }
      });
    },
    /** SQL normalizado (espaços colapsados), para comparar sequências. */
    sqlOf(filter = () => true) {
      return calls.filter(filter).map((c) => String(c.sql).replace(/\s+/g, ' ').trim());
    },
    reset() {
      calls.length = 0;
    },
  };
}
