import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail,
  validateName,
  validateEmail,
  validatePassword,
  validateSignup,
  validateLogin,
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

  test('normalizeEmail aplica NFC antes das minúsculas (AF-11, decisão 15)', () => {
    const composed = 'JOS\u00C9@x.com';
    const decomposed = 'JOSE\u0301@x.com';
    assert.notEqual(composed, decomposed);
    assert.equal(normalizeEmail(composed), normalizeEmail(decomposed));
    assert.equal(normalizeEmail(decomposed), 'jos\u00e9@x.com');
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

describe('validateLogin', () => {
  test('normaliza o e-mail e mantém a senha como veio (critério 3)', () => {
    assert.deepEqual(validateLogin({ email: ' ANA@X.com ', password: ' abcd1234 ' }), {
      ok: true,
      value: { email: 'ana@x.com', password: ' abcd1234 ' },
    });
  });

  test('aceita "abc" como senha: sem regras de força no login', () => {
    assert.equal(validateLogin({ email: 'ana@x.com', password: 'abc' }).ok, true);
  });

  test('e-mail ausente, só espaços ou inválido (critério 8)', () => {
    assert.equal(validateLogin({ password: 'x' }).fields.email, 'Informe seu e-mail.');
    assert.equal(validateLogin({ email: '   ', password: 'x' }).fields.email, 'Informe seu e-mail.');
    assert.equal(validateLogin({ email: 'ana@', password: 'x' }).fields.email, 'Informe um e-mail válido.');
  });

  test('senha ausente, vazia ou não-string (critério 8)', () => {
    for (const password of [undefined, '', null, 123, [], {}]) {
      const r = validateLogin({ email: 'ana@x.com', password });
      assert.equal(r.ok, false);
      assert.deepEqual(r.fields, { password: 'Informe sua senha.' });
    }
  });

  test('entradas estranhas nunca lançam e devolvem os dois campos', () => {
    for (const v of [null, undefined, 42, 'x', []]) {
      const r = validateLogin(v);
      assert.equal(r.ok, false);
      assert.deepEqual(Object.keys(r.fields).sort(), ['email', 'password']);
    }
  });
});

// ---------------------------------------------------------------------------
// AF-05: regra de texto (\p{Cc}/\p{Cf}) e dados do negócio
// ---------------------------------------------------------------------------

const {
  hasForbiddenChars,
  normalizeText,
  validateBusinessName,
  validateAddress,
  normalizePhone,
  validatePhone,
  formatPhone,
  validateBusinessInput,
  hasBusinessFields,
  LOGO_MAX_BYTES,
} = await import('../../src/shared/validation.js');

const PHONE_INVALID = 'Informe um telefone com DDD, ex.: (11) 91234-5678.';
const VALID_BUSINESS = { name: 'Salão da Ana', address: 'Rua A, 10 - Centro', phone: '(11) 91234-5678' };

describe('hasForbiddenChars (AF-01 item 5, critério 5)', () => {
  for (const ch of ['​', '‍', '‮', '⁦', '﻿', '­', '\n', '\t', '\u0085']) {
    test(`U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} é proibido`, () => {
      assert.equal(hasForbiddenChars(`Ana${ch}Souza`), true);
    });
  }
  test('texto comum, acentos, & e emoji simples são permitidos', () => {
    for (const text of ['Salão da Ana', 'Café & Cia', 'Barbearia 💈', 'Rua São João, 10 - 2º andar']) {
      assert.equal(hasForbiddenChars(text), false, text);
    }
  });
  test('validateName (usuário) passa a rejeitar U+202E', () => {
    assert.equal(validateName('Ana‮anuos'), 'O nome contém caracteres inválidos.');
  });
});

describe('normalizeText', () => {
  test('trim + NFC; não-string vira vazio', () => {
    assert.equal(normalizeText('  Salão '), 'Salão');
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(12), '');
  });
});

describe('nome do negócio e endereço (critérios 3, 5)', () => {
  test('vazio, só espaços e não-string', () => {
    for (const v of ['', '   ', undefined, null, 42, {}]) {
      assert.equal(validateBusinessName(v), 'Informe o nome do negócio.');
      assert.equal(validateAddress(v), 'Informe o endereço.');
    }
  });

  test('nome: 100 code points aceitos, 101 recusados (acentos e emoji contam 1)', () => {
    assert.equal(validateBusinessName('á'.repeat(100)), null);
    // Emoji conta 1 code point; a regra de nome visível (AF-07) exige ao menos uma letra ou número.
    assert.equal(validateBusinessName(`A${'💈'.repeat(99)}`), null);
    assert.equal(validateBusinessName('💈'.repeat(100)), 'O nome contém caracteres inválidos.');
    assert.equal(validateBusinessName('a'.repeat(101)), 'O nome deve ter no máximo 100 caracteres.');
    assert.equal(validateBusinessName('💈'.repeat(101)), 'O nome deve ter no máximo 100 caracteres.');
    // 100 letras com acento combinante viram 100 code points após NFC
    assert.equal(validateBusinessName('á'.repeat(100)), null);
  });

  test('endereço: 200 aceitos, 201 recusados', () => {
    assert.equal(validateAddress('é'.repeat(200)), null);
    assert.equal(validateAddress('a'.repeat(201)), 'O endereço deve ter no máximo 200 caracteres.');
  });

  test('caracteres invisíveis/bidi recusados', () => {
    assert.equal(validateBusinessName('Salão‮'), 'O nome contém caracteres inválidos.');
    assert.equal(validateAddress('Rua​A'), 'O endereço contém caracteres inválidos.');
    assert.equal(validateAddress('Rua A\n10'), 'O endereço contém caracteres inválidos.');
  });
});

describe('telefone (critério 4)', () => {
  for (const [raw, digits] of [
    ['(11) 91234-5678', '11912345678'],
    ['11912345678', '11912345678'],
    ['+55 11 91234-5678', '11912345678'],
    ['(11) 3123-4567', '1131234567'],
    ['11 3123.4567', '1131234567'],
  ]) {
    test(`${raw} é aceito como ${digits}`, () => {
      assert.equal(validatePhone(raw), null);
      assert.equal(normalizePhone(raw), digits);
    });
  }

  for (const raw of [
    '1234-5678',
    '91234-5678',
    '(01) 91234-5678',
    '(11) 81234-5678',
    '(11) 9123-4567',
    '+1 11 91234-5678',
    '11a912345678',
    '119123456789',
    '11 9+1234-5678',
    '(11) 6123-4567',
  ]) {
    test(`${raw} é rejeitado`, () => {
      assert.equal(validatePhone(raw), PHONE_INVALID);
    });
  }

  test('vazio e não-string pedem o telefone', () => {
    for (const v of ['', '   ', undefined, null, 11912345678]) {
      assert.equal(validatePhone(v), 'Informe o telefone.');
    }
    assert.equal(normalizePhone('11a9'), null);
  });

  test('formatPhone', () => {
    assert.equal(formatPhone('11912345678'), '(11) 91234-5678');
    assert.equal(formatPhone('1131234567'), '(11) 3123-4567');
    assert.equal(formatPhone('123'), '123');
    assert.equal(formatPhone(undefined), '');
  });
});

describe('validateBusinessInput', () => {
  test('ok devolve valores normalizados; slug ausente não vem em value', () => {
    const r = validateBusinessInput({ ...VALID_BUSINESS, name: '  Salão da Ana  ' });
    assert.deepEqual(r, {
      ok: true,
      value: { name: 'Salão da Ana', address: 'Rua A, 10 - Centro', phone: '11912345678' },
    });
  });

  test('slug presente é validado e normalizado', () => {
    assert.equal(validateBusinessInput({ ...VALID_BUSINESS, slug: ' Salao-Da-Ana ' }).value.slug, 'salao-da-ana');
    assert.equal(validateBusinessInput({ ...VALID_BUSINESS, slug: '' }).ok, true);
    const reserved = validateBusinessInput({ ...VALID_BUSINESS, slug: 'admin' });
    assert.equal(reserved.fields.slug, 'Este link é reservado. Escolha outro.');
  });

  test('junta os erros de todos os campos (critério 3)', () => {
    const r = validateBusinessInput({ slug: 'a' });
    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys(r.fields).sort(), ['address', 'name', 'phone', 'slug']);
    for (const v of [null, undefined, 'x', 42, []]) {
      assert.deepEqual(Object.keys(validateBusinessInput(v).fields).sort(), ['address', 'name', 'phone']);
    }
  });

  test('partial só valida os campos presentes; null ou "" é erro', () => {
    assert.deepEqual(validateBusinessInput({ phone: '(11) 3123-4567' }, { partial: true }), {
      ok: true,
      value: { phone: '1131234567' },
    });
    assert.deepEqual(validateBusinessInput({}, { partial: true }), { ok: true, value: {} });
    const r = validateBusinessInput({ name: null, slug: '' }, { partial: true });
    assert.deepEqual(Object.keys(r.fields).sort(), ['name', 'slug']);
  });

  test('hasBusinessFields', () => {
    assert.equal(hasBusinessFields({}), false);
    assert.equal(hasBusinessFields({ ownerId: 'x' }), false);
    assert.equal(hasBusinessFields({ slug: 'x' }), true);
    assert.equal(hasBusinessFields(null), false);
  });

  test('LOGO_MAX_BYTES é 2 MiB', () => {
    assert.equal(LOGO_MAX_BYTES, 2_097_152);
  });
});

