import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';

const PASSWORD = 'abcd1234';
const EMAIL = 'ana@x.com';
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const GENERIC = 'E-mail ou senha inválidos.';

let app;
let logs;
let clock;

beforeEach(async () => {
  clock = createClock();
  ({ app, logs } = await buildTestApp({ now: clock.now }));
});

afterEach(async () => {
  await app.close();
});

function cookieFrom(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.find((c) => c && c.startsWith('af_session='));
}

function tokenFrom(res) {
  return cookieFrom(res).split(';')[0].split('=')[1];
}

function signup(payload = { name: 'Ana', email: EMAIL, password: PASSWORD }, extra = {}) {
  return app.inject({ method: 'POST', url: '/api/accounts', payload, ...extra });
}

function login(payload = { email: EMAIL, password: PASSWORD }, headers = {}, extra = {}) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload, headers, ...extra });
}

function logout(token, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers,
    ...(token !== undefined ? { cookies: { af_session: token } } : {}),
  });
}

function me(token) {
  return app.inject({ method: 'GET', url: '/api/me', cookies: { af_session: token } });
}

describe('login', () => {
  test('200 com user, redirectTo e cookie HttpOnly, SameSite=Lax, Max-Age=2592000 (critérios 1, 2)', async () => {
    const created = await signup();
    const res = await login();
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.redirectTo, '/onboarding');
    assert.deepEqual(body.user, created.json().user);
    const cookie = cookieFrom(res);
    assert.match(cookie, /^af_session=[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=2592000/);
    assert.doesNotMatch(cookie, /Secure/);

    const meRes = await me(tokenFrom(res));
    assert.equal(meRes.statusCode, 200);
    assert.deepEqual(meRes.json(), { user: body.user });
  });

  test('com cookieSecure: true o cookie tem ; Secure (critério 1)', async () => {
    const { app: secureApp } = await buildTestApp({ cookieSecure: true });
    try {
      await secureApp.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Ana', email: EMAIL, password: PASSWORD },
      });
      const res = await secureApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: EMAIL, password: PASSWORD },
      });
      assert.equal(res.statusCode, 200);
      assert.match(cookieFrom(res), /; Secure/);
    } finally {
      await secureApp.close();
    }
  });

  test('e-mail com maiúsculas e espaços nas pontas loga (critério 3)', async () => {
    await signup();
    const res = await login({ email: ' ANA@X.com ', password: PASSWORD });
    assert.equal(res.statusCode, 200);
  });

  test('cookie inventado antes do login continua 401 depois do login (critério 4)', async () => {
    await signup();
    const forged = 'A'.repeat(43);
    const res = await login(undefined, {}, { cookies: { af_session: forged } });
    assert.equal(res.statusCode, 200);
    assert.notEqual(tokenFrom(res), forged);
    assert.equal((await me(forged)).statusCode, 401);
  });

  test('o token do login é diferente do token do cadastro (critério 4)', async () => {
    const created = await signup();
    const res = await login();
    assert.notEqual(tokenFrom(res), tokenFrom(created));
  });
});

