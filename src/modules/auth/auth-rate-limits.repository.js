// Limites persistidos da recuperação de senha (AF-03, design 3.1 e 4.3, critérios 22 a 24). Por IP,
// janela fixa (`auth_rate_limits`); por e-mail, janela deslizante sobre os pedidos aceitos
// (`auth_rate_events`, revisão de segurança). A chave é um SHA-256 (nada de e-mail nem IP em claro).

/** @param {import('../../db/index.js').Database} db */
export function createAuthRateLimitsRepository(db) {
  return {
    /**
     * Cria o balde (hits 0, janela = agora) se não existir. Primeira instrução da transação de
     * reserva: no PostgreSQL o INSERT ... ON CONFLICT trava a linha; no SQLite a transação é
     * BEGIN IMMEDIATE.
     */
    async touch(scope, keyHash, nowIso, conn = db) {
      await conn.run(
        `INSERT INTO auth_rate_limits (scope, key_hash, window_started_at, hits) VALUES (?, ?, ?, 0)
         ON CONFLICT (scope, key_hash) DO NOTHING`,
        [scope, keyHash, nowIso],
      );
    },

    /** @returns {Promise<{ windowStartedAt: string, hits: number } | undefined>} */
    async find(scope, keyHash, conn = db) {
      const row = await conn.get('SELECT window_started_at, hits FROM auth_rate_limits WHERE scope = ? AND key_hash = ?', [
        scope,
        keyHash,
      ]);
      return row ? { windowStartedAt: row.window_started_at, hits: Number(row.hits) } : undefined;
    },

    async update(scope, keyHash, { windowStartedAt, hits }, conn = db) {
      await conn.run('UPDATE auth_rate_limits SET window_started_at = ?, hits = ? WHERE scope = ? AND key_hash = ?', [
        windowStartedAt,
        hits,
        scope,
        keyHash,
      ]);
    },

    /**
     * Baldes com `window_started_at <= cutoffIso`, em lotes: até 0 no boot; `maxBatches` lotes no ciclo
     * do worker. @returns {Promise<number>}
     */
    async purgeOld(cutoffIso, { batch = 500, maxBatches = Infinity } = {}, conn = db) {
      return purgeInBatches(
        conn,
        `DELETE FROM auth_rate_limits WHERE rowid IN (
           SELECT rowid FROM auth_rate_limits WHERE window_started_at <= ? LIMIT ?)`,
        cutoffIso,
        { batch, maxBatches },
      );
    },

    /** Um pedido aceito na janela deslizante. */
    async insertEvent(scope, keyHash, occurredAtIso, conn = db) {
      await conn.run('INSERT INTO auth_rate_events (scope, key_hash, occurred_at) VALUES (?, ?, ?)', [scope, keyHash, occurredAtIso]);
    },

    /**
     * Instantes dos eventos da chave com `occurred_at > sinceIso`, do mais novo ao mais velho.
     * @returns {Promise<string[]>}
     */
    async eventsSince(scope, keyHash, sinceIso, conn = db) {
      const rows = await conn.all(
        `SELECT occurred_at FROM auth_rate_events
          WHERE scope = ? AND key_hash = ? AND occurred_at > ?
          ORDER BY occurred_at DESC`,
        [scope, keyHash, sinceIso],
      );
      return rows.map((r) => r.occurred_at);
    },

    /** Eventos com `occurred_at <= cutoffIso`, em lotes (como `purgeOld`). @returns {Promise<number>} */
    async purgeEvents(cutoffIso, { batch = 500, maxBatches = Infinity } = {}, conn = db) {
      return purgeInBatches(
        conn,
        `DELETE FROM auth_rate_events WHERE rowid IN (
           SELECT rowid FROM auth_rate_events WHERE occurred_at <= ? LIMIT ?)`,
        cutoffIso,
        { batch, maxBatches },
      );
    },
  };
}

/** DELETE em lotes de `batch` até sobrar menos que um lote ou chegar a `maxBatches`. */
export async function purgeInBatches(conn, sql, cutoffIso, { batch, maxBatches }) {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { changes } = await conn.run(sql, [cutoffIso, batch]);
    total += changes;
    if (changes < batch) break;
  }
  return total;
}
