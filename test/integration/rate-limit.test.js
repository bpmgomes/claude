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

// ---------------------------------------------------------------------------
// AF-05 (critério 22): limite por usuário autenticado além do limite por IP.
// ---------------------------------------------------------------------------

const { signupAndLogin } = await import('../helpers/session.js');
const { pngOf } = await import('../helpers/images.js');

function businessLimits({ businessWrite, logoUpload } = {}) {
  return {
    enabled: true,
    signupMax: 100,
    businessWrite: businessWrite || { perUser: 100, perIp: 100 },
    logoUpload: logoUpload || { perUser: 100, perIp: 100 },
  };
}

function checkSlug(app, cookies, remoteAddress = '127.0.0.1') {
  return app.inject({ method: 'GET', url: '/api/business/slug-availability?slug=salao', cookies, remoteAddress });
}

test('businessWrite.perUser 2: a 3ª checagem do mesmo usuário dá 429, outro usuário do mesmo IP passa', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ businessWrite: { perUser: 2, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app, { email: 'ana@x.com' });
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await checkSlug(app, ana)).statusCode);
    assert.deepEqual(statuses, [200, 200, 429]);
    const last = await checkSlug(app, ana);
    assert.equal(last.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(last.headers['retry-after']) >= 1);
    assert.equal((await checkSlug(app, bia)).statusCode, 200);

    // O bucket é compartilhado pelas escritas do negócio: POST do mesmo usuário também é barrado.
    const post = await app.inject({
      method: 'POST',
      url: '/api/business',
      cookies: ana,
      payload: { name: 'Salão', address: 'Rua A', phone: '11912345678' },
    });
    assert.equal(post.statusCode, 429);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM businesses')).n, 0);
  } finally {
    await app.close();
  }
});

test('businessWrite.perIp 2: a 3ª checagem do mesmo IP com usuários diferentes dá 429', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ businessWrite: { perUser: 100, perIp: 2 } }) });
  try {
    const users = [];
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) users.push(await signupAndLogin(app, { email }));
    const statuses = [];
    for (const cookies of users) statuses.push((await checkSlug(app, cookies, '10.0.0.1')).statusCode);
    assert.deepEqual(statuses, [200, 200, 429]);
    // Outro IP não é afetado
    assert.equal((await checkSlug(app, users[0], '10.0.0.2')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('logoUpload.perUser 1: o 2º PUT dá 429 sem ler o corpo', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ logoUpload: { perUser: 1, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app);
    await app.inject({
      method: 'POST',
      url: '/api/business',
      cookies: ana,
      payload: { name: 'Salão', address: 'Rua A', phone: '11912345678' },
    });
    const put = (payload) =>
      app.inject({
        method: 'PUT',
        url: '/api/business/logo',
        cookies: ana,
        headers: { 'content-type': 'application/octet-stream' },
        payload,
      });
    assert.equal((await put(await pngOf(10, 10))).statusCode, 200);
    // Corpo acima de 2 MiB: se fosse lido daria 413; o limite responde antes.
    const second = await put(Buffer.alloc(3 * 1024 * 1024));
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, 'RATE_LIMITED');
  } finally {
    await app.close();
  }
});

test('sem sessão, as rotas do negócio respondem 401 e não consomem o limite do usuário', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ businessWrite: { perUser: 1, perIp: 100 } }) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await checkSlug(app, {})).statusCode, 401);
    const ana = await signupAndLogin(app);
    assert.equal((await checkSlug(app, ana)).statusCode, 200);
  } finally {
    await app.close();
  }
});