describe('erro genérico', () => {
  test('e-mail inexistente e senha errada dão 401 com corpos idênticos (critério 5)', async () => {
    await signup();
    const wrong = await login({ email: EMAIL, password: 'errada123' });
    const missing = await login({ email: 'nao-existe@x.com', password: 'errada123' });
    assert.equal(wrong.statusCode, 401);
    assert.equal(missing.statusCode, 401);
    assert.deepEqual(wrong.json(), missing.json());
    assert.deepEqual(wrong.json(), { error: { code: 'INVALID_CREDENTIALS', message: GENERIC } });
    assert.equal(cookieFrom(wrong), undefined);
  });

  test('senha, passwordHash e e-mail não aparecem em corpos nem em logs (critério 7)', async () => {
    const secret = 'segredo123XYZ';
    const email = 'privado@x.com';
    await signup({ name: 'Ana', email, password: secret });
    const { password_hash: hash } = await app.db.get('SELECT password_hash FROM users');
    const responses = [
      await login({ email, password: secret }),
      await login({ email, password: `${secret}x` }),
      await login({ email: 'outro@x.com', password: secret }),
      await login({ email, password: '' }),
    ];
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [200, 401, 401, 400],
    );
    for (const r of responses.slice(1)) {
      assert.ok(!r.body.includes(email), 'e-mail no corpo');
    }
    for (const r of responses) {
      assert.ok(!r.body.includes(secret), 'senha no corpo');
      assert.ok(!r.body.includes(hash), 'hash no corpo');
      assert.ok(!/password_?hash/i.test(r.body), 'campo de hash no corpo');
    }
    const logText = logs();
    assert.ok(logText.includes('login_failed'));
    assert.ok(logText.includes('login_succeeded'));
    assert.ok(!logText.includes(secret), 'senha nos logs');
    assert.ok(!logText.includes(hash), 'hash nos logs');
    assert.ok(!logText.includes(email), 'e-mail nos logs');
    assert.ok(!logText.includes(tokenFrom(responses[0])), 'token nos logs');
  });

  test('corpo sem e-mail ou sem senha dá 400 com fields (critério 8)', async () => {
    const noEmail = await login({ password: PASSWORD });
    assert.equal(noEmail.statusCode, 400);
    assert.equal(noEmail.json().error.code, 'VALIDATION_ERROR');
    assert.deepEqual(noEmail.json().error.fields, { email: 'Informe seu e-mail.' });

    const noPassword = await login({ email: EMAIL });
    assert.equal(noPassword.statusCode, 400);
    assert.deepEqual(noPassword.json().error.fields, { password: 'Informe sua senha.' });

    const { n } = await app.db.get('SELECT COUNT(*) AS n FROM login_attempts');
    assert.equal(n, 0, 'erro de validação não conta tentativa');
  });

  test('content-type diferente de JSON dá 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a',
    });
    assert.equal(res.statusCode, 415);
  });
});

