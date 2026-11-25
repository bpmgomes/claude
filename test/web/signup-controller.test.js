import '../helpers/web-resolver.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { submitSignup } = await import('../../web/js/signup-controller.js');

const VALID = { name: 'Ana', email: 'ana@x.com', password: 'abcd1234' };

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

test('201 chama navigate("/onboarding") (critério 3)', async () => {
  const fetchFn = fakeFetch(201, { user: { id: '1' }, redirectTo: '/onboarding' });
  const navigated = [];
  const result = await submitSignup(VALID, { fetchFn, navigate: (u) => navigated.push(u) });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(navigated, ['/onboarding']);
  assert.equal(fetchFn.calls.length, 1);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, '/api/accounts');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), VALID);
});

test('409 devolve fields.email do servidor', async () => {
  const msg = 'Este e-mail já está cadastrado.';
  const fetchFn = fakeFetch(409, { error: { code: 'EMAIL_TAKEN', message: msg, fields: { email: msg } } });
  let navigated = false;
  const result = await submitSignup(VALID, { fetchFn, navigate: () => (navigated = true) });
  assert.equal(result.ok, false);
  assert.equal(result.fields.email, msg);
  assert.equal(navigated, false);
});

test('400 devolve fields do servidor', async () => {
  const fetchFn = fakeFetch(400, {
    error: { code: 'VALIDATION_ERROR', message: 'Verifique os campos destacados.', fields: { name: 'x' } },
  });
  const result = await submitSignup(VALID, { fetchFn, navigate: () => {} });
  assert.deepEqual(result.fields, { name: 'x' });
});

test('senha inválida não chama fetchFn (validação complementar, critério 10)', async () => {
  const fetchFn = fakeFetch(201, {});
  const result = await submitSignup({ ...VALID, password: 'abc1234' }, { fetchFn, navigate: () => {} });
  assert.equal(result.ok, false);
  assert.equal(
    result.fields.password,
    'A senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.',
  );
  assert.equal(fetchFn.calls.length, 0);
});

test('erro de rede e 5xx devolvem mensagem genérica', async () => {
  const failing = async () => {
    throw new TypeError('Failed to fetch');
  };
  const r1 = await submitSignup(VALID, { fetchFn: failing, navigate: () => {} });
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.fields, {});
  assert.ok(r1.message.length > 0);

  const r2 = await submitSignup(VALID, {
    fetchFn: fakeFetch(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } }),
    navigate: () => {},
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.message, r1.message);

  const r3 = await submitSignup(VALID, { fetchFn: fakeFetch(502), navigate: () => {} });
  assert.equal(r3.message, r1.message);
});
