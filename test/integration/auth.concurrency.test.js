import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadConfig, mergeConfig } from '../../src/config.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createSessionsRepository } from '../../src/modules/auth/sessions.repository.js';
import { createSessionsService } from '../../src/modules/auth/sessions.service.js';
import { createLoginAttemptsRepository } from '../../src/modules/auth/login-attempts.repository.js';
import { createLoginAttemptsService } from '../../src/modules/auth/login-attempts.service.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';
import { LoginLockedError, InvalidCredentialsError } from '../../src/http/errors.js';

const PASSWORD = 'abcd1234';
let db;
let config;
let calls;
let authService;

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  config = mergeConfig(loadConfig({}), { bcryptCost: 4 });
  const usersRepository = createUsersRepository(db);
  const sessionsService = createSessionsService({ sessionsRepository: createSessionsRepository(db), config });
  const loginAttemptsService = createLoginAttemptsService({
    db,
    loginAttemptsRepository: createLoginAttemptsRepository(db),
    config,
  });
  calls = [];
  const spy = async (plain, hash) => {
    calls.push({ plain, hash });
    return verifyPassword(plain, hash);
  };
  authService = createAuthService({
    db,
    usersRepository,
    sessionsService,
    loginAttemptsService,
    businessesRepository: createBusinessesRepository(db),
    config,
    verifyPassword: spy,
  });
  await usersRepository.insert({
    id: randomUUID(),
    name: 'Ana',
    email: 'ana@x.com',
    passwordHash: await hashPassword(PASSWORD, 4),
    createdAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  await db.close();
});

test('10 logins errados simultâneos chamam verifyPassword exatamente 5 vezes (critério 14)', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => authService.login({ email: 'ana@x.com', password: 'errada' }, { ip: '1.1.1.1' })),
  );
  assert.ok(results.every((r) => r.status === 'rejected'));
  const invalid = results.filter((r) => r.reason instanceof InvalidCredentialsError).length;
  const locked = results.filter((r) => r.reason instanceof LoginLockedError).length;
  assert.equal(invalid, 5);
  assert.equal(locked, 5);
  assert.equal(calls.length, 5);
});

test('e-mail inexistente chama verifyPassword 1 vez com o dummyHash de mesmo custo (critério 6)', async () => {
  await assert.rejects(
    authService.login({ email: 'nao-existe@x.com', password: PASSWORD }, { ip: '1.1.1.1' }),
    InvalidCredentialsError,
  );
  assert.equal(calls.length, 1);
  const { hash } = calls[0];
  assert.ok(hash.startsWith('$2'));
  assert.equal(bcrypt.getRounds(hash), config.bcryptCost);

  // senha errada para e-mail existente: também 1 chamada, mesmo custo
  calls.length = 0;
  await assert.rejects(
    authService.login({ email: 'ana@x.com', password: 'errada' }, { ip: '1.1.1.1' }),
    InvalidCredentialsError,
  );
  assert.equal(calls.length, 1);
  assert.equal(bcrypt.getRounds(calls[0].hash), config.bcryptCost);
});

test('login bloqueado não chama verifyPassword, mesmo com a senha certa (critério 9)', async () => {
  for (let i = 0; i < 5; i++) {
    await assert.rejects(authService.login({ email: 'ana@x.com', password: 'x' }, { ip: '1.1.1.1' }));
  }
  calls.length = 0;
  await assert.rejects(
    authService.login({ email: 'ana@x.com', password: PASSWORD }, { ip: '1.1.1.1' }),
    LoginLockedError,
  );
  assert.equal(calls.length, 0);
});

test('senha com mais de 72 bytes que começa com a senha real (truncamento do bcrypt) é rejeitada', async () => {
  const pw72 = 'a1' + 'x'.repeat(70);
  await createUsersRepository(db).insert({
    id: randomUUID(),
    name: 'Longa',
    email: 'longa@x.com',
    passwordHash: await hashPassword(pw72, 4),
    createdAt: new Date().toISOString(),
  });
  const longer = pw72 + 'extra';
  assert.equal(await bcrypt.compare(longer, (await db.get("SELECT password_hash FROM users WHERE email = 'longa@x.com'")).password_hash), true);
  await assert.rejects(
    authService.login({ email: 'longa@x.com', password: longer }, { ip: '1.1.1.1' }),
    InvalidCredentialsError,
  );
  const ok = await authService.login({ email: 'longa@x.com', password: pw72 }, { ip: '1.1.1.1' });
  assert.equal(ok.user.email, 'longa@x.com');
});
