// AF-23 (design 4.1 e 6.1, critérios 14 e 15): texto único do fuso. Tabela dos 16 fusos do Brasil,
// fora da tabela o IANA cru, entrada ruim vira o texto genérico; nunca lança, nunca devolve '' e
// nunca ecoa a entrada inválida. A tabela é conferida contra o tzdata (R2).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAZIL_TIME_ZONE_NAMES,
  UNKNOWN_TIME_ZONE_TEXT,
  timeZoneLabel,
  timeZoneNotice,
  withTimeZone,
} from '../../src/shared/timezone-names.js';
import { instantToLocal } from '../../src/shared/zoned-time.js';

/** Nome esperado e fuso de referência (mesma hora de parede) de cada identificador (4.1.1). */
const EXPECTED = Object.freeze({
  'America/Sao_Paulo': ['Horário de Brasília', 'America/Sao_Paulo'],
  'America/Bahia': ['Horário de Brasília', 'America/Sao_Paulo'],
  'America/Fortaleza': ['Horário de Brasília', 'America/Sao_Paulo'],
  'America/Recife': ['Horário de Brasília', 'America/Sao_Paulo'],
  'America/Maceio': ['Horário de Brasília', 'America/Sao_Paulo'],
  'America/Belem': ['Horário de Brasília', 'America/Sao_Paulo'],
  'America/Araguaina': ['Horário de Brasília', 'America/Sao_Paulo'],
  'America/Santarem': ['Horário de Brasília', 'America/Sao_Paulo'],
  'America/Manaus': ['Horário de Manaus', 'America/Manaus'],
  'America/Boa_Vista': ['Horário de Boa Vista', 'America/Manaus'],
  'America/Porto_Velho': ['Horário de Porto Velho', 'America/Manaus'],
  'America/Cuiaba': ['Horário de Cuiabá', 'America/Manaus'],
  'America/Campo_Grande': ['Horário de Campo Grande', 'America/Manaus'],
  'America/Rio_Branco': ['Horário do Acre', 'America/Rio_Branco'],
  'America/Eirunepe': ['Horário de Eirunepé', 'America/Rio_Branco'],
  'America/Noronha': ['Horário de Fernando de Noronha', 'America/Noronha'],
});

const OUTSIDE = ['Asia/Tokyo', 'UTC', 'America/Argentina/Buenos_Aires', 'America/New_York', 'Etc/GMT+3'];
const BAD = ['', null, undefined, 42, {}, [], true, '<script>', 'a/b/c/d', 'x'.repeat(10 * 1024), 'America/Sao_Paulo\n', ' America/Sao_Paulo', 'America/Sao Paulo', 'A'.repeat(65), '/America', 'America/'];

describe('tabela dos fusos do Brasil (4.1.1)', () => {
  test('16 identificadores, congelada, com os nomes esperados', () => {
    assert.ok(Object.isFrozen(BRAZIL_TIME_ZONE_NAMES));
    assert.deepEqual(Object.keys(BRAZIL_TIME_ZONE_NAMES).sort(), Object.keys(EXPECTED).sort());
    assert.equal(Object.keys(BRAZIL_TIME_ZONE_NAMES).length, 16);
    for (const [tz, [name]] of Object.entries(EXPECTED)) assert.equal(BRAZIL_TIME_ZONE_NAMES[tz], name, tz);
    // R3: "Horário de Manaus" só para Manaus; "Horário de Brasília" só para os fusos UTC-3.
    assert.deepEqual(Object.keys(BRAZIL_TIME_ZONE_NAMES).filter((tz) => BRAZIL_TIME_ZONE_NAMES[tz] === 'Horário de Manaus'), ['America/Manaus']);
  });

  test('cada identificador tem a hora de parede da referência do grupo (dia 15 de cada mês de 2026 e 2027, 12:00Z)', () => {
    const offsetsOfReference = new Map();
    for (const year of [2026, 2027]) {
      for (let month = 0; month < 12; month++) {
        const ms = Date.UTC(year, month, 15, 12, 0);
        for (const [tz, [, reference]] of Object.entries(EXPECTED)) {
          assert.equal(instantToLocal(ms, tz), instantToLocal(ms, reference), `${tz} x ${reference} em ${year}-${month + 1}-15`);
        }
        // Grupos com nomes diferentes têm horas diferentes (a tabela não junta fusos distintos).
        const key = ['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco', 'America/Noronha'].map((r) => instantToLocal(ms, r));
        offsetsOfReference.set(`${year}-${month}`, key);
        assert.equal(new Set(key).size, 4, key.join(' '));
      }
    }
    assert.equal(offsetsOfReference.size, 24);
  });
});

