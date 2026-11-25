import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { verifyPassword } from '../../src/modules/auth/password.js';

const PASSWORD = 'abcd1234';
let app;
let logs;

beforeEach(async () => {
  ({ app, logs } = await buildTestApp());
});

afterEach(async () => {
  await app.close();
});

function signup(payload) {
  return app.inject({ method: 'POST', url: '/api/accounts', payload });
}

function sessionCookie(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.find((c) => c && c.startsWith('af_session='));
}

async function countUsers() {
  const { n } = await app.db.get('SELECT COUNT(*) AS n FROM users');
  return n;
}

describe('POST /api/accounts — sucesso', () => {
  test('201 com corpo, redirectTo e Set-Cookie HttpOnly (critérios 1, 3)', async () => {
    const res = await signup({ name: 'Ana Souza', email: 'Ana@Exemplo.com ', password: PASSWORD });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.redirectTo, '/onboarding');
    assert.deepEqual(Object.keys(body.user).sort(), ['createdAt', 'email', 'id', 'name']);
    assert.equal(body.user.name, 'Ana Souza');
    assert.equal(body.user.email, 'ana@exemplo.com');
    assert.match(body.user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const cookie = sessionCookie(res);
    assert.ok(cookie, 'deve setar af_session');
    assert.match(cookie, /^af_session=[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=2592000/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.equal(await countUsers(), 1);
  });

  test('cookie Secure quando cookieSecure ativo', async () => {
    const { app: secureApp } = await buildTestApp({ cookieSecure: true });
    try {
      const res = await secureApp.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Ana', email: 'ana@x.com', password: PASSWORD },
      });
      assert.match(sessionCookie(res), /; Secure/);
    } finally {
      await secureApp.close();
    }
  });

  test('GET /api/me com o cookie devolvido dá 200 e o mesmo usuário (critério 2)', async () => {
    const res = await signup({ name: 'Ana', email: 'ana@x.com', password: PASSWORD });
    const token = sessionCookie(res).split(';')[0].split('=')[1];
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { af_session: token } });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), { user: res.json().user });
  });

  test('banco guarda só o SHA-256 do token de sessão', async () => {
    const res = await signup({ name: 'Ana', email: 'ana@x.com', password: PASSWORD });
    const token = sessionCookie(res).split(';')[0].split('=')[1];
    const row = await app.db.get('SELECT token_hash, user_id FROM sessions');
    assert.notEqual(row.token_hash, token);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.user_id, res.json().user.id);
  });
});

describe('GET /api/me', () => {
  test('sem cookie dá 401 UNAUTHENTICATED', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me' });
    assert.equal(me.statusCode, 401);
    assert.equal(me.json().error.code, 'UNAUTHENTICATED');
  });

  test('cookie desconhecido dá 401', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { af_session: 'nope' } });
    assert.equal(me.statusCode, 401);
  });

  test('sessão expirada ou revogada dá 401', async () => {
    const res = await signup({ name: 'Ana', email: 'ana@x.com', password: PASSWORD });
    const token = sessionCookie(res).split(';')[0].split('=')[1];

    await app.db.run('UPDATE sessions SET expires_at = ?', ['2000-01-01T00:00:00.000Z']);
    let me = await app.inject({ method: 'GET', url: '/api/me', cookies: { af_session: token } });
    assert.equal(me.statusCode, 401);

    await app.db.run('UPDATE sessions SET expires_at = ?, revoked_at = ?', [
      '2999-01-01T00:00:00.000Z',
      new Date().toISOString(),
    ]);
    me = await app.inject({ method: 'GET', url: '/api/me', cookies: { af_session: token } });
    assert.equal(me.statusCode, 401);
  });
});