// ---------------------------------------------------------------------------
// AF-07 (critério 3, AF-06 item 1): regra única de nome visível.
// ---------------------------------------------------------------------------

const { hasVisibleContent, textKey, MAX_MARKS_PER_LETTER } = await import('../../src/shared/validation.js');
const { validateServiceName, serviceNameKey, SERVICE_MESSAGES } = await import('../../src/shared/services.js');

const REJECTED_VISIBLE = [
  ['só marcas', '́́'],
  ['4 marcas seguidas', 'ẫ̄́'],
  ['U+3164 sozinho', 'ㅤ'],
  ['U+3164 no fim', 'Anaㅤ'],
  ['U+115F', 'Anaᅟ'],
  ['U+1160', 'Anaᅠ'],
  ['U+FFA0', 'Anaﾠ'],
  ['U+2800', '⠀'],
  ['reticências', '...'],
  ['hífen', '-'],
];
const ACCEPTED_VISIBLE = [
  ['Ana', 'Ana'],
  ['João NFC', 'João'.normalize('NFC')],
  ['João NFD', 'João'.normalize('NFD')],
  ['Nguyễn (2 marcas)', 'Nguyễn'],
  ['Dra. Ana', 'Dra. Ana'],
  ['Ana 2', 'Ana 2'],
  ['李', '李'],
];

