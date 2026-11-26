// AF-18 (critério 8, decisão 2 do Gerente): backoff, teto de envios e códigos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  retryDelayMs,
  EMAIL_RETRY_DELAYS_MS,
  EMAIL_MAX_SENDS,
  EMAIL_ERROR_CODES,
  EMAIL_TRANSIENT_CODES,
  EMAIL_PERMANENT_CODES,
  EMAIL_LEASE_MS,
  EMAIL_SEND_TIMEOUT_MS,
} from '../../src/modules/email/email-rules.js';

const MIGRATION = fileURLToPath(new URL('../../src/db/migrations/013_email_outbox.sql', import.meta.url));

test('5 envios no total: 4 atrasos de 1 min, 5 min, 30 min e 2 h (decisão 2 do Gerente)', () => {
  assert.equal(EMAIL_MAX_SENDS, 5);
  assert.deepEqual([...EMAIL_RETRY_DELAYS_MS], [60_000, 300_000, 1_800_000, 7_200_000]);
  assert.equal(EMAIL_RETRY_DELAYS_MS.length, EMAIL_MAX_SENDS - 1);
});

test('retryDelayMs: random 0 dá o nominal; 0,999 fica abaixo de 1,2 × o nominal', () => {
  for (let k = 1; k <= 4; k++) {
    const nominal = EMAIL_RETRY_DELAYS_MS[k - 1];
    assert.equal(retryDelayMs(k, () => 0), nominal);
    const high = retryDelayMs(k, () => 0.999);
    assert.ok(high > nominal && high < nominal * 1.2, `${k}: ${high}`);
    // fora de [0, 1): grampeado
    assert.ok(retryDelayMs(k, () => 5) < nominal * 1.2);
    assert.equal(retryDelayMs(k, () => -1), nominal);
  }
  for (const k of [0, 5, 1.5, '1']) assert.throws(() => retryDelayMs(k), RangeError);
});

test('EMAIL_MAX_SENDS é o teto do CHECK de attempts da migração 013', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  const m = /attempts BETWEEN 0 AND (\d+)/.exec(sql);
  assert.ok(m);
  assert.equal(Number(m[1]), EMAIL_MAX_SENDS);
});

test('arrendamento bem acima do teto de envio', () => {
  assert.ok(EMAIL_LEASE_MS >= EMAIL_SEND_TIMEOUT_MS * 2);
});

test('todos os códigos passam no CHECK de last_error_code; classes sem interseção', async () => {
  assert.equal(EMAIL_TRANSIENT_CODES.some((c) => EMAIL_PERMANENT_CODES.includes(c)), false);
  assert.equal(new Set(EMAIL_ERROR_CODES).size, EMAIL_ERROR_CODES.length);
  const db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  for (const code of EMAIL_ERROR_CODES) {
    const row = await db.get(
      "SELECT (length(?) BETWEEN 1 AND 32 AND ? NOT GLOB '*[^a-z0-9_]*') AS ok",
      [code, code],
    );
    assert.equal(row.ok, 1, code);
  }
  await db.close();
});
