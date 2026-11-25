import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDuration,
  parsePriceToCents,
  formatPriceCents,
  formatServicePrice,
  formatDuration,
  validateServiceName,
  serviceNameKey,
  validateServiceInput,
  hasServiceFields,
  validateStatusFilter,
  DURATION_OPTIONS,
  PRICE_MAX_CENTS,
  SERVICE_MESSAGES as M,
} from '../../src/shared/services.js';
import { toServiceSnapshot, toOwnerService } from '../../src/modules/services/services.repository.js';

const BASE = { name: 'Corte', durationMinutes: 30, price: '50' };

describe('duração (critério 4)', () => {
  for (const ok of [15, 30, 45, 480]) {
    test(`${ok} aceito`, () => {
      assert.equal(validateDuration(ok), null);
      assert.equal(validateServiceInput({ ...BASE, durationMinutes: ok }).ok, true);
    });
  }
  for (const bad of [0, 10, 20, 495, 500, -15, 30.5, '30', 'abc', '', null, undefined]) {
    test(`${JSON.stringify(bad) ?? 'ausente'} rejeitado com fields.durationMinutes`, () => {
      const input = { ...BASE, durationMinutes: bad };
      if (bad === undefined) delete input.durationMinutes;
      const result = validateServiceInput(input);
      assert.equal(result.ok, false);
      assert.deepEqual(Object.keys(result.fields), ['durationMinutes']);
      const expected = bad === '' || bad === null || bad === undefined ? M.durationRequired : M.durationInvalid;
      assert.equal(result.fields.durationMinutes, expected);
    });
  }

  test('DURATION_OPTIONS tem 32 itens, de 15 a 480', () => {
    assert.equal(DURATION_OPTIONS.length, 32);
    assert.equal(DURATION_OPTIONS[0], 15);
    assert.equal(DURATION_OPTIONS.at(-1), 480);
    assert.ok(Object.isFrozen(DURATION_OPTIONS));
    for (const d of DURATION_OPTIONS) assert.equal(validateDuration(d), null);
  });
});

describe('preço (critério 5)', () => {
  const accepted = [
    ['50', 5000],
    ['50,5', 5050],
    ['50.50', 5050],
    ['0', 0],
    ['0,00', 0],
    ['0,10', 10],
    [50.5, 5050],
    [50, 5000],
    ['99999,99', 9999999],
    ['  12,3  ', 1230],
    ['007', 700],
  ];
  for (const [raw, cents] of accepted) {
    test(`${JSON.stringify(raw)} -> ${cents}`, () => {
      assert.deepEqual(parsePriceToCents(raw), { ok: true, cents });
    });
  }

  const rejected = [
    ['50,555', M.priceDecimals],
    ['-1', M.priceNegative],
    ['-0,01', M.priceNegative],
    [-1, M.priceNegative],
    ['abc', M.priceInvalid],
    ['R$ 50', M.priceInvalid],
    ['1.000,00', M.priceInvalid],
    ['50,', M.priceInvalid],
    ['', M.priceRequired],
    ['   ', M.priceRequired],
    [1e21, M.priceInvalid],
    [NaN, M.priceInvalid],
    [Infinity, M.priceInvalid],
    [true, M.priceInvalid],
    [{}, M.priceInvalid],
    ['100000', M.priceTooHigh],
    ['99999,991', M.priceDecimals],
    ['10000000', M.priceTooHigh],
    ['00000000000000100000', M.priceTooHigh],
  ];
  for (const [raw, message] of rejected) {
    test(`${String(raw)} rejeitado: ${message}`, () => {
      assert.deepEqual(parsePriceToCents(raw), { ok: false, message });
    });
  }

  test('string de 10.000 dígitos é rejeitada sem converter, em menos de 50 ms', () => {
    const start = performance.now();
    const result = parsePriceToCents('9'.repeat(10_000));
    const elapsed = performance.now() - start;
    assert.deepEqual(result, { ok: false, message: M.priceInvalid });
    assert.ok(elapsed < 50, `${elapsed} ms`);
  });

  test('0,10 + 0,20 é exatamente 30 centavos (sem ponto flutuante)', () => {
    const sum = parsePriceToCents('0,10').cents + parsePriceToCents('0,20').cents;
    assert.equal(sum, 30);
    assert.equal(formatPriceCents(sum), 'R$ 0,30');
    assert.ok(!formatPriceCents(sum).includes('0000000'));
  });

  test('todas as saídas são inteiros seguros e nenhuma formatação contém 0000000', () => {
    for (let reais = 0; reais < 3; reais++) {
      for (let c = 0; c < 100; c++) {
        const text = `${reais},${String(c).padStart(2, '0')}`;
        const { cents } = parsePriceToCents(text);
        assert.ok(Number.isSafeInteger(cents));
        assert.equal(cents, reais * 100 + c);
        assert.ok(!formatPriceCents(cents).includes('0000000'));
      }
    }
    assert.equal(PRICE_MAX_CENTS, 9_999_999);
  });
});

