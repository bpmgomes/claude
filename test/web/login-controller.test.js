import '../helpers/web-resolver.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { submitLogin, logout } = await import('../../web/js/login-controller.js');
const { GENERIC_ERROR_MESSAGE } = await import('../../web/js/api.js');

const VALID = { email: 'ana@x.com', password: 'abcd1234' };

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('no body');
        return body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test('200 chama navigate("/onboarding") (critério 2)', async () => {
  const fetchFn = fakeFetch(200, { user: { id: '1' }, redirectTo: '/onboarding' });
  const navigated = [];
  const result = await submitLogin(VALID, { fetchFn, navigate: (u) => navigated.push(u) });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(navigated, ['/onboarding']);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, '/api/auth/login');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), VALID);
});

test('200 sem redirectTo vai para /onboarding', async () => {
  const navigated = [];
  await submitLogin(VALID, { fetchFn: fakeFetch(200, {}), navigate: (u) => navigated.push(u) });
  assert.deepEqual(navigated, ['/onboarding']);
});

test('401 devolve a mensagem genérica do servidor', async () => {
  const message = 'E-mail ou senha inválidos.';
  const fetchFn = fakeFetch(401, { error: { code: 'INVALID_CREDENTIALS', message } });
  let navigated = false;
  const result = await submitLogin(VALID, { fetchFn, navigate: () => (navigated = true) });
  assert.deepEqual(result, { ok: false, fields: {}, message });
  assert.equal(navigated, false);
});

test('429 devolve a mensagem com o tempo restante', async () => {
  const message = 'Muitas tentativas de login. Tente novamente em 15 minutos.';
  const fetchFn = fakeFetch(429, { error: { code: 'LOGIN_LOCKED', message, retryAfterSeconds: 900 } });
  const result = await submitLogin(VALID, { fetchFn, navigate: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.message, message);
});

test('400 devolve fields do servidor', async () => {
  const fetchFn = fakeFetch(400, {
    error: { code: 'VALIDATION_ERROR', message: 'Verifique os campos destacados.', fields: { email: 'x' } },
  });
  const result = await submitLogin(VALID, { fetchFn, navigate: () => {} });
  assert.deepEqual(result.fields, { email: 'x' });
});

test('campos vazios não chamam fetchFn', async () => {
  const fetchFn = fakeFetch(200, {});
  const result = await submitLogin({ email: '', password: '' }, { fetchFn, navigate: () => {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.fields, { email: 'Informe seu e-mail.', password: 'Informe sua senha.' });
  assert.equal(fetchFn.calls.length, 0);
});

test('erro de rede e 5xx devolvem mensagem genérica', async () => {
  const failing = async () => {
    throw new TypeError('Failed to fetch');
  };
  const r1 = await submitLogin(VALID, { fetchFn: failing, navigate: () => {} });
  assert.equal(r1.message, GENERIC_ERROR_MESSAGE);
  const r2 = await submitLogin(VALID, { fetchFn: fakeFetch(500, { error: { code: 'X', message: 'y' } }), navigate: () => {} });
  assert.equal(r2.message, GENERIC_ERROR_MESSAGE);
});

test('logout faz POST sem corpo e navega para /login com 204 (critério 18)', async () => {
  const fetchFn = fakeFetch(204);
  const navigated = [];
  await logout({ fetchFn, navigate: (u) => navigated.push(u) });
  assert.equal(fetchFn.calls.length, 1);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, '/api/auth/logout');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, undefined);
  assert.equal(init.headers['Content-Type'], undefined);
  assert.deepEqual(navigated, ['/login']);
});

test('logout navega para /login mesmo com erro de rede', async () => {
  const navigated = [];
  await logout({
    fetchFn: async () => {
      throw new TypeError('Failed to fetch');
    },
    navigate: (u) => navigated.push(u),
  });
  assert.deepEqual(navigated, ['/login']);
});
