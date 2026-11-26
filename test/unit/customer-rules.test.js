import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as customers from '../../src/shared/customers.js';

const {
  normalizeCustomerPhone,
  validateCustomerName,
  validateCustomerPhone,
  validateCustomerEmail,
  validateCustomerInput,
  isValidDdd,
  VALID_DDDS,
  CUSTOMER_MESSAGES: M,
  CUSTOMER_NAME_MIN,
  CUSTOMER_NAME_MAX,
  CUSTOMER_EMAIL_MAX,
  CUSTOMER_PHONE_RAW_MAX,
} = customers;

const MISSING_DDDS = ['20', '23', '25', '26', '29', '30', '36', '39', '40', '50', '52', '56', '57', '58', '59', '60', '70', '72', '76', '78', '80', '90'];

describe('DDDs (critério 2, decisão 4)', () => {
  test('67 códigos únicos, todos com 2 dígitos de 11 a 99', () => {
    assert.equal(VALID_DDDS.length, 67);
    assert.equal(new Set(VALID_DDDS).size, 67);
    for (const ddd of VALID_DDDS) {
      assert.match(ddd, /^[1-9][0-9]$/);
      assert.ok(Number(ddd) >= 11 && Number(ddd) <= 99, ddd);
      assert.equal(isValidDdd(ddd), true, ddd);
    }
  });

  test('inexistentes ficam fora', () => {
    for (const ddd of [...MISSING_DDDS, '00', '01', '10']) {
      assert.equal(VALID_DDDS.includes(ddd), false, ddd);
      assert.equal(isValidDdd(ddd), false, ddd);
    }
    for (const v of [11, null, undefined, '011', '1', '']) assert.equal(isValidDdd(v), false, String(v));
  });

  test('VALID_DDDS é um array congelado; alterá-lo falha e não muda isValidDdd', () => {
    assert.ok(Array.isArray(VALID_DDDS));
    assert.ok(Object.isFrozen(VALID_DDDS));
    assert.throws(() => VALID_DDDS.push('20'), TypeError);
    assert.throws(() => {
      VALID_DDDS[0] = '20';
    }, TypeError);
    assert.throws(() => VALID_DDDS.splice(0, 1), TypeError);
    assert.equal(VALID_DDDS.length, 67);
    assert.equal(isValidDdd('20'), false);
    assert.equal(isValidDdd('11'), true);
  });

  test('o Set interno não é exportado', () => {
    for (const [name, value] of Object.entries(customers)) {
      assert.equal(value instanceof Set, false, `${name} exporta um Set`);
    }
  });
});

describe('telefone (critérios 2, 3 e 24)', () => {
  const VALID = [
    ['(11) 91234-5678', '11912345678'],
    ['11912345678', '11912345678'],
    ['+55 11 91234-5678', '11912345678'],
    ['+5511912345678', '11912345678'],
    ['5511912345678', '11912345678'],
    ['55 11 3123-4567', '1131234567'],
    ['(21) 3123.4567', '2131234567'],
    ['55 91234-5678', '55912345678'],
    ['5555912345678', '55912345678'],
    ['  (11) 91234-5678  ', '11912345678'],
    ['(99) 5123-4567', '9951234567'],
  ];
  for (const [raw, digits] of VALID) {
    test(`válido: ${JSON.stringify(raw)} -> ${digits}`, () => {
      assert.equal(validateCustomerPhone(raw), null);
      assert.equal(normalizeCustomerPhone(raw), digits);
    });
  }

  const INVALID = [
    '119123456', // 9 dígitos
    '119123456781', // 12 dígitos sem 55
    '11912345678901', // 14 dígitos
    ...MISSING_DDDS.map((ddd) => `${ddd} 91234-5678`),
    '00 91234-5678',
    '11 81234-5678', // celular de 9 que não começa com 9
    '11 6123-4567', // fixo começando com 6
    '11 1123-4567', // fixo começando com 1
    '11 99999-9999',
    '21 2222-2222',
    '11 90000-0000',
    '11 9abcd-5678',
    '++55 11 91234-5678',
    '+44 20 7946 0958',
    '11+912345678',
    '011 91234-5678',
    '0 15 11 91234-5678',
    '11 91234_5678',
    '+55 55 11 91234-5678',
  ];
  for (const raw of INVALID) {
    test(`inválido: ${JSON.stringify(raw)} -> mensagem fixa, sem eco`, () => {
      const message = validateCustomerPhone(raw);
      assert.equal(message, M.phoneInvalid);
      assert.equal(message.includes(raw.trim()), false);
    });
  }

  test('a mensagem de inválido é a mesma para todos os casos e não contém dígitos da entrada', () => {
    const messages = new Set(INVALID.map((raw) => validateCustomerPhone(raw)));
    assert.deepEqual([...messages], [M.phoneInvalid]);
  });

  test('não-string é inválido; vazio e só espaços são obrigatórios', () => {
    for (const v of [11912345678, {}, [], true]) assert.equal(validateCustomerPhone(v), M.phoneInvalid, String(v));
    for (const v of ['', '   ', '\t', undefined, null]) assert.equal(validateCustomerPhone(v), M.phoneRequired, String(v));
    assert.equal(normalizeCustomerPhone(42), null);
  });

  test(`entrada acima de ${CUSTOMER_PHONE_RAW_MAX} caracteres falha rápido, sem regex`, () => {
    const huge = `${'1'.repeat(10_000)}`;
    const started = performance.now();
    assert.equal(validateCustomerPhone(huge), M.phoneInvalid);
    assert.equal(normalizeCustomerPhone(huge), null);
    assert.ok(performance.now() - started < 5, 'mais de 5 ms');
    assert.equal(normalizeCustomerPhone(` ${'1'.repeat(CUSTOMER_PHONE_RAW_MAX)}`), null);
  });
});