describe('formatação (critério 22)', () => {
  test('formatPriceCents', () => {
    assert.equal(formatPriceCents(0), 'R$ 0,00');
    assert.equal(formatPriceCents(5), 'R$ 0,05');
    assert.equal(formatPriceCents(5000), 'R$ 50,00');
    assert.equal(formatPriceCents(123450), 'R$ 1.234,50');
    assert.equal(formatPriceCents(9999999), 'R$ 99.999,99');
    assert.equal(formatPriceCents(100000000), 'R$ 1.000.000,00');
    assert.ok(!formatPriceCents(5000).includes(' '));
  });

  test('formatServicePrice', () => {
    assert.equal(formatServicePrice({ priceCents: null, priceOnRequest: true }), 'Sob consulta');
    assert.equal(formatServicePrice({ priceCents: 0, priceOnRequest: false }), 'R$ 0,00');
    assert.equal(formatServicePrice({ priceCents: 5050, priceOnRequest: false }), 'R$ 50,50');
  });

  test('formatDuration', () => {
    assert.equal(formatDuration(15), '15 min');
    assert.equal(formatDuration(45), '45 min');
    assert.equal(formatDuration(60), '1 h');
    assert.equal(formatDuration(90), '1 h 30 min');
    assert.equal(formatDuration(135), '2 h 15 min');
    assert.equal(formatDuration(480), '8 h');
  });
});

describe('nome (critérios 3 e 20)', () => {
  for (const [label, raw, message] of [
    ['vazio', '', M.nameRequired],
    ['só espaços', '   ', M.nameRequired],
    ['não string', 42, M.nameRequired],
    ['101 code points', 'a'.repeat(101), M.nameTooLong],
    ['U+202E', 'Corte‮masculino', M.nameInvalid],
    ['U+200B', 'Corte​masculino', M.nameInvalid],
    ['\\n', 'Corte\nmasculino', M.nameInvalid],
  ]) {
    test(`${label} -> erro`, () => assert.equal(validateServiceName(raw), message));
  }

  test('100 code points (inclusive emoji) é aceito', () => {
    assert.equal(validateServiceName('a'.repeat(100)), null);
    assert.equal(validateServiceName('😀'.repeat(100)), null);
    assert.equal(validateServiceName('😀'.repeat(101)), M.nameTooLong);
  });

  test('serviceNameKey iguala caixa, acentos e espaços', () => {
    const key = serviceNameKey('Corte Masculino');
    assert.equal(key, 'corte masculino');
    assert.equal(serviceNameKey('corte  masculino'), key);
    assert.equal(serviceNameKey('CÓRTE MASCULÍNO'), key);
    assert.equal(serviceNameKey('  Corte\tMasculino '), key);
    // NFC e NFD produzem a mesma chave
    assert.equal(serviceNameKey('Coloração'.normalize('NFD')), serviceNameKey('Coloração'.normalize('NFC')));
  });

  test('o nome é gravado como digitado (trim + NFC) e a chave vem junto', () => {
    const result = validateServiceInput({ ...BASE, name: '  Córte Masculino ' });
    assert.equal(result.value.name, 'Córte Masculino');
    assert.equal(result.value.nameKey, 'corte masculino');
  });
});

