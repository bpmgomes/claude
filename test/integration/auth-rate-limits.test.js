// AF-03 (design 4.3, critérios 22 a 24): limitador persistido, com relógio controlável. Janela fixa
// (IP) e janela deslizante (e-mail, revisão de segurança, decisão 3 do Gerente).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createAuthRateLimitsRepository } from '../../src/modules/auth/auth-rate-limits.repository.js';
import { createAuthRateLimiter, rateKey } from '../../src/modules/auth/auth-rate-limits.service.js';
import { createClock } from '../helpers/clock.js';

const MIN = 60_000;
const IP = 'password_reset_request_ip';
const CONFIRM = 'password_reset_confirm_ip';
const EMAIL = 'password_reset_request_email';

let db;
let clock;
let repo;
let limiter;

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  clock = createClock('2026-11-26T12:00:00.000Z');
  repo = createAuthRateLimitsRepository(db);
  limiter = createAuthRateLimiter({ authRateLimitsRepository: repo, now: clock.now });
});
afterEach(() => db.close());

const reserve = (bucket) => db.transaction((tx) => limiter.reserve(tx, { max: 3, windowMs: 60 * MIN, ...bucket }));
/** Os padrões do pedido por e-mail: 3 por hora e 5 por 24 h, deslizantes. */
const WINDOWS = [
  { max: 3, windowMs: 60 * MIN },
  { max: 5, windowMs: 24 * 60 * MIN },
];
const sliding = (value, windows = WINDOWS) => db.transaction((tx) => limiter.reserveSliding(tx, { scope: EMAIL, value, windows }));
const events = () => db.all('SELECT * FROM auth_rate_events ORDER BY occurred_at, rowid');

test('max passam; o seguinte devolve retryAfterSeconds exato e não altera nada', async () => {
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await reserve({ scope: IP, value: '1.2.3.4' }), { allowed: true });
    clock.advance(MIN);
  }
  const before = await db.all('SELECT * FROM auth_rate_limits');
  // Janela começou em t0; agora t0 + 3 min: faltam 57 min.
  assert.deepEqual(await reserve({ scope: IP, value: '1.2.3.4' }), { allowed: false, retryAfterSeconds: 57 * 60 });
  assert.deepEqual(await db.all('SELECT * FROM auth_rate_limits'), before);
  clock.advance(500);
  assert.deepEqual(await reserve({ scope: IP, value: '1.2.3.4' }), { allowed: false, retryAfterSeconds: 57 * 60 - 0 });
});

test('virada da janela recomeça em 1 (janela fixa, não deslizante)', async () => {
  for (let i = 0; i < 3; i++) await reserve({ scope: IP, value: 'a' });
  clock.advance(60 * MIN - 1);
  assert.equal((await reserve({ scope: IP, value: 'a' })).allowed, false);
  clock.advance(1);
  assert.deepEqual(await reserve({ scope: IP, value: 'a' }), { allowed: true });
  const row = await repo.find(IP, rateKey(IP, 'a'));
  assert.deepEqual(row, { windowStartedAt: clock.now().toISOString(), hits: 1 });
  assert.equal((await reserve({ scope: IP, value: 'a' })).allowed, true);
  assert.equal((await reserve({ scope: IP, value: 'a' })).allowed, true);
  assert.equal((await reserve({ scope: IP, value: 'a' })).allowed, false);
});

test('escopos e chaves independentes', async () => {
  for (let i = 0; i < 3; i++) await reserve({ scope: IP, value: 'x' });
  assert.equal((await reserve({ scope: IP, value: 'x' })).allowed, false);
  assert.equal((await reserve({ scope: IP, value: 'y' })).allowed, true);
  assert.equal((await reserve({ scope: CONFIRM, value: 'x', max: 10, windowMs: 15 * MIN })).allowed, true);
  // O mesmo valor na janela deslizante do e-mail também é independente.
  assert.equal((await sliding('x')).allowed, true);
});

test('chave sem e-mail nem IP em claro; rateKey é sha256 de scope \\n valor', async () => {
  await sliding('ana@x.com');
  await reserve({ scope: IP, value: '203.0.113.7' });
  const text = JSON.stringify([await db.all('SELECT * FROM auth_rate_limits'), await db.all('SELECT * FROM auth_rate_events')]);
  assert.equal(text.includes('ana@x.com'), false);
  assert.equal(text.includes('203.0.113.7'), false);
  assert.match(rateKey(EMAIL, 'ana@x.com'), /^[0-9a-f]{64}$/);
  assert.notEqual(rateKey(EMAIL, 'a'), rateKey(IP, 'a'));
});

