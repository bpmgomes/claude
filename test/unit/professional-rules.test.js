import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProfessionalName,
  validateServiceIds,
  validateProfessionalInput,
  hasProfessionalFields,
  hasDuplicateName,
  professionalNameKey,
  PROFESSIONAL_ID_RE,
  PROFESSIONAL_MESSAGES as M,
  PROFESSIONAL_NAME_MAX,
  SERVICE_IDS_MAX,
} from '../../src/shared/professionals.js';
import { SERVICE_ID_RE } from '../../src/shared/services.js';
import { textKey } from '../../src/shared/validation.js';
import { toOwnerProfessional, photoUrlOf } from '../../src/modules/professionals/professionals.repository.js';

const ID1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('validateProfessionalName (critério 3)', () => {
  test('vazio, só espaços e não-string -> obrigatório', () => {
    for (const v of ['', '   ', undefined, null, 42, {}]) assert.equal(validateProfessionalName(v), M.nameRequired);
  });

  test('100 code points aceitos, 101 recusados', () => {
    assert.equal(PROFESSIONAL_NAME_MAX, 100);
    assert.equal(validateProfessionalName('á'.repeat(100)), null);
    assert.equal(validateProfessionalName(`  ${'a'.repeat(100)}  `), null);
    assert.equal(validateProfessionalName('a'.repeat(101)), M.nameTooLong);
  });

  for (const [label, text] of [
    ['U+202E', 'Ana‮Souza'],
    ['U+200B', 'Ana​Souza'],
    ['\\n', 'Ana\nSouza'],
    ['só marcas', '́́'],
    ['4 marcas', 'ẫ̄́'],
    ['U+3164', 'ㅤ'],
    ['U+2800', '⠀'],
    ['sem letra nem número', '...'],
  ]) {
    test(`recusa ${label}`, () => {
      assert.equal(validateProfessionalName(text), M.nameInvalid);
    });
  }

  test('aceita nomes reais', () => {
    for (const name of ['Ana', 'João', 'Nguyễn', 'Dra. Ana', 'Ana 2', '李']) {
      assert.equal(validateProfessionalName(name), null, name);
    }
  });
});

