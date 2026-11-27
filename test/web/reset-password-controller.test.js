// AF-03 (design 4.4, critérios 12, 13, 15, 17 e 36): controlador da tela de redefinição, sem DOM.
import '../helpers/web-resolver.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { submitResetPassword, readResetToken } = await import('../../web/js/reset-password-controller.js');
const { PASSWORD_RESET_MESSAGES: M } = await import('../../src/shared/password-reset.js');
const { MESSAGES } = await import('../../src/shared/validation.js');

const TOKEN = 'A'.repeat(21) + '-_' + 'z9'.repeat(10);

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

test('readResetToken: #token=<43> ok; vazio, 42, 44, %, outra chave e não-string -> null', () => {
  assert.equal(TOKEN.length, 43);
  assert.equal(readResetToken(`#token=${TOKEN}`), TOKEN);
  for (const hash of ['', '#', '#token=', `#token=${TOKEN.slice(1)}`, `#token=${TOKEN}A`, `#token=${TOKEN.slice(2)}%41`, `#t=${TOKEN}`, `token=${TOKEN}`, `#token=${TOKEN}&x=1`, null, 42]) {
    assert.equal(readResetToken(hash), null, String(hash));
  }
});

test('200: navigate("/login?senha-alterada=1"); token só no corpo do POST (critério 13)', async () => {
  const fetchFn = fakeFetch(200, { message: M.changed, redirectTo: '/login?senha-alterada=1' });
  const navigated = [];
  const result = await submitResetPassword({ token: TOKEN, password: 'abcd1234', passwordConfirmation: 'abcd1234' }, { fetchFn, navigate: (u) => navigated.push(u) });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(navigated, ['/login?senha-alterada=1']);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, '/api/auth/password-reset/confirm');
  assert.equal(url.includes(TOKEN), false);
  assert.deepEqual(JSON.parse(init.body), { token: TOKEN, password: 'abcd1234', passwordConfirmation: 'abcd1234' });
});

test('redirectTo diferente do esperado é ignorado (sem redirecionamento aberto)', async () => {
  const navigated = [];
  await submitResetPassword({ token: TOKEN, password: 'abcd1234', passwordConfirmation: 'abcd1234' }, {
    fetchFn: fakeFetch(200, { redirectTo: 'https://evil.example' }),
    navigate: (u) => navigated.push(u),
  });
  assert.deepEqual(navigated, ['/login?senha-alterada=1']);
});

test('PASSWORD_RESET_LINK_INVALID -> estado de link inválido; sem token também (critério 12)', async () => {
  const body = { error: { code: 'PASSWORD_RESET_LINK_INVALID', message: M.linkInvalid } };
  assert.deepEqual(await submitResetPassword({ token: TOKEN, password: 'abcd1234', passwordConfirmation: 'abcd1234' }, { fetchFn: fakeFetch(400, body), navigate() {} }), {
    ok: false,
    linkInvalid: true,
  });
  const fetchFn = fakeFetch(200, {});
  assert.deepEqual(await submitResetPassword({ token: null, password: 'abcd1234', passwordConfirmation: 'abcd1234' }, { fetchFn, navigate() {} }), { ok: false, linkInvalid: true });
  assert.equal(fetchFn.calls.length, 0);
});

test('senha fraca ou confirmação diferente não chamam fetchFn (critérios 15 e 17)', async () => {
  for (const [values, fields] of [
    [{ password: 'abcdefgh', passwordConfirmation: 'abcdefgh' }, { password: MESSAGES.passwordRequirement }],
    [{ password: '12345678', passwordConfirmation: '12345678' }, { password: MESSAGES.passwordRequirement }],
    [{ password: 'abc1234', passwordConfirmation: 'abc1234' }, { password: MESSAGES.passwordRequirement }],
    [{ password: 'abcd1234', passwordConfirmation: 'abcd12345' }, { passwordConfirmation: 'As senhas não coincidem.' }],
  ]) {
    const fetchFn = fakeFetch(200, {});
    const result = await submitResetPassword({ token: TOKEN, ...values }, { fetchFn, navigate() {} });
    assert.deepEqual(result, { ok: false, fields, message: '' });
    assert.equal(fetchFn.calls.length, 0);
  }
});

test('400 VALIDATION_ERROR do servidor: só os campos conhecidos; 429: tooMany; rede: genérica', async () => {
  const body = { error: { code: 'VALIDATION_ERROR', message: 'x', fields: { password: MESSAGES.passwordTooLong, outro: '<b>' } } };
  const values = { token: TOKEN, password: 'abcd1234', passwordConfirmation: 'abcd1234' };
  assert.deepEqual(await submitResetPassword(values, { fetchFn: fakeFetch(400, body), navigate() {} }), {
    ok: false,
    fields: { password: MESSAGES.passwordTooLong },
    message: '',
  });
  assert.deepEqual(await submitResetPassword(values, { fetchFn: fakeFetch(429, { error: { code: 'RATE_LIMITED', message: 'x' } }), navigate() {} }), {
    ok: false,
    fields: {},
    message: M.tooMany,
  });
  assert.deepEqual(await submitResetPassword(values, { fetchFn: fakeFetch(0, null, { reject: true }), navigate() {} }), {
    ok: false,
    fields: {},
    message: M.genericError,
  });
});