describe('unicidade de e-mail', () => {
  test('e-mail duplicado dá 409 EMAIL_TAKEN e continua 1 usuário (critério 4)', async () => {
    assert.equal((await signup({ name: 'Ana', email: 'ana@x.com', password: PASSWORD })).statusCode, 201);
    const res = await signup({ name: 'Outra', email: 'ana@x.com', password: 'outra123' });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), {
      error: {
        code: 'EMAIL_TAKEN',
        message: 'Este e-mail já está cadastrado.',
        fields: { email: 'Este e-mail já está cadastrado.' },
      },
    });
    assert.equal(sessionCookie(res), undefined);
    assert.equal(await countUsers(), 1);
  });

  test('"Ana@x.com " depois de "ana@x.com" dá 409 (critério 5)', async () => {
    assert.equal((await signup({ name: 'Ana', email: 'ana@x.com', password: PASSWORD })).statusCode, 201);
    const res = await signup({ name: 'Ana', email: 'Ana@x.com ', password: PASSWORD });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'EMAIL_TAKEN');
    assert.equal(await countUsers(), 1);
  });

  test('duas requisições simultâneas: um 201, um 409, nenhum 500, uma linha (critério 6)', async () => {
    const payload = { name: 'Ana', email: 'corrida@x.com', password: PASSWORD };
    const results = await Promise.all([signup(payload), signup({ ...payload, email: 'Corrida@X.com' })]);
    const statuses = results.map((r) => r.statusCode).sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(await countUsers(), 1);
    const { n } = await app.db.get('SELECT COUNT(*) AS n FROM sessions');
    assert.equal(n, 1);
  });
});

describe('validação (backend é a autoridade)', () => {
  test('400 com fields para cada campo inválido (critérios 7, 8, 13)', async () => {
    const res = await signup({ name: '', email: 'invalido', password: 'abcdefgh' });
    assert.equal(res.statusCode, 400);
    const { error } = res.json();
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.message, 'Verifique os campos destacados.');
    assert.deepEqual(error.fields, {
      name: 'Informe seu nome.',
      email: 'Informe um e-mail válido.',
      password: 'A senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.',
    });
    assert.equal(await countUsers(), 0);
  });

  for (const password of ['abc1234', '12345678', 'abcdefgh']) {
    test(`senha ${password} rejeitada no backend (critério 10)`, async () => {
      const res = await signup({ name: 'Ana', email: 'ana@x.com', password });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(Object.keys(res.json().error.fields), ['password']);
    });
  }

  test('campos ausentes e tipos errados dão 400, não 500', async () => {
    for (const payload of [{}, { name: 1, email: {}, password: [] }, { name: null, email: null, password: null }]) {
      const res = await signup(payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.deepEqual(Object.keys(res.json().error.fields).sort(), ['email', 'name', 'password']);
    }
  });

  test('corpo JSON array/primitivo/malformado dá 400', async () => {
    for (const payload of ['[]', '"x"', '42', '{"name":']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      assert.equal(res.statusCode, 400, payload);
      assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    }
  });

  test('content-type text/plain dá 415 no formato padrão', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { 'content-type': 'text/plain' },
      payload: 'name=Ana',
    });
    assert.equal(res.statusCode, 415);
    assert.equal(typeof res.json().error.code, 'string');
  });

  test('corpo acima de 16 KB dá 413', async () => {
    const res = await signup({ name: 'a'.repeat(17 * 1024), email: 'ana@x.com', password: PASSWORD });
    assert.equal(res.statusCode, 413);
    assert.equal(typeof res.json().error.code, 'string');
  });
});