describe('par preço/sob consulta (critério 6)', () => {
  test('POST: preço válido -> priceCents e priceOnRequest false', () => {
    assert.deepEqual(validateServiceInput(BASE).value, {
      name: 'Corte',
      nameKey: 'corte',
      durationMinutes: 30,
      priceCents: 5000,
      priceOnRequest: false,
    });
  });

  test('POST: sob consulta sem preço -> priceCents null', () => {
    const result = validateServiceInput({ name: 'Coloração', durationMinutes: 120, priceOnRequest: true });
    assert.equal(result.ok, true);
    assert.equal(result.value.priceCents, null);
    assert.equal(result.value.priceOnRequest, true);
    assert.equal(validateServiceInput({ name: 'X', durationMinutes: 30, priceOnRequest: true, price: null }).ok, true);
  });

  test('POST: sob consulta com preço -> erro em price', () => {
    const result = validateServiceInput({ ...BASE, priceOnRequest: true });
    assert.deepEqual(result.fields, { price: M.priceWithOnRequest });
  });

  test('POST: sem preço e sem sob consulta -> erro em price', () => {
    assert.deepEqual(validateServiceInput({ name: 'X', durationMinutes: 30 }).fields, { price: M.priceRequired });
    assert.deepEqual(validateServiceInput({ name: 'X', durationMinutes: 30, priceOnRequest: false }).fields, {
      price: M.priceRequired,
    });
  });

  test('priceOnRequest não booleano -> erro em priceOnRequest', () => {
    for (const bad of ['true', 1, null, {}]) {
      const result = validateServiceInput({ ...BASE, priceOnRequest: bad });
      assert.equal(result.ok, false);
      assert.equal(result.fields.priceOnRequest, M.priceOnRequestInvalid);
    }
  });

  test('corpo vazio junta name, durationMinutes e price', () => {
    assert.deepEqual(Object.keys(validateServiceInput({}).fields).sort(), ['durationMinutes', 'name', 'price']);
    assert.deepEqual(Object.keys(validateServiceInput(null).fields).sort(), ['durationMinutes', 'name', 'price']);
  });

  const partial = (input) => validateServiceInput(input, { partial: true });

  test('PATCH: price sem priceOnRequest -> grava os dois', () => {
    assert.deepEqual(partial({ price: '10' }).value, { priceCents: 1000, priceOnRequest: false });
    assert.deepEqual(partial({ price: '10', priceOnRequest: false }).value, { priceCents: 1000, priceOnRequest: false });
  });

  test('PATCH: priceOnRequest true sem preço (ou null) -> priceCents null', () => {
    assert.deepEqual(partial({ priceOnRequest: true }).value, { priceCents: null, priceOnRequest: true });
    assert.deepEqual(partial({ priceOnRequest: true, price: null }).value, { priceCents: null, priceOnRequest: true });
  });

  test('PATCH: combinações inválidas -> erro em price', () => {
    assert.deepEqual(partial({ priceOnRequest: true, price: '10' }).fields, { price: M.priceWithOnRequest });
    assert.deepEqual(partial({ priceOnRequest: false }).fields, { price: M.priceRequired });
    assert.deepEqual(partial({ price: null }).fields, { price: M.priceRequired });
  });

  test('PATCH: só nome não toca no par; sem campos -> Nada para atualizar', () => {
    assert.deepEqual(partial({ name: 'Barba' }).value, { name: 'Barba', nameKey: 'barba' });
    assert.deepEqual(partial({ durationMinutes: 60 }).value, { durationMinutes: 60 });
    const empty = partial({ active: false });
    assert.equal(empty.ok, false);
    assert.equal(empty.message, 'Nada para atualizar.');
  });

  test('campos extras são ignorados', () => {
    const result = validateServiceInput({ ...BASE, businessId: 'x', active: false, priceCents: 1, id: 'y' });
    assert.deepEqual(Object.keys(result.value).sort(), ['durationMinutes', 'name', 'nameKey', 'priceCents', 'priceOnRequest']);
    assert.equal(result.value.priceCents, 5000);
  });

  test('hasServiceFields', () => {
    assert.equal(hasServiceFields({}), false);
    assert.equal(hasServiceFields(null), false);
    assert.equal(hasServiceFields({ businessId: 'x' }), false);
    for (const key of ['name', 'durationMinutes', 'price', 'priceOnRequest']) {
      assert.equal(hasServiceFields({ [key]: undefined }), true);
    }
  });
});

describe('filtro de estado', () => {
  test('ausente = all; valores válidos; inválidos com mensagem fixa', () => {
    assert.deepEqual(validateStatusFilter(undefined), { ok: true, value: 'all' });
    for (const s of ['all', 'active', 'inactive']) assert.deepEqual(validateStatusFilter(s), { ok: true, value: s });
    for (const bad of ['foo', '', '<script>', ['active'], 1]) {
      assert.deepEqual(validateStatusFilter(bad), { ok: false, message: M.statusInvalid });
    }
  });
});

describe('mensagens', () => {
  test('são fixas e congeladas', () => {
    assert.ok(Object.isFrozen(M));
    for (const text of Object.values(M)) assert.equal(typeof text, 'string');
  });
});

describe('toServiceSnapshot (critério 11, contrato do AF-11)', () => {
  test('cópia congelada que não muda quando o serviço muda', () => {
    const service = {
      id: 's1',
      businessId: 'b1',
      name: 'Corte',
      nameKey: 'corte',
      durationMinutes: 30,
      priceCents: 5000,
      priceOnRequest: false,
      active: true,
      createdAt: 't',
      updatedAt: 't',
    };
    const snapshot = toServiceSnapshot(service);
    assert.deepEqual(snapshot, { serviceId: 's1', name: 'Corte', durationMinutes: 30, priceCents: 5000, priceOnRequest: false });
    assert.ok(Object.isFrozen(snapshot));
    service.priceCents = 9000;
    service.durationMinutes = 60;
    service.active = false;
    assert.equal(snapshot.priceCents, 5000);
    assert.equal(snapshot.durationMinutes, 30);
  });

  test('toOwnerService não expõe businessId nem nameKey', () => {
    const owner = toOwnerService({
      id: 's1',
      businessId: 'b1',
      name: 'X',
      nameKey: 'x',
      durationMinutes: 15,
      priceCents: null,
      priceOnRequest: true,
      active: true,
      createdAt: 't',
      updatedAt: 't',
    });
    assert.equal('businessId' in owner, false);
    assert.equal('nameKey' in owner, false);
    assert.equal(owner.priceCents, null);
  });
});
