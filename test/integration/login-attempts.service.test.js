import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config.js';
import { createLoginAttemptsRepository } from '../../src/modules/auth/login-attempts.repository.js';
import {
  createLoginAttemptsService,
  attemptKey,
  normalizeIp,
} from '../../src/modules/auth/login-attempts.service.js';
import { createClock } from '../helpers/clock.js';

const MINUTE = 60 * 1000;
let db;
let repo;
let service;
let clock;

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  clock = createClock();
  repo = createLoginAttemptsRepository(db);
  service = createLoginAttemptsService({
    db,
    loginAttemptsRepository: repo,
    config: loadConfig({}),
    now: clock.now,
  });
});

afterEach(async () => {
  await db.close();
});

async function reserveTimes(key, n) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await service.reserve(key));
  return results;
}

test('5 reservas permitidas e a 6ª bloqueada com retryAfterSeconds 900 (critério 9)', async () => {
  const key = attemptKey('ana@x.com', '1.2.3.4');
  const results = await reserveTimes(key, 6);
  assert.deepEqual(results.slice(0, 5), Array(5).fill({ allowed: true }));
  assert.deepEqual(results[5], { allowed: false, retryAfterSeconds: 900 });
});

test('a chave é um hash: e-mail e IP não ficam em claro', async () => {
  const key = attemptKey('ana@x.com', '1.2.3.4');
  assert.match(key, /^[0-9a-f]{64}$/);
  await service.reserve(key);
  const rows = await db.all('SELECT * FROM login_attempts');
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes('ana@x.com'));
  assert.ok(!JSON.stringify(rows).includes('1.2.3.4'));
});

test('tentativa durante o bloqueio não muda locked_until (não prorroga)', async () => {
  const key = attemptKey('ana@x.com', '1.2.3.4');
  await reserveTimes(key, 5);
  const before = await repo.find(key);
  clock.advance(5 * MINUTE);
  const r = await service.reserve(key);
  assert.deepEqual(r, { allowed: false, retryAfterSeconds: 600 });
  const after = await repo.find(key);
  assert.equal(after.lockedUntil, before.lockedUntil);
  assert.equal(after.failedCount, 5);
});

test('com o relógio avançado 15 min o bloqueio expira e o contador recomeça em 1 (critério 10)', async () => {
  const key = attemptKey('ana@x.com', '1.2.3.4');
  await reserveTimes(key, 5);
  clock.advance(15 * MINUTE - 1000);
  assert.deepEqual(await service.reserve(key), { allowed: false, retryAfterSeconds: 1 });
  clock.advance(1000);
  assert.deepEqual(await service.reserve(key), { allowed: true });
  const row = await repo.find(key);
  assert.equal(row.failedCount, 1);
  assert.equal(row.lockedUntil, null);
});

test('clear zera o contador (critério 11)', async () => {
  const key = attemptKey('ana@x.com', '1.2.3.4');
  await reserveTimes(key, 4);
  await service.clear(key);
  assert.equal(await repo.find(key), undefined);
  const results = await reserveTimes(key, 5);
  assert.ok(results.every((r) => r.allowed));
});

test('e-mails diferentes e IPs diferentes têm chaves independentes', async () => {
  await reserveTimes(attemptKey('ana@x.com', '1.2.3.4'), 5);
  assert.deepEqual(await service.reserve(attemptKey('bia@x.com', '1.2.3.4')), { allowed: true });
  assert.deepEqual(await service.reserve(attemptKey('ana@x.com', '5.6.7.8')), { allowed: true });
  assert.equal((await service.reserve(attemptKey('ana@x.com', '1.2.3.4'))).allowed, false);
});

test('::ffff:1.2.3.4 e 1.2.3.4 dão a mesma chave', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(attemptKey('ana@x.com', '::ffff:1.2.3.4'), attemptKey('ana@x.com', '1.2.3.4'));
  assert.notEqual(attemptKey('ana@x.com', '::1'), attemptKey('ana@x.com', '1.2.3.4'));
});

test('reservas simultâneas são serializadas: de 10, exatamente 5 permitidas', async () => {
  const key = attemptKey('ana@x.com', '1.2.3.4');
  const results = await Promise.all(Array.from({ length: 10 }, () => service.reserve(key)));
  assert.equal(results.filter((r) => r.allowed).length, 5);
});