test('purgeOld apaga baldes velhos em lotes', async () => {
  for (let i = 0; i < 7; i++) await reserve({ scope: IP, value: `ip${i}` });
  clock.advance(25 * 60 * MIN);
  await reserve({ scope: IP, value: 'novo' });
  const cutoff = new Date(clock.now().getTime() - 24 * 60 * MIN).toISOString();
  assert.equal(await repo.purgeOld(cutoff, { batch: 2 }), 7);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM auth_rate_limits')).n), 1);
});

describe('janela deslizante (e-mail)', () => {
  test('borda: 3 no fim de uma hora + 3 no início da seguinte dão só 3', async () => {
    // Relógio em 12:00:00: vai para 12:59:59 e depois para 13:00:00 (a virada de uma hora "de relógio").
    clock.advance(60 * MIN - 1000);
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await sliding('a@x.com')).allowed);
    clock.advance(1000);
    assert.equal(clock.now().toISOString(), '2026-11-26T13:00:00.000Z');
    for (let i = 0; i < 3; i++) results.push((await sliding('a@x.com')).allowed);
    assert.deepEqual(results, [true, true, true, false, false, false]);
    assert.equal((await events()).length, 3, 'os recusados não gravam');
  });

  test('borda da janela fixa a partir do 1º acerto: 1 em t0, 2 em t0+59:59, 3 em t0+60:00 dão só 4', async () => {
    const results = [];
    results.push((await sliding('b@x.com')).allowed);
    clock.advance(60 * MIN - 1000);
    for (let i = 0; i < 2; i++) results.push((await sliding('b@x.com')).allowed);
    clock.advance(1000);
    for (let i = 0; i < 3; i++) results.push((await sliding('b@x.com')).allowed);
    assert.deepEqual(results, [true, true, true, true, false, false]);
  });

  test('retryAfterSeconds: quando sai da janela o acerto que a enche; nada gravado na recusa', async () => {
    for (let i = 0; i < 3; i++) {
      await sliding('c@x.com');
      clock.advance(10 * MIN);
    }
    // Acertos em t0, t0+10, t0+20; agora t0+30: o de t0 sai em 30 min.
    const before = await events();
    assert.deepEqual(await sliding('c@x.com'), { allowed: false, retryAfterSeconds: 30 * 60 });
    assert.deepEqual(await events(), before);
    clock.advance(30 * MIN - 1);
    assert.equal((await sliding('c@x.com')).allowed, false);
    clock.advance(1);
    assert.equal((await sliding('c@x.com')).allowed, true);
  });

  test('5 por 24 h: pedidos a cada 61 min, o 6º é recusado até o 1º sair da janela de 24 h', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push((await sliding('d@x.com')).allowed);
      clock.advance(61 * MIN);
    }
    assert.deepEqual(results, [true, true, true, true, true, false]);
    // Agora t0 + 6 x 61 min; o 1º acerto (t0) sai em 24 h - 366 min.
    const denied = await sliding('d@x.com');
    assert.deepEqual(denied, { allowed: false, retryAfterSeconds: (24 * 60 - 366) * 60 });
    clock.advance(denied.retryAfterSeconds * 1000);
    assert.equal((await sliding('d@x.com')).allowed, true);
    assert.equal((await sliding('d@x.com')).allowed, false, 'o 2º acerto ainda está na janela de 24 h');
  });

  test('várias janelas cheias: vale a espera mais longa', async () => {
    const windows = [
      { max: 1, windowMs: 10 * MIN },
      { max: 2, windowMs: 60 * MIN },
    ];
    await sliding('e@x.com', windows);
    clock.advance(20 * MIN);
    await sliding('e@x.com', windows);
    clock.advance(MIN);
    // 10 min: cheia até t0+30; 60 min: cheia até t0+60. Espera: 39 min.
    assert.deepEqual(await sliding('e@x.com', windows), { allowed: false, retryAfterSeconds: 39 * 60 });
  });

  test('purgeEvents e purgeOld respeitam maxBatches (lote limitado do ciclo do worker)', async () => {
    for (let i = 0; i < 5; i++) await sliding(`f${i}@x.com`);
    for (let i = 0; i < 5; i++) await reserve({ scope: IP, value: `g${i}` });
    clock.advance(25 * 60 * MIN);
    const cutoff = new Date(clock.now().getTime() - 24 * 60 * MIN).toISOString();
    assert.equal(await repo.purgeEvents(cutoff, { batch: 2, maxBatches: 1 }), 2);
    assert.equal(await repo.purgeOld(cutoff, { batch: 2, maxBatches: 2 }), 4);
    assert.equal(await repo.purgeEvents(cutoff), 3);
    assert.equal(await repo.purgeOld(cutoff), 1);
    assert.equal((await events()).length, 0);
  });
});
