// AF-18 (critérios 20 a 22): gerador mínimo de .ics.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, icsUidOf, escapeIcsText, foldLine, icsUtc, ICS_PRODID } from '../../src/modules/calendar/ics.js';
import { parseIcs, unescapeIcsText } from '../helpers/email.js';

const ROOT = '6f1c2d3e-4a5b-4c6d-8e7f-901234567890';
const BASE = 'https://agendafacil.app';

function sample(over = {}) {
  return buildIcs({
    method: 'PUBLISH',
    uid: icsUidOf(ROOT, BASE),
    sequence: 0,
    dtstampMs: Date.parse('2026-11-26T12:00:00.000Z'),
    startMs: Date.parse('2026-11-27T13:00:00.000Z'),
    endMs: Date.parse('2026-11-27T14:00:00.000Z'),
    summary: 'Corte - Salão da Ana',
    location: 'Rua A, 10',
    description: 'Profissional: Ana Souza\nTelefone: (11) 91234-5678',
    status: 'CONFIRMED',
    ...over,
  });
}

describe('buildIcs', () => {
  test('campos obrigatórios, na ordem, com CRLF; DTSTART/DTEND em UTC sem VTIMEZONE', () => {
    const text = sample();
    const ics = parseIcs(text);
    assert.deepEqual(
      ics.lines.map((l) => l.name),
      ['BEGIN', 'VERSION', 'PRODID', 'CALSCALE', 'METHOD', 'BEGIN', 'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SEQUENCE', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'STATUS', 'END', 'END'],
    );
    assert.deepEqual(ics.all('BEGIN'), ['VCALENDAR', 'VEVENT']);
    assert.equal(ics.get('VERSION'), '2.0');
    assert.equal(ics.get('PRODID'), ICS_PRODID);
    assert.equal(ics.get('CALSCALE'), 'GREGORIAN');
    assert.equal(ics.get('METHOD'), 'PUBLISH');
    assert.equal(ics.get('DTSTART'), '20261127T130000Z');
    assert.equal(ics.get('DTEND'), '20261127T140000Z');
    assert.equal(ics.get('DTSTAMP'), '20261126T120000Z');
    assert.equal(ics.get('SEQUENCE'), '0');
    assert.equal(ics.get('STATUS'), 'CONFIRMED');
    assert.equal(text.includes('VTIMEZONE'), false);
    assert.equal(text.includes('TZID'), false);
    assert.ok(text.split('\r\n').slice(0, -1).every((l) => !l.includes('\n')));
  });

  test('escape de \\ ; , e quebra; controles removidos; valor original recuperável', () => {
    const value = 'a\\b;c,d\ne\r\nf\u0000g\u2028h';
    assert.equal(escapeIcsText(value), 'a\\\\b\\;c\\,d\\ne\\nfg\\nh');
    const ics = parseIcs(sample({ summary: value, location: 'Rua; 1, sala\\2' }));
    assert.equal(unescapeIcsText(ics.get('SUMMARY')), 'a\\b;c,d\ne\nfg\nh');
    assert.equal(unescapeIcsText(ics.get('LOCATION')), 'Rua; 1, sala\\2');
  });

  test('dobra em 75 octetos sem partir caractere UTF-8, com acentos e emoji', () => {
    const long = `${'Ação 💇‍♀️ çãé '.repeat(20)}fim`;
    const text = sample({ summary: long, description: long });
    const ics = parseIcs(text); // recusa linha física acima de 75 octetos
    assert.equal(unescapeIcsText(ics.get('SUMMARY')), long);
    for (const line of text.split('\r\n')) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
      assert.equal(Buffer.from(line, 'utf8').toString('utf8'), line, 'sem caractere partido');
      assert.equal(line.includes('\uFFFD'), false);
    }
    const folded = foldLine('X'.repeat(200));
    assert.deepEqual(folded.split('\r\n').map((l) => l.length), [75, 75, 52]);
  });

  test('METHOD:CANCEL com STATUS:CANCELLED e SEQUENCE maior', () => {
    const ics = parseIcs(sample({ method: 'CANCEL', status: 'CANCELLED', sequence: 1 }));
    assert.equal(ics.get('METHOD'), 'CANCEL');
    assert.equal(ics.get('STATUS'), 'CANCELLED');
    assert.equal(ics.get('SEQUENCE'), '1');
  });

  test('proibidos: ATTENDEE, ORGANIZER, URL, mailto, token e dados do cliente', () => {
    const token = 'T'.repeat(43);
    const text = sample();
    for (const forbidden of ['ATTENDEE', 'ORGANIZER', 'URL:', 'mailto:', token, 'cliente@example.com', 'Cliente Final', '11987654321', 'agendamento/']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });

  test('domínio fora: method, status, sequence e uid inválidos lançam', () => {
    assert.throws(() => sample({ method: 'REQUEST' }), TypeError);
    assert.throws(() => sample({ status: 'TENTATIVE' }), TypeError);
    assert.throws(() => sample({ sequence: -1 }), TypeError);
    assert.throws(() => sample({ uid: ROOT }), TypeError);
  });

  test('icsUtc formata em UTC com Z', () => {
    assert.equal(icsUtc(Date.parse('2026-01-02T03:04:05.678Z')), '20260102T030405Z');
  });
});

describe('icsUidOf (critério 21)', () => {
  test('64 hex + @ + host, igual para a mesma raiz e diferente entre raízes, sem o UUID', () => {
    const a = icsUidOf(ROOT, BASE);
    assert.match(a, /^[0-9a-f]{64}@agendafacil\.app$/);
    assert.equal(icsUidOf(ROOT, `${BASE}`), a);
    assert.notEqual(icsUidOf('7f1c2d3e-4a5b-4c6d-8e7f-901234567890', BASE), a);
    assert.equal(a.includes(ROOT), false);
    assert.match(icsUidOf(ROOT, 'http://127.0.0.1:3000'), /@127\.0\.0\.1$/);
  });
});