describe('timeZoneLabel, timeZoneNotice e withTimeZone', () => {
  test('exemplos do design', () => {
    assert.equal(timeZoneLabel('America/Sao_Paulo'), 'Horário de Brasília (America/Sao_Paulo)');
    assert.equal(timeZoneLabel('America/Manaus'), 'Horário de Manaus (America/Manaus)');
    assert.equal(timeZoneLabel('Asia/Tokyo'), 'Asia/Tokyo');
    assert.equal(timeZoneLabel(''), 'fuso do estabelecimento');
    assert.equal(timeZoneNotice('America/Sao_Paulo'), 'Horários no fuso do estabelecimento: Horário de Brasília (America/Sao_Paulo).');
    assert.equal(timeZoneNotice('Asia/Tokyo'), 'Horários no fuso do estabelecimento: Asia/Tokyo.');
    assert.equal(timeZoneNotice(null), 'Horários no fuso do estabelecimento.');
    assert.equal(withTimeZone('09:00 – 10:00', 'America/Sao_Paulo'), '09:00 – 10:00 (Horário de Brasília, America/Sao_Paulo)');
    assert.equal(withTimeZone('09:00 – 10:00', 'Asia/Tokyo'), '09:00 – 10:00 (Asia/Tokyo)');
    assert.equal(withTimeZone('09:00 – 10:00', 42), '09:00 – 10:00 (fuso do estabelecimento)');
    assert.equal(withTimeZone(undefined, 'Asia/Tokyo'), '(Asia/Tokyo)');
    assert.equal(UNKNOWN_TIME_ZONE_TEXT, 'fuso do estabelecimento');
  });

  test('a agenda passa a usar a frase com ponto final (antes timezoneLabel do agenda-controller)', () => {
    assert.equal(timeZoneNotice('America/Sao_Paulo'), 'Horários no fuso do estabelecimento: Horário de Brasília (America/Sao_Paulo).');
    assert.equal(timeZoneNotice(undefined), 'Horários no fuso do estabelecimento.');
  });

  test('cada fuso da tabela: nome e IANA, sem deslocamento (critério 15)', () => {
    for (const [tz, [name]] of Object.entries(EXPECTED)) {
      assert.equal(timeZoneLabel(tz), `${name} (${tz})`);
      assert.equal(timeZoneNotice(tz), `Horários no fuso do estabelecimento: ${name} (${tz}).`);
      assert.equal(withTimeZone('10:00', tz), `10:00 (${name}, ${tz})`);
      for (const text of [timeZoneLabel(tz), timeZoneNotice(tz), withTimeZone('10:00', tz)]) {
        assert.doesNotMatch(text, /UTC-|UTC\+|GMT/, text);
      }
    }
  });

  test('fora da tabela: o IANA cru', () => {
    for (const tz of OUTSIDE) {
      assert.equal(timeZoneLabel(tz), tz);
      assert.equal(timeZoneNotice(tz), `Horários no fuso do estabelecimento: ${tz}.`);
      assert.equal(withTimeZone('10:00', tz), `10:00 (${tz})`);
    }
  });

  test('entradas ruins: nunca lança, nunca devolve "" e nunca ecoa a entrada', () => {
    for (const bad of BAD) {
      const outputs = [timeZoneLabel(bad), timeZoneNotice(bad), withTimeZone('10:00', bad)];
      assert.deepEqual(outputs, ['fuso do estabelecimento', 'Horários no fuso do estabelecimento.', '10:00 (fuso do estabelecimento)'], String(bad).slice(0, 40));
      for (const out of outputs) {
        assert.ok(out.length > 0);
        assert.doesNotMatch(out, /UTC-|GMT|<|script/);
      }
    }
    // Herança do protótipo não conta como entrada da tabela.
    assert.equal(timeZoneLabel('constructor'), 'constructor');
    assert.equal(timeZoneLabel('toString'), 'toString');
  });

  test('a saída não depende do TZ do processo', () => {
    const saved = process.env.TZ;
    const run = () => [...Object.keys(EXPECTED), ...OUTSIDE, ...BAD].flatMap((tz) => [timeZoneLabel(tz), timeZoneNotice(tz), withTimeZone('10:00', tz)]);
    const outputs = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Manaus']) {
        process.env.TZ = tz;
        outputs.push(run());
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
    assert.deepEqual(outputs[1], outputs[0]);
    assert.deepEqual(outputs[2], outputs[0]);
  });
});
