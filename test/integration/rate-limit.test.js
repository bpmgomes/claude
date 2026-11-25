import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';

test('com rate limit ativo e signupMax 2, a 3ª requisição dá 429 RATE_LIMITED', async () => {
  const { app } = await buildTestApp({ rateLimit: { enabled: true, signupMax: 2 } });
  try {
    const statuses = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Ana', email: `ana${i}@x.com`, password: 'abcd1234' },
      });
      statuses.push(last.statusCode);
    }
    assert.deepEqual(statuses, [201, 201, 429]);
    assert.equal(last.json().error.code, 'RATE_LIMITED');
    assert.equal(typeof last.json().error.message, 'string');

    // Rate limit é só no cadastro
    const me = await app.inject({ method: 'GET', url: '/api/me' });
    assert.equal(me.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('com rate limit ativo e loginMax 2, a 3ª requisição de login do mesmo IP dá 429 RATE_LIMITED', async () => {
  const { app } = await buildTestApp({ rateLimit: { enabled: true, loginMax: 2 } });
  try {
    const statuses = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `ana${i}@x.com`, password: 'abcd1234' },
      });
      statuses.push(last.statusCode);
    }
    assert.deepEqual(statuses, [401, 401, 429]);
    assert.equal(last.json().error.code, 'RATE_LIMITED');
  } finally {
    await app.close();
  }
});