describe('validateServiceIds (critérios 6, 9)', () => {
  test('ausente e null viram []', () => {
    assert.deepEqual(validateServiceIds(undefined), { ok: true, value: [] });
    assert.deepEqual(validateServiceIds(null), { ok: true, value: [] });
  });

  test('não array, item número, "abc" e UUID maiúsculo são inválidos', () => {
    for (const raw of ['x', 1, {}, [1], ['abc'], [ID1.toUpperCase()], [ID1, null]]) {
      assert.deepEqual(validateServiceIds(raw), { ok: false, message: M.serviceIdsInvalid }, JSON.stringify(raw));
    }
  });

  test('101 itens rejeitados sem iterar o resto', () => {
    assert.equal(SERVICE_IDS_MAX, 100);
    let reads = 0;
    const list = new Proxy(Array.from({ length: 101 }, () => ID1), {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    assert.deepEqual(validateServiceIds(list), { ok: false, message: M.serviceIdsTooMany });
    assert.equal(reads, 0);
  });

  test('100 itens válidos passam; repetidos viram únicos na ordem', () => {
    assert.equal(validateServiceIds(Array.from({ length: 100 }, () => ID1)).ok, true);
    assert.deepEqual(validateServiceIds([ID2, ID1, ID2, ID1]), { ok: true, value: [ID2, ID1] });
  });

  test('a mensagem não ecoa a entrada', () => {
    const huge = 'x'.repeat(5000);
    const result = validateServiceIds([huge]);
    assert.equal(result.message.includes('xxx'), false);
  });
});

describe('validateProfessionalInput', () => {
  test('criação: name obrigatório, serviceIds padrão []', () => {
    assert.deepEqual(validateProfessionalInput({ name: ' Ana ' }), {
      ok: true,
      value: { name: 'Ana', nameKey: 'ana', serviceIds: [] },
    });
    assert.deepEqual(validateProfessionalInput({}), { ok: false, fields: { name: M.nameRequired } });
    assert.deepEqual(validateProfessionalInput(null), { ok: false, fields: { name: M.nameRequired } });
  });

  test('junta erros de todos os campos', () => {
    assert.deepEqual(validateProfessionalInput({ name: '', serviceIds: 'x' }), {
      ok: false,
      fields: { name: M.nameRequired, serviceIds: M.serviceIdsInvalid },
    });
  });

  test('campos extras são ignorados', () => {
    const result = validateProfessionalInput({ name: 'Ana', businessId: ID1, id: ID2, photoKey: 'x', removedAt: 'y' });
    assert.deepEqual(Object.keys(result.value).sort(), ['name', 'nameKey', 'serviceIds']);
  });

  test('parcial: {} dá "Nada para atualizar."; só os campos presentes', () => {
    assert.deepEqual(validateProfessionalInput({}, { partial: true }), {
      ok: false,
      fields: {},
      message: 'Nada para atualizar.',
    });
    assert.deepEqual(validateProfessionalInput({ serviceIds: [ID1] }, { partial: true }), {
      ok: true,
      value: { serviceIds: [ID1] },
    });
    assert.deepEqual(validateProfessionalInput({ name: 'Bia' }, { partial: true }), {
      ok: true,
      value: { name: 'Bia', nameKey: 'bia' },
    });
    assert.deepEqual(validateProfessionalInput({ serviceIds: [] }, { partial: true }).value, { serviceIds: [] });
  });

  test('hasProfessionalFields', () => {
    assert.equal(hasProfessionalFields({ name: 'x' }), true);
    assert.equal(hasProfessionalFields({ serviceIds: [] }), true);
    assert.equal(hasProfessionalFields({ businessId: 'x' }), false);
    assert.equal(hasProfessionalFields(null), false);
  });

  test('PROFESSIONAL_ID_RE é o mesmo UUID v4 de SERVICE_ID_RE; professionalNameKey = textKey', () => {
    assert.equal(PROFESSIONAL_ID_RE, SERVICE_ID_RE);
    assert.equal(professionalNameKey, textKey);
  });
});

describe('hasDuplicateName (decisão 4)', () => {
  const list = [
    { id: ID1, name: 'Ana Souza' },
    { id: ID2, name: 'Bia' },
  ];
  test('ignora caixa, acento e espaços', () => {
    assert.equal(hasDuplicateName('ANA  souza', list), true);
    assert.equal(hasDuplicateName('Aná Souza', list), true);
    assert.equal(hasDuplicateName('Carla', list), false);
  });
  test('exclui o próprio id', () => {
    assert.equal(hasDuplicateName('Ana Souza', list, ID1), false);
    assert.equal(hasDuplicateName('Bia', list, ID1), true);
  });
  test('vazio ou lista inválida -> false', () => {
    assert.equal(hasDuplicateName('', list), false);
    assert.equal(hasDuplicateName('Ana', null), false);
  });
});

describe('toOwnerProfessional (critérios 7, 8)', () => {
  const base = {
    id: ID1,
    businessId: ID2,
    name: 'Ana',
    nameKey: 'ana',
    photoKey: `professionals/${ID2}.png`,
    removedAt: null,
    createdAt: 'c',
    updatedAt: 'u',
  };

  test('não expõe businessId, nameKey, photoKey nem removedAt', () => {
    const out = toOwnerProfessional({ ...base, services: [] });
    assert.deepEqual(Object.keys(out).sort(), ['bookable', 'createdAt', 'id', 'name', 'photoUrl', 'services', 'updatedAt']);
    assert.equal(out.photoUrl, `/media/professionals/${ID2}.png`);
    assert.equal(photoUrlOf(null), null);
  });

  test('bookable: falso sem serviços ou só com inativos; verdadeiro com um ativo', () => {
    assert.equal(toOwnerProfessional({ ...base, services: [] }).bookable, false);
    const inactive = { id: ID2, name: 'Corte', active: false };
    assert.equal(toOwnerProfessional({ ...base, services: [inactive] }).bookable, false);
    const active = { id: ID1, name: 'Barba', active: true };
    const out = toOwnerProfessional({ ...base, services: [active, inactive] });
    assert.equal(out.bookable, true);
    assert.deepEqual(out.services, [active, inactive]);
  });
});