describe('armazenamento seguro e ausência de vazamento (critérios 11, 12)', () => {
  test('password_hash no banco difere da senha e passa no verifyPassword', async () => {
    await signup({ name: 'Ana', email: 'ana@x.com', password: PASSWORD });
    const row = await app.db.get('SELECT password_hash FROM users');
    assert.notEqual(row.password_hash, PASSWORD);
    assert.ok(row.password_hash.startsWith('$2'));
    assert.equal(await verifyPassword(PASSWORD, row.password_hash), true);
  });

  test('senha e hash não aparecem em respostas 201/400/409 nem nos logs', async () => {
    const secret = 'segredo123XYZ';
    const r201 = await signup({ name: 'Ana', email: 'ana@x.com', password: secret });
    const r409 = await signup({ name: 'Ana', email: 'ana@x.com', password: secret });
    const r400 = await signup({ name: '', email: 'ana@x.com', password: secret });
    const shortSecret = 'zz9';
    const r400b = await signup({ name: 'Ana', email: 'b@x.com', password: shortSecret });
    assert.deepEqual([r201, r409, r400, r400b].map((r) => r.statusCode), [201, 409, 400, 400]);

    const { password_hash: hash } = await app.db.get('SELECT password_hash FROM users');
    const token = sessionCookie(r201).split(';')[0].split('=')[1];
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { af_session: token } });

    for (const r of [r201, r409, r400, r400b, me]) {
      assert.ok(!r.body.includes(secret), 'senha no corpo');
      assert.ok(!r.body.includes(shortSecret), 'senha no corpo');
      assert.ok(!r.body.includes(hash), 'hash no corpo');
      assert.ok(!/password_?hash/i.test(r.body), 'campo de hash no corpo');
    }

    const logText = logs();
    assert.ok(logText.length > 0, 'logs devem ter sido capturados');
    assert.ok(!logText.includes(secret), 'senha nos logs');
    assert.ok(!logText.includes(hash), 'hash nos logs');
    assert.ok(!logText.includes(token), 'token de sessão nos logs');
  });
});

describe('injeção (critério 14)', () => {
  test('payload de SQL injection no nome é salvo literalmente e a tabela continua existindo', async () => {
    const name = "Robert'); DROP TABLE users;--";
    const res = await signup({ name, email: 'bobby@x.com', password: PASSWORD });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().user.name, name);
    const row = await app.db.get('SELECT name FROM users WHERE email = ?', ['bobby@x.com']);
    assert.equal(row.name, name);
    assert.equal(await countUsers(), 1);
  });

  test('SQL injection no e-mail não burla a unicidade', async () => {
    await signup({ name: 'Ana', email: 'ana@x.com', password: PASSWORD });
    const res = await signup({ name: 'Ana', email: "x@x.com' OR '1'='1", password: PASSWORD });
    assert.equal(res.statusCode, 400);
  });

  test('<script> no nome é salvo e devolvido literalmente em JSON', async () => {
    const name = '<script>alert(1)</script>';
    const res = await signup({ name, email: 'xss@x.com', password: PASSWORD });
    assert.equal(res.statusCode, 201);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.json().user.name, name);
  });

  test('respostas têm CSP default-src self', async () => {
    const res = await app.inject({ method: 'GET', url: '/cadastro' });
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'header CSP ausente');
    assert.match(csp, /default-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    const api = await signup({ name: 'Ana', email: 'csp@x.com', password: PASSWORD });
    assert.match(api.headers['content-security-policy'], /default-src 'self'/);
  });
});

describe('páginas estáticas', () => {
  test('GET / redireciona 302 para /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  });

  test('/login, /cadastro e /onboarding servem HTML', async () => {
    for (const url of ['/login', '/cadastro', '/onboarding']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /text\/html/);
    }
    const cad = await app.inject({ method: 'GET', url: '/cadastro' });
    assert.match(cad.body, /autocomplete="new-password"/);
    const login = await app.inject({ method: 'GET', url: '/login' });
    assert.match(login.body, /autocomplete="current-password"/);
  });

  test('/shared/validation.js e /js/*.js são servidos', async () => {
    for (const url of ['/shared/validation.js', '/js/signup-controller.js', '/css/app.css']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
    }
  });

  test('rota desconhecida dá 404 no formato padrão', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nao-existe' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });
});

describe('content-types de formulário cross-site', () => {
  for (const ct of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    test(`${ct} dá 415`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { 'content-type': ct },
        payload: 'name=Ana',
      });
      assert.equal(res.statusCode, 415);
      assert.equal(await countUsers(), 0);
    });
  }
});
