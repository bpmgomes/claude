import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestApp } from '../helpers/test-app.js';

const dir = await mkdtemp(join(tmpdir(), 'agendafacil-af02-'));

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('contador e bloqueio sobrevivem a reinício da aplicação (critério 13)', async () => {
  const databasePath = join(dir, 'test.db');
  const credentials = { email: 'ana@x.com', password: 'abcd1234' };

  const first = (await buildTestApp({ databasePath })).app;
  try {
    await first.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Ana', ...credentials } });
    for (let i = 0; i < 5; i++) {
      const res = await first.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { ...credentials, password: 'errada' },
      });
      assert.equal(res.statusCode, 401);
    }
  } finally {
    await first.close();
  }

  const second = (await buildTestApp({ databasePath })).app;
  try {
    const res = await second.inject({ method: 'POST', url: '/api/auth/login', payload: credentials });
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error.code, 'LOGIN_LOCKED');
  } finally {
    await second.close();
  }
});