describe('nome (critério 5)', () => {
  for (const name of ['Ana', "D'Ávila", 'D’Ávila', 'Maria-José', 'Zoë', 'José da Silva', 'Ana P. Souza', 'Jo']) {
    test(`aceito: ${name}`, () => assert.equal(validateCustomerName(name), null));
  }

  test('80 code points com emoji aceitos; 81 recusados; 1 caractere recusado', () => {
    assert.equal(CUSTOMER_NAME_MIN, 2);
    assert.equal(CUSTOMER_NAME_MAX, 80);
    const eighty = `Ana ${'😀'.repeat(76)}`;
    assert.equal([...eighty].length, 80);
    assert.ok(eighty.length > 80, 'mais de 80 unidades UTF-16');
    assert.equal(validateCustomerName(eighty), null);
    assert.equal(validateCustomerName(`${eighty}a`), M.nameLength);
    assert.equal(validateCustomerName('A'), M.nameLength);
    assert.equal(validateCustomerName('  A  '), M.nameLength);
  });

  for (const [label, name] of [
    ['U+0000', 'Ana\u0000'],
    ['\\n no fim', 'Ana\n'],
    ['\\n no meio', 'Ana\nSouza'],
    ['U+202E', 'Ana‮'],
    ['U+200B', 'Ana​Souza'],
    ['Hangul filler', 'ㅤㅤ'],
    ['só dígitos', '1234'],
    ['só pontuação', "-'."],
  ]) {
    test(`inválido: ${label}`, () => assert.equal(validateCustomerName(name), M.nameInvalid));
  }

  test('vazio, só espaços e não-string são obrigatórios', () => {
    for (const v of ['', '   ', undefined, null, 42]) assert.equal(validateCustomerName(v), M.nameRequired, String(v));
  });

  test('o valor sai aparado e em NFC', () => {
    const decomposed = '  José da Silva ';
    const result = validateCustomerInput({ name: decomposed, phone: '11912345678', email: 'a@b.co' });
    assert.equal(result.ok, true);
    assert.equal(result.value.name, 'José da Silva');
    assert.equal(result.value.name, 'José da Silva'.normalize('NFC'));
  });
});

describe('e-mail (critério 4)', () => {
  test('normaliza: trim e minúsculas', () => {
    const result = validateCustomerInput({ name: 'Ana', phone: '11912345678', email: ' Ana@Example.COM ' });
    assert.equal(result.ok, true);
    assert.equal(result.value.email, 'ana@example.com');
  });

  test('254 caracteres aceitos; 255 recusados', () => {
    assert.equal(CUSTOMER_EMAIL_MAX, 254);
    const at254 = `${'a'.repeat(254 - '@x.com'.length)}@x.com`;
    assert.equal(at254.length, 254);
    assert.equal(validateCustomerEmail(at254), null);
    assert.equal(validateCustomerEmail(`a${at254}`), M.emailInvalid);
  });

  for (const email of ['ana@', '@x.com', 'a b@x.com', 'ana@x', 'ana​@x.com', 'ana@x.com\u0000', 'ana', 'ana@@x.com']) {
    test(`recusado: ${JSON.stringify(email)}`, () => assert.equal(validateCustomerEmail(email), M.emailInvalid));
  }

  test('vazio e não-string são obrigatórios', () => {
    for (const v of ['', '  ', undefined, null, 7]) assert.equal(validateCustomerEmail(v), M.emailRequired, String(v));
  });
});

describe('validateCustomerInput (critérios 1 e 6)', () => {
  test('válido: valores normalizados', () => {
    const result = validateCustomerInput({ name: ' Ana Souza ', phone: '+55 (11) 91234-5678', email: 'Ana@Example.com ' });
    assert.deepEqual(result, { ok: true, value: { name: 'Ana Souza', phone: '11912345678', email: 'ana@example.com' } });
  });

  test('os três erros voltam juntos', () => {
    const result = validateCustomerInput({ name: 'A', phone: '123', email: 'x' });
    assert.deepEqual(result, { ok: false, fields: { name: M.nameLength, phone: M.phoneInvalid, email: M.emailInvalid } });
  });

  test('chaves extras são ignoradas e não aparecem em value', () => {
    const result = validateCustomerInput({ name: 'Ana', phone: '11912345678', email: 'a@b.co', password: 'x', id: '1', serviceId: 'y' });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.value).sort(), ['email', 'name', 'phone']);
  });

  test('null, array, string e número valem {} (todos obrigatórios)', () => {
    const expected = { ok: false, fields: { name: M.nameRequired, phone: M.phoneRequired, email: M.emailRequired } };
    for (const input of [null, undefined, [], ['Ana', '11912345678', 'a@b.co'], 'Ana', 42]) {
      assert.deepEqual(validateCustomerInput(input), expected, JSON.stringify(input));
    }
  });

  test('propriedades herdadas não contam', () => {
    const input = Object.create({ name: 'Ana', phone: '11912345678', email: 'a@b.co' });
    assert.equal(validateCustomerInput(input).ok, false);
  });

  test('mensagens fixas e congeladas; nenhuma ecoa a entrada', () => {
    assert.ok(Object.isFrozen(M));
    const input = { name: 'Zé<script>\u0000', phone: '11 9abc', email: 'evil<x>@' };
    const result = validateCustomerInput(input);
    assert.equal(result.ok, false);
    for (const message of Object.values(result.fields)) {
      assert.ok(Object.values(M).includes(message));
      for (const value of Object.values(input)) assert.equal(message.includes(value), false);
    }
  });
});
