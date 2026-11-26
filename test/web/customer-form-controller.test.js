import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { CUSTOMER_FIELDS, checkCustomerField, checkCustomerForm, phoneDisplayOnBlur, serverFieldErrors } = await import(
  '../../web/js/customer-form-controller.js'
);
const shared = await import('../../src/shared/customers.js');
const M = shared.CUSTOMER_MESSAGES;

describe('checkCustomerField (critérios 3 e 6)', () => {
  test('campos na ordem da tela, congelados', () => {
    assert.deepEqual([...CUSTOMER_FIELDS], ['name', 'phone', 'email']);
    assert.ok(Object.isFrozen(CUSTOMER_FIELDS));
  });

  const CASES = [
    ['name', '', M.nameRequired],
    ['name', 'A', M.nameLength],
    ['name', '1234', M.nameInvalid],
    ['name', "D'Ávila", null],
    ['phone', '', M.phoneRequired],
    ['phone', '12345', M.phoneInvalid],
    ['phone', '011 91234 5678', M.phoneInvalid],
    ['phone', '+55 (11) 91234-5678', null],
    ['email', '', M.emailRequired],
    ['email', 'ana@', M.emailInvalid],
    ['email', ' Ana@Example.com ', null],
  ];
  for (const [field, value, expected] of CASES) {
    test(`${field} ${JSON.stringify(value)} -> mesma mensagem do servidor`, () => {
      assert.equal(checkCustomerField(field, value), expected);
      const server = { name: shared.validateCustomerName, phone: shared.validateCustomerPhone, email: shared.validateCustomerEmail }[field];
      assert.equal(checkCustomerField(field, value), server(value));
    });
  }

  test('campo desconhecido -> null', () => {
    assert.equal(checkCustomerField('password', ''), null);
    assert.equal(checkCustomerField('__proto__', ''), null);
  });

  test('checkCustomerForm é a validação compartilhada', () => {
    const values = { name: 'Ana', phone: '11 91234-5678', email: 'a@b.co' };
    assert.deepEqual(checkCustomerForm(values), shared.validateCustomerInput(values));
    assert.deepEqual(checkCustomerForm({}).fields, { name: M.nameRequired, phone: M.phoneRequired, email: M.emailRequired });
  });
});

describe('phoneDisplayOnBlur (critério 24)', () => {
  test('número válido é formatado', () => {
    assert.equal(phoneDisplayOnBlur('+55 11 912345678'), '(11) 91234-5678');
    assert.equal(phoneDisplayOnBlur('11 3123 4567'), '(11) 3123-4567');
    assert.equal(phoneDisplayOnBlur('5511912345678'), '(11) 91234-5678');
    assert.equal(phoneDisplayOnBlur('(11) 91234-5678'), '(11) 91234-5678');
  });

  test('entrada inválida volta intacta', () => {
    for (const value of ['011 91234 5678', '12345', '11 9abcd-5678', '', '  (11) 9123  ']) {
      assert.equal(phoneDisplayOnBlur(value), value);
    }
    assert.equal(phoneDisplayOnBlur(undefined), '');
  });
});

describe('serverFieldErrors (contrato do AF-11)', () => {
  test('só name/phone/email com string', () => {
    const error = { code: 'VALIDATION_ERROR', fields: { name: 'a', phone: 'b', email: 'c', serviceId: 'd', start: 'e' } };
    assert.deepEqual(serverFieldErrors(error), { name: 'a', phone: 'b', email: 'c' });
  });

  test('ignora __proto__, valores não-string e entradas malformadas', () => {
    const polluted = JSON.parse('{"fields":{"__proto__":{"name":"x"},"phone":42,"email":{"x":1}}}');
    assert.deepEqual(serverFieldErrors(polluted), {});
    assert.equal(({}).name, undefined);
    const inherited = { fields: Object.create({ name: 'herdado' }) };
    assert.deepEqual(serverFieldErrors(inherited), {});
    for (const v of [null, undefined, 'erro', 42, {}, { fields: null }, { fields: 'x' }]) {
      assert.deepEqual(serverFieldErrors(v), {});
    }
  });
});
