// AF-03 (design 4.4, critérios 1, 5, 22, 36 e 41): controlador da tela "Esqueci minha senha", sem DOM.
import '../helpers/web-resolver.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { submitForgotPassword } = await import('../../web/js/forgot-password-controller.js');
const { PASSWORD_RESET_MESSAGES: M } = await import('../../src/shared/password-reset.js');

function fakeFetch(status, body, { reject = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (reject) throw new TypeError('rede');
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('202: a constante `requested`, nunca o corpo do servidor (critérios 1 e 41)', async () => {
  for (const body of [{ message: M.requested }, { message: 'outra coisa' }, null]) {
    const fetchFn = fakeFetch(202, body);
    const result = await submitForgotPassword({ email: ' Ana@X.com ' }, { fetchFn });
    assert.deepEqual(result, { ok: true, message: M.requested });
    const { url, init } = fetchFn.calls[0];
    assert.equal(url, '/api/auth/password-reset');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(init.body), { email: ' Ana@X.com ' });
  }
});

test('e-mail inválido não chama fetchFn e dá "Informe um e-mail válido." (critério 5)', async () => {
  for (const email of ['', 'a@', 'x', undefined]) {
    const fetchFn = fakeFetch(202, {});
    const result = await submitForgotPassword({ email }, { fetchFn });
    assert.deepEqual(result, { ok: false, fields: { email: 'Informe um e-mail válido.' }, message: '' });
    assert.equal(fetchFn.calls.length, 0);
  }
});

test('400 do servidor com fields.email: o campo; 429: tooMany; rede e 5xx: genérica', async () => {
  const fields = { error: { code: 'VALIDATION_ERROR', message: 'x', fields: { email: 'qualquer' } } };
  assert.deepEqual(await submitForgotPassword({ email: 'a@x.com' }, { fetchFn: fakeFetch(400, fields) }), {
    ok: false,
    fields: { email: M.emailInvalid },
    message: '',
  });
  const limited = { error: { code: 'RATE_LIMITED', message: 'Muitas tentativas. Tente novamente mais tarde.' } };
  assert.deepEqual(await submitForgotPassword({ email: 'a@x.com' }, { fetchFn: fakeFetch(429, limited) }), { ok: false, fields: {}, message: M.tooMany });
  for (const fetchFn of [fakeFetch(0, null, { reject: true }), fakeFetch(500, null), fakeFetch(403, { error: { code: 'FORBIDDEN_ORIGIN', message: 'x' } })]) {
    assert.deepEqual(await submitForgotPassword({ email: 'a@x.com' }, { fetchFn }), { ok: false, fields: {}, message: M.genericError });
  }
});