describe('bloqueio por tentativas', () => {
  async function failTimes(n, email = EMAIL, headers = {}) {
    const statuses = [];
    for (let i = 0; i < n; i++) statuses.push((await login({ email, password: 'errada' }, headers)).statusCode);
    return statuses;
  }

  test('5 erradas dão 401 e a 6ª com a senha certa dá 429 LOGIN_LOCKED (critério 9)', async () => {
    await signup();
    assert.deepEqual(await failTimes(5), [401, 401, 401, 401, 401]);
    const res = await login();
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '900');
    assert.deepEqual(res.json(), {
      error: {
        code: 'LOGIN_LOCKED',
        message: 'Muitas tentativas de login. Tente novamente em 15 minutos.',
        retryAfterSeconds: 900,
      },
    });
    assert.equal(cookieFrom(res), undefined);
  });

  test('tempo restante diminui e usa "1 minuto" no singular', async () => {
    await signup();
    await failTimes(5);
    clock.advance(14 * MINUTE + 30 * 1000);
    const res = await login();
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '30');
    assert.equal(res.json().error.message, 'Muitas tentativas de login. Tente novamente em 1 minuto.');
  });

  test('e-mail inexistente dá o mesmo 429 com corpo igual (critério 12)', async () => {
    await signup();
    await failTimes(5);
    await failTimes(5, 'fantasma@x.com');
    const real = await login();
    const ghost = await login({ email: 'fantasma@x.com', password: PASSWORD });
    assert.equal(ghost.statusCode, 429);
    assert.deepEqual(ghost.json(), real.json());
    assert.equal(ghost.headers['retry-after'], real.headers['retry-after']);
  });

  test('depois de 15 minutos a senha certa dá 200 (critério 10)', async () => {
    await signup();
    await failTimes(5);
    clock.advance(15 * MINUTE);
    assert.equal((await login()).statusCode, 200);
  });

  test('4 erradas, 1 certa e mais 4 erradas não bloqueiam (critério 11)', async () => {
    await signup();
    assert.deepEqual(await failTimes(4), [401, 401, 401, 401]);
    assert.equal((await login()).statusCode, 200);
    assert.deepEqual(await failTimes(4), [401, 401, 401, 401]);
    assert.equal((await login()).statusCode, 200);
  });

  test('10 tentativas erradas simultâneas dão exatamente cinco 401 e cinco 429 (critério 14)', async () => {
    await signup();
    const results = await Promise.all(Array.from({ length: 10 }, () => login({ email: EMAIL, password: 'errada' })));
    const statuses = results.map((r) => r.statusCode).sort();
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
  });

  test('com trustProxy: true, X-Forwarded-For separa os contadores (critério 22)', async () => {
    const { app: proxied } = await buildTestApp({ trustProxy: true });
    try {
      const attempt = (ip, password) =>
        proxied.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': ip },
          payload: { email: EMAIL, password },
        });
      await proxied.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Ana', email: EMAIL, password: PASSWORD },
      });
      for (let i = 0; i < 5; i++) assert.equal((await attempt('1.1.1.1', 'errada')).statusCode, 401);
      assert.equal((await attempt('1.1.1.1', PASSWORD)).statusCode, 429);
      assert.equal((await attempt('2.2.2.2', PASSWORD)).statusCode, 200);
    } finally {
      await proxied.close();
    }
  });

  test('com trustProxy: false, X-Forwarded-For é ignorado e o contador é compartilhado (critério 22)', async () => {
    await signup();
    assert.deepEqual(await failTimes(5, EMAIL, { 'x-forwarded-for': '1.1.1.1' }), [401, 401, 401, 401, 401]);
    const res = await login(undefined, { 'x-forwarded-for': '2.2.2.2' });
    assert.equal(res.statusCode, 429);
  });
});

describe('expiração de sessão', () => {
  test('uso dentro de 7 dias renova o prazo (critérios 15, 16)', async () => {
    const token = tokenFrom(await signup());
    clock.advance(6 * DAY);
    assert.equal((await me(token)).statusCode, 200);
    clock.advance(6 * DAY);
    assert.equal((await me(token)).statusCode, 200);
  });

  test('7 dias e 1 s sem uso dá 401 (critério 15)', async () => {
    const token = tokenFrom(await signup());
    clock.advance(7 * DAY + 1000);
    assert.equal((await me(token)).statusCode, 401);
  });

  test('com uso a cada 6 dias, depois de 30 dias da criação dá 401 (teto absoluto)', async () => {
    const token = tokenFrom(await signup());
    for (let i = 0; i < 4; i++) {
      clock.advance(6 * DAY);
      assert.equal((await me(token)).statusCode, 200, `dia ${(i + 1) * 6}`);
    }
    clock.advance(6 * DAY); // dia 30
    assert.equal((await me(token)).statusCode, 401);
  });

  test('requisições dentro de 60 s não gravam no banco', async () => {
    const token = tokenFrom(await signup());
    const before = await app.db.get('SELECT last_seen_at FROM sessions');
    clock.advance(30 * 1000);
    await me(token);
    assert.deepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
    clock.advance(30 * 1000);
    await me(token);
    assert.notDeepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
  });
});

