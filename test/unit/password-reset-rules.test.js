// AF-03 (design 2, 4.2 e 6.1, critérios 5, 15, 17 e 36): regras e textos da recuperação de senha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from '../../src/shared/validation.js';
import {
  PASSWORD_RESET_MESSAGES as M,
  PASSWORD_RESET_TOKEN_BYTES,
  PASSWORD_RESET_TOKEN_RE,
  PASSWORD_RESET_TTL_MS,
  validatePasswordResetRequest,
  validatePasswordReset,
} from '../../src/shared/password-reset.js';
import { loadConfig, mergeConfig } from '../../src/config.js';
import { EMAIL_ACCOUNT_RECIPIENT_MAX, EMAIL_RECIPIENT_MAX, PASSWORD_RESET_SEND_MAX_AGE_MS, EMAIL_RETRY_DELAYS_MS, EMAIL_RETRY_JITTER, EMAIL_SKIP_CODES, EMAIL_KINDS } from '../../src/modules/email/email-rules.js';
import { newResetToken, hashResetToken, resetUrlOf } from '../../src/modules/auth/password-reset-token.js';
import { stripComments } from '../helpers/time-scan.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('textos exatos do critério 36, congelados, sem função; emailInvalid é o do AF-01', () => {
  assert.ok(Object.isFrozen(M));
  assert.deepEqual(
    { ...M },
    {
      requestTitle: 'Redefinir senha',
      emailLabel: 'E-mail',
      submitRequest: 'Enviar link',
      requested: 'Se este e-mail estiver cadastrado, enviaremos um link para redefinir a senha. O link vale por 1 hora.',
      emailInvalid: 'Informe um e-mail válido.',
      linkInvalid: 'Link inválido ou expirado. Peça um novo link.',
      requestNewLink: 'Pedir um novo link',
      resetTitle: 'Criar nova senha',
      passwordLabel: 'Nova senha',
      confirmationLabel: 'Confirme a nova senha',
      submitReset: 'Salvar nova senha',
      passwordMismatch: 'As senhas não coincidem.',
      changed: 'Senha alterada. Entre com a nova senha.',
      tooMany: 'Muitas tentativas. Tente novamente mais tarde.',
      forgotLink: 'Esqueci minha senha',
      genericError: 'Não foi possível concluir agora. Tente novamente.',
    },
  );
  assert.equal(M.emailInvalid, MESSAGES.emailInvalid);
  assert.ok(Object.values(M).every((v) => typeof v === 'string'));
});

test('validatePasswordResetRequest: qualquer erro de e-mail vira emailInvalid; normaliza como o AF-01', () => {
  for (const input of [undefined, null, {}, { email: '' }, { email: '   ' }, { email: 42 }, { email: 'a@' }, { email: 'a b@x.com' }, { email: ['a@x.com'] }]) {
    assert.deepEqual(validatePasswordResetRequest(input), { ok: false, fields: { email: 'Informe um e-mail válido.' } }, JSON.stringify(input));
  }
  assert.deepEqual(validatePasswordResetRequest({ email: '  ANA@X.COM ' }), { ok: true, value: { email: 'ana@x.com' } });
});

test('validatePasswordReset: política do AF-01 e confirmação só se a chave existir', () => {
  assert.deepEqual(validatePasswordReset({ password: 'abcd1234' }), { ok: true, value: { password: 'abcd1234' } });
  assert.deepEqual(validatePasswordReset({ password: 'abcd1234', passwordConfirmation: 'abcd1234' }), { ok: true, value: { password: 'abcd1234' } });
  for (const password of ['abcdefgh', '12345678', 'abc1234', undefined, 5]) {
    assert.deepEqual(validatePasswordReset({ password }).fields, { password: MESSAGES.passwordRequirement }, String(password));
  }
  assert.deepEqual(validatePasswordReset({ password: `a1${'x'.repeat(71)}` }).fields, { password: MESSAGES.passwordTooLong });
  assert.deepEqual(validatePasswordReset({ password: 'abcd1234', passwordConfirmation: 'abcd12345' }).fields, { passwordConfirmation: M.passwordMismatch });
  assert.deepEqual(validatePasswordReset({ password: 'abcd1234', passwordConfirmation: undefined }).fields, { passwordConfirmation: M.passwordMismatch });
});