describe('hasVisibleContent e textKey (AF-07, critério 3)', () => {
  for (const [label, text] of REJECTED_VISIBLE) {
    test(`recusa: ${label}`, () => {
      assert.equal(hasVisibleContent(text), false);
      assert.equal(validateBusinessName(text), 'O nome contém caracteres inválidos.');
    });
  }
  for (const [label, text] of ACCEPTED_VISIBLE) {
    test(`aceita: ${label}`, () => {
      assert.equal(hasVisibleContent(text), true);
      assert.equal(validateBusinessName(text), null);
    });
  }

  test('3 marcas por letra é o máximo', () => {
    assert.equal(MAX_MARKS_PER_LETTER, 3);
    assert.equal(hasVisibleContent('ẫ̄'), true);
    assert.equal(hasVisibleContent('ẫ̄́'), false);
  });

  test('não-string é falso', () => {
    for (const v of [undefined, null, 1, {}]) assert.equal(hasVisibleContent(v), false);
  });

  test('textKey: NFC/NFD, caixa, acentos e espaços; serviceNameKey é alias', () => {
    assert.equal(textKey('  CÓRTE   Masculino '), 'corte masculino');
    assert.equal(textKey('João'.normalize('NFD')), textKey('João'.normalize('NFC')));
    assert.equal(textKey(null), '');
    assert.equal(serviceNameKey, textKey);
  });

  test('regra única: negócio, endereço e serviço recusam U+3164 e marca solta', () => {
    for (const text of ['ㅤ', '́']) {
      assert.equal(validateBusinessName(text), 'O nome contém caracteres inválidos.');
      assert.equal(validateAddress(text), 'O endereço contém caracteres inválidos.');
      assert.equal(validateServiceName(text), SERVICE_MESSAGES.nameInvalid);
    }
  });
});

describe('AF-12: antecedência de cancelamento (critérios 1 e 2)', async () => {
  const v = await import('../../src/shared/validation.js');
  const { validateCancellationLead, validateBusinessInput, hasBusinessFields, MESSAGES: MSG } = v;

  test('0, 15, 120 e 4320 aceitos; fora do intervalo, não múltiplo e não inteiro com mensagens fixas', () => {
    assert.equal(v.CANCELLATION_LEAD_DEFAULT_MINUTES, 120);
    for (const ok of [0, 15, 120, 4320]) assert.equal(validateCancellationLead(ok), null, String(ok));
    for (const out of [-15, 4335, 10_000, 4321]) assert.equal(validateCancellationLead(out), MSG.leadOutOfRange, String(out));
    for (const bad of [10, 4310]) assert.equal(validateCancellationLead(bad), MSG.leadNotMultiple, String(bad));
    for (const bad of ['120', null, 1.5, NaN, Infinity, true, undefined, {}]) {
      assert.equal(validateCancellationLead(bad), MSG.leadNotInteger, String(bad));
    }
  });

  test('validateBusinessInput parcial só com o prazo; erro junto com o de outro campo; hasBusinessFields', () => {
    assert.deepEqual(validateBusinessInput({ cancellationLeadMinutes: 60 }, { partial: true }), { ok: true, value: { cancellationLeadMinutes: 60 } });
    const both = validateBusinessInput({ cancellationLeadMinutes: '60', phone: 'x' }, { partial: true });
    assert.deepEqual(Object.keys(both.fields).sort(), ['cancellationLeadMinutes', 'phone']);
    assert.equal(both.fields.cancellationLeadMinutes, MSG.leadNotInteger);
    assert.equal(validateBusinessInput({ cancellationLeadMinutes: undefined }, { partial: true }).ok, true);
    assert.equal(hasBusinessFields({ cancellationLeadMinutes: 0 }), true);
    const created = validateBusinessInput({ name: 'Salão', address: 'Rua A', phone: '(11) 91234-5678' });
    assert.equal('cancellationLeadMinutes' in created.value, false);
  });
});