describe('logout', () => {
  test('204, cookie com Max-Age=0 e o mesmo cookie depois dá 401 (critérios 17, 18)', async () => {
    const token = tokenFrom(await signup());
    const res = await logout(token);
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, '');
    const cookie = cookieFrom(res);
    assert.match(cookie, /^af_session=;/);
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal((await me(token)).statusCode, 401);
    const row = await app.db.get('SELECT revoked_at FROM sessions');
    assert.ok(row.revoked_at);
  });

  test('sem cookie, com cookie inválido, expirado ou repetido dá 204 (critério 18)', async () => {
    assert.equal((await logout()).statusCode, 204);
    assert.equal((await logout('inventado')).statusCode, 204);
    const token = tokenFrom(await signup());
    assert.equal((await logout(token)).statusCode, 204);
    assert.equal((await logout(token)).statusCode, 204);

    const token2 = tokenFrom(await login());
    clock.advance(8 * DAY);
    const res = await logout(token2);
    assert.equal(res.statusCode, 204);
    assert.match(cookieFrom(res), /Max-Age=0/);
  });

  test('logout de uma sessão mantém a outra do mesmo usuário (critério 19)', async () => {
    await signup();
    const a = tokenFrom(await login());
    const b = tokenFrom(await login());
    assert.equal((await logout(a)).statusCode, 204);
    assert.equal((await me(a)).statusCode, 401);
    assert.equal((await me(b)).statusCode, 200);
  });
});

describe('sessão anterior (critério 20)', () => {
  test('login com o cookie de uma sessão ativa revoga a sessão antiga', async () => {
    const old = tokenFrom(await signup());
    const res = await login(undefined, {}, { cookies: { af_session: old } });
    assert.equal(res.statusCode, 200);
    assert.equal((await me(old)).statusCode, 401);
    assert.equal((await me(tokenFrom(res))).statusCode, 200);
  });

  test('login com falha não revoga a sessão atual', async () => {
    const old = tokenFrom(await signup());
    const res = await login({ email: EMAIL, password: 'errada' }, {}, { cookies: { af_session: old } });
    assert.equal(res.statusCode, 401);
    assert.equal((await me(old)).statusCode, 200);
  });

  test('cadastro com cookie de sessão ativa revoga a sessão antiga', async () => {
    const old = tokenFrom(await signup());
    const res = await signup(
      { name: 'Bia', email: 'bia@x.com', password: PASSWORD },
      { cookies: { af_session: old } },
    );
    assert.equal(res.statusCode, 201);
    assert.equal((await me(old)).statusCode, 401);
    assert.equal((await me(tokenFrom(res))).statusCode, 200);
  });
});

describe('CSRF (critério 21)', () => {
  const evil = { origin: 'https://evil.example' };

  test('Origin de outro site dá 403 FORBIDDEN_ORIGIN em login, logout e cadastro', async () => {
    const token = tokenFrom(await signup());
    const responses = [
      await login(undefined, evil),
      await logout(token, evil),
      await signup({ name: 'Bia', email: 'bia@x.com', password: PASSWORD }, { headers: evil }),
    ];
    for (const res of responses) {
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.json(), { error: { code: 'FORBIDDEN_ORIGIN', message: 'Requisição não permitida.' } });
    }
    // nada mudou: sessão continua ativa e não houve cadastro nem tentativa contada
    assert.equal((await me(token)).statusCode, 200);
    const { n } = await app.db.get('SELECT COUNT(*) AS n FROM users');
    assert.equal(n, 1);
    const attempts = await app.db.get('SELECT COUNT(*) AS n FROM login_attempts');
    assert.equal(attempts.n, 0);
  });

  test('Sec-Fetch-Site: cross-site dá 403', async () => {
    await signup();
    const res = await login(undefined, { 'sec-fetch-site': 'cross-site' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'FORBIDDEN_ORIGIN');
  });

  test('Origin: http://localhost (host do inject) e Sec-Fetch-Site: same-origin dão 200', async () => {
    await signup();
    assert.equal((await login(undefined, { origin: 'http://localhost' })).statusCode, 200);
    assert.equal((await login(undefined, { 'sec-fetch-site': 'same-origin' })).statusCode, 200);
  });

  test('GET não passa pela checagem', async () => {
    const token = tokenFrom(await signup());
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: evil,
      cookies: { af_session: token },
    });
    assert.equal(res.statusCode, 200);
  });
});
