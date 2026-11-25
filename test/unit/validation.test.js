import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail,
  validateName,
  validateEmail,
  validatePassword,
  validateSignup,
  MESSAGES,
} from '../../src/shared/validation.js';

const REQ = 'A senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.';

describe('validatePassword', () => {
  test('aceita abcd1234 (critério 9)', () => {
    assert.equal(validatePassword('abcd1234'), null);
  });

  test('aceita letras acentuadas e espaços (sem trim)', () => {
    assert.equal(validatePassword('ação 1234'), null);
    assert.equal(validatePassword('  abc123  '), null);
  });

  for (const pw of ['abcdefgh', '12345678', 'abc1234', '', 'a1']) {
    test(`rejeita ${JSON.stringify(pw)} com a mensagem do requisito (critérios 7, 8, 9)`, () => {
      assert.equal(validatePassword(pw), REQ);
    });
  }

  test('rejeita senha com mais de 72 bytes UTF-8', () => {
    const pw73 = 'a1' + 'x'.repeat(71);
    assert.equal(new TextEncoder().encode(pw73).length, 73);
    assert.equal(validatePassword(pw73), 'A senha deve ter no máximo 72 caracteres.');
    const pw72 = 'a1' + 'x'.repeat(70);
    assert.equal(validatePassword(pw72), null);
  });

  test('limite é em bytes, não caracteres (acentos ocupam 2 bytes)', () => {
    const pw = '1' + 'á'.repeat(36); // 37 caracteres, 73 bytes
    assert.equal(validatePassword(pw), 'A senha deve ter no máximo 72 caracteres.');
  });
});

describe('validateName', () => {
  test('aceita nome válido', () => {
    assert.equal(validateName('Ana Souza'), null);
  });
  test('rejeita vazio e só espaços (critério 13)', () => {
    assert.equal(validateName(''), MESSAGES.nameRequired);
    assert.equal(validateName('    '), MESSAGES.nameRequired);
  });
  test('rejeita nome com 101 caracteres; aceita 100', () => {
    assert.equal(validateName('a'.repeat(101)), 'O nome deve ter no máximo 100 caracteres.');
    assert.equal(validateName('a'.repeat(100)), null);
  });
  test('rejeita caracteres de controle', () => {
    assert.equal(validateName('Ana\u0000'), 'O nome contém caracteres inválidos.');
    assert.equal(validateName('Ana\nSouza'), 'O nome contém caracteres inválidos.');
    assert.equal(validateName('Ana\u007F'), 'O nome contém caracteres inválidos.');
  });
});

describe('validateEmail / normalizeEmail', () => {
  test('normalizeEmail faz trim + lowercase (critério 5)', () => {
    assert.equal(normalizeEmail(' Ana@X.com '), 'ana@x.com');
  });
  test('rejeita vazio (critério 13)', () => {
    assert.equal(validateEmail(''), 'Informe seu e-mail.');
    assert.equal(validateEmail('   '), 'Informe seu e-mail.');
  });
  for (const email of ['ana', 'ana@', 'ana@x', '@x.com', 'a na@x.com', 'ana@@x.com']) {
    test(`rejeita ${JSON.stringify(email)}`, () => {
      assert.equal(validateEmail(email), 'Informe um e-mail válido.');
    });
  }
  test('rejeita e-mail com mais de 254 caracteres', () => {
    const email = 'a'.repeat(250) + '@x.com';
    assert.equal(validateEmail(email), 'Informe um e-mail válido.');
  });
  test('aceita e-mail com espaços nas pontas e maiúsculas', () => {
    assert.equal(validateEmail(' Ana@Exemplo.com '), null);
  });
});

describe('validateSignup', () => {
  test('ok devolve valores normalizados', () => {
    const r = validateSignup({ name: '  Ana  ', email: ' Ana@X.com ', password: 'abcd1234' });
    assert.deepEqual(r, { ok: true, value: { name: 'Ana', email: 'ana@x.com', password: 'abcd1234' } });
  });

  test('devolve todos os campos inválidos de uma vez', () => {
    const r = validateSignup({ name: '', email: 'x', password: 'abc' });
    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys(r.fields).sort(), ['email', 'name', 'password']);
  });

  test('tipos não-string nunca lançam exceção', () => {
    const weird = [null, undefined, 42, true, [], {}, () => {}, { toString: () => 'x' }];
    for (const v of weird) {
      assert.doesNotThrow(() => normalizeEmail(v));
      assert.doesNotThrow(() => validateName(v));
      assert.doesNotThrow(() => validateEmail(v));
      assert.doesNotThrow(() => validatePassword(v));
      assert.doesNotThrow(() => validateSignup({ name: v, email: v, password: v }));
      assert.doesNotThrow(() => validateSignup(v));
      assert.equal(validateSignup({ name: v, email: v, password: v }).ok, false);
    }
    assert.equal(normalizeEmail(42), '');
    assert.equal(validatePassword(12345678), REQ);
  });
});