test('a mesma validatePassword do cadastro: import de ./validation.js, sem regex de política fora dela (critério 15)', async () => {
  const shared = await readFile(join(ROOT, 'src/shared/password-reset.js'), 'utf8');
  assert.match(shared, /^import \{[^}]*\bvalidatePassword\b[^}]*\} from '\.\/validation\.js';$/m);
  assert.doesNotMatch(shared, /function validatePassword\b/);
  for (const [file, re] of [
    ['web/js/reset-password-controller.js', /from '\/shared\/password-reset\.js'/],
    ['web/js/signup-controller.js', /from '\/shared\/validation\.js'/],
  ]) {
    assert.match(await readFile(join(ROOT, file), 'utf8'), re, file);
  }
  // Nenhum outro arquivo de web/ ou src/ repete a regra (mínimo 8, letra e número) nem a mensagem.
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js') && path !== 'src/shared/validation.js') {
        const code = stripComments(await readFile(join(ROOT, path), 'utf8'));
        if (/PASSWORD_MIN\s*=|\\p\{L\}\/u\.test\(raw\)|A senha deve ter no mínimo/.test(code)) offenders.push(path);
      }
    }
  }
  await walk('src');
  await walk('web');
  assert.deepEqual(offenders, []);
});

test('token: 32 bytes de base64url (43 caracteres), hash SHA-256 hex; link com o token no fragmento', () => {
  assert.equal(PASSWORD_RESET_TOKEN_BYTES, 32);
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const { token, tokenHash } = newResetToken();
    assert.match(token, PASSWORD_RESET_TOKEN_RE);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.match(tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(hashResetToken(token), tokenHash);
    seen.add(token);
  }
  assert.equal(seen.size, 50);
  const fixed = newResetToken(() => Buffer.alloc(32, 7));
  assert.equal(fixed.token, Buffer.alloc(32, 7).toString('base64url'));
  assert.equal(resetUrlOf('https://a.app/', 'T'), 'https://a.app/redefinir-senha#token=T');
  assert.equal(PASSWORD_RESET_TTL_MS, 3_600_000);
});

test('regras fixas da fila de conta (decisão 5 do Gerente)', () => {
  assert.equal(EMAIL_ACCOUNT_RECIPIENT_MAX, 5);
  assert.equal(EMAIL_RECIPIENT_MAX, 10);
  // 4 h cobre o 1º envio e as 4 retentativas com o jitter máximo.
  const worst = EMAIL_RETRY_DELAYS_MS.reduce((a, d) => a + d * (1 + EMAIL_RETRY_JITTER), 0);
  assert.ok(PASSWORD_RESET_SEND_MAX_AGE_MS > worst);
  assert.equal(PASSWORD_RESET_SEND_MAX_AGE_MS, 4 * 3_600_000);
  for (const code of ['superseded', 'stale']) assert.ok(EMAIL_SKIP_CODES.includes(code));
  for (const kind of ['password_reset', 'password_changed']) assert.ok(EMAIL_KINDS.includes(kind));
});

test('config passwordReset: padrões, sempre ativa (sem variável de ambiente) e merge raso por balde', () => {
  const c = loadConfig({ RATE_LIMIT_ENABLED: 'false' });
  assert.deepEqual(c.passwordReset, {
    requestPerEmail: [
      { max: 3, windowMinutes: 60 },
      { max: 5, windowMinutes: 1440 },
    ],
    requestPerIp: { max: 10, windowMinutes: 60 },
    confirmPerIp: { max: 10, windowMinutes: 15 },
  });
  const merged = mergeConfig(c, { passwordReset: { requestPerIp: { max: 2, windowMinutes: 5 } } });
  assert.deepEqual(merged.passwordReset.requestPerIp, { max: 2, windowMinutes: 5 });
  assert.deepEqual(merged.passwordReset.requestPerEmail, [
    { max: 3, windowMinutes: 60 },
    { max: 5, windowMinutes: 1440 },
  ]);
  assert.ok(Object.isFrozen(merged.passwordReset));
});
