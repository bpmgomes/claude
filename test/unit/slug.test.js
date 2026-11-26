import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  normalizeSlug,
  validateSlug,
  withSuffix,
  parsePublicSlug,
  RESERVED_SLUGS,
  SLUG_MAX,
  SLUG_RE,
} from '../../src/shared/slug.js';

const INVALID = 'O link deve ter de 3 a 50 caracteres, só com letras minúsculas sem acento, números e hífen.';
const RESERVED = 'Este link é reservado. Escolha outro.';

describe('slugify (critério 15)', () => {
  for (const [input, expected] of [
    ['Salão da Ana', 'salao-da-ana'],
    ['  --Café & Cia--  ', 'cafe-cia'],
    ['AÇAÍ  DO   ZÉ', 'acai-do-ze'],
    ['Ünïcödé', 'unicode'],
    ['Zé', 'ze'],
    ['Barbearia 2 Irmãos!!!', 'barbearia-2-irmaos'],
    ['💈', ''],
  ]) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(slugify(input), expected);
    });
  }

  test('80 caracteres viram no máximo 50, sem hífen final', () => {
    const name = 'abcd '.repeat(16); // 80 caracteres
    const slug = slugify(name);
    assert.ok(slug.length <= SLUG_MAX);
    assert.doesNotMatch(slug, /-$/);
    assert.match(slug, SLUG_RE);
  });

  test('não-string vira string vazia', () => {
    assert.equal(slugify(undefined), '');
    assert.equal(slugify(42), '');
  });
});

describe('normalizeSlug', () => {
  test('trim e minúsculas; não-string vira vazio', () => {
    assert.equal(normalizeSlug('  Salao-Da-Ana '), 'salao-da-ana');
    assert.equal(normalizeSlug(null), '');
  });
});

describe('validateSlug (critérios 16, 19)', () => {
  test('Salao-Da-Ana é aceito como salao-da-ana', () => {
    assert.deepEqual(validateSlug('Salao-Da-Ana'), { ok: true, value: 'salao-da-ana' });
  });

  test('3 e 50 caracteres são aceitos', () => {
    assert.equal(validateSlug('abc').ok, true);
    assert.equal(validateSlug('a'.repeat(50)).ok, true);
  });

  for (const raw of ['ab', 'a'.repeat(51), 'salão', 'a--b', '-ab', 'ab-', 'a b', 'a_b', '../x', '', null, 12345]) {
    test(`${JSON.stringify(raw)} é INVALID`, () => {
      assert.deepEqual(validateSlug(raw), { ok: false, reason: 'INVALID', message: INVALID });
    });
  }

  test('todo item de RESERVED_SLUGS é RESERVED', () => {
    assert.ok(RESERVED_SLUGS.size > 30);
    for (const slug of RESERVED_SLUGS) {
      if (slug.length < 3) {
        assert.equal(validateSlug(slug).reason, 'INVALID', slug);
        continue;
      }
      assert.deepEqual(validateSlug(slug), { ok: false, reason: 'RESERVED', message: RESERVED }, slug);
      assert.equal(validateSlug(slug.toUpperCase()).reason, 'RESERVED', slug);
    }
  });

  test('RESERVED_SLUGS é somente leitura', () => {
    assert.throws(() => RESERVED_SLUGS.add('novo'));
    assert.throws(() => RESERVED_SLUGS.delete('admin'));
    assert.ok(RESERVED_SLUGS.has('admin'));
  });
});

describe('withSuffix', () => {
  test('acrescenta o sufixo', () => {
    assert.equal(withSuffix('salao-da-ana', 2), 'salao-da-ana-2');
  });

  test('respeita 50 caracteres cortando a base, sem hífen duplo', () => {
    const base = `${'a'.repeat(47)}-bc`; // 50
    const out = withSuffix(base, 12);
    assert.equal(out.length <= SLUG_MAX, true);
    assert.match(out, SLUG_RE);
    assert.equal(out, `${'a'.repeat(47)}-12`);
    assert.equal(withSuffix('a'.repeat(50), 9999).length, 50);
  });
});

describe('parsePublicSlug (AF-09, critérios 6 e 21)', () => {
  test('slug canônico dá ok', () => {
    assert.deepEqual(parsePublicSlug('salao-da-ana'), { kind: 'ok', slug: 'salao-da-ana' });
    assert.deepEqual(parsePublicSlug('abc'), { kind: 'ok', slug: 'abc' });
    assert.deepEqual(parsePublicSlug('a'.repeat(50)), { kind: 'ok', slug: 'a'.repeat(50) });
  });

  test('maiúsculas dão redirect para o minúsculo', () => {
    assert.deepEqual(parsePublicSlug('Salao-Da-Ana'), { kind: 'redirect', slug: 'salao-da-ana' });
    assert.deepEqual(parsePublicSlug('SALAO'), { kind: 'redirect', slug: 'salao' });
  });

  const invalid = [
    'ab',
    'a'.repeat(51),
    'salão',
    'a--b',
    '-a',
    'a-',
    'a_b',
    'a.html',
    'admin',
    'ADMIN',
    'İstanbul',
    'abc\u0000',
    'abc\n',
    'abc‮',
    ' abc',
    '',
    undefined,
    null,
    123,
    {},
  ];
  for (const raw of invalid) {
    test(`${JSON.stringify(raw)} dá invalid sem carregar a entrada`, () => {
      const result = parsePublicSlug(raw);
      assert.deepEqual(result, { kind: 'invalid' });
      assert.equal('slug' in result, false);
    });
  }

  test('string de 10.000 caracteres: invalid sem regex (menos de 5 ms)', () => {
    const huge = 'a'.repeat(10_000);
    const started = process.hrtime.bigint();
    const result = parsePublicSlug(huge);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual(result, { kind: 'invalid' });
    assert.ok(elapsedMs < 5, `${elapsedMs} ms`);
  });
});
