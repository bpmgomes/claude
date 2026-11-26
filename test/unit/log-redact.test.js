import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactLogUrl } from '../../src/http/log-redact.js';
import { serializeRequestForLog, REDACT_PATHS } from '../../src/app.js';

const T = `${'a'.repeat(40)}_-Z`;

test('redactLogUrl: página e API do gerenciar perdem o token e a query (critério 10)', () => {
  const cases = [
    [`/agendamento/${T}`, '/agendamento/[REDACTED]'],
    [`/agendamento/${T}?x=1`, '/agendamento/[REDACTED]'],
    [`/api/public/manage/${T}`, '/api/public/manage/[REDACTED]'],
    [`/api/public/manage/${T}/cancel`, '/api/public/manage/[REDACTED]/cancel'],
    [`/api/public/manage/${T}/availability?date=2026-11-27`, '/api/public/manage/[REDACTED]/availability'],
    [`/%61gendamento/${T}`, '/agendamento/[REDACTED]'],
    [`/AGENDAMENTO/${T}`, '/AGENDAMENTO/[REDACTED]'],
    [`//agendamento/${T}`, '/agendamento/[REDACTED]'],
    [`/api/public/manage/%E0%A4%A`, '[REDACTED]'],
    ['/salao-da-ana', '/salao-da-ana'],
    ['/api/public/salao/availability?serviceId=x', '/api/public/salao/availability'],
    ['/agendamento', '/agendamento'],
    // QA D1: `%2F` dentro do segmento do token não deixa pedaço do token no log.
    [`/agendamento/x%2F${T}`, '/agendamento/[REDACTED]'],
    [`/agendamento/x%2f${T}%2Fy`, '/agendamento/[REDACTED]'],
    [`/agendamento%2F${T}`, '/agendamento/[REDACTED]'],
    [`/api/public/manage/x%2F${T}`, '/api/public/manage/[REDACTED]'],
    [`/api/public/manage/x%2F${T}/cancel`, '/api/public/manage/[REDACTED]/cancel'],
    [`/api/public/manage/${T}%2Fx/reschedule`, '/api/public/manage/[REDACTED]/reschedule'],
    [`/api/public/manage/${T}/x%2F${T}`, '/api/public/manage/[REDACTED]'],
    [`/api/public/manage/${T}/availability/${T}`, '/api/public/manage/[REDACTED]'],
    [`/api%2Fpublic%2Fmanage%2F${T}%2Favailability`, '/api/public/manage/[REDACTED]/availability'],
    [`/API/PUBLIC/MANAGE/${T}/CANCEL`, '/API/PUBLIC/MANAGE/[REDACTED]/cancel'],
    ['/api/public/manage/cancel', '/api/public/manage/[REDACTED]'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactLogUrl(input), expected, input);
    assert.equal(redactLogUrl(input).includes(T), false);
  }
});

test('serializador req: a forma do padrão do Fastify, com a URL redigida (R13)', () => {
  const out = serializeRequestForLog({ method: 'GET', url: `/agendamento/${T}`, host: 'h', ip: '1.2.3.4', socket: { remotePort: 9 } });
  assert.deepEqual(out, { method: 'GET', url: '/agendamento/[REDACTED]', host: 'h', remoteAddress: '1.2.3.4', remotePort: 9 });
});

test('REDACT_PATHS cobre token, tokenHash, token_hash e manageUrl em 4 níveis', () => {
  for (const key of ['token', 'tokenHash', 'token_hash', 'manageUrl']) {
    for (const path of [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]) assert.ok(REDACT_PATHS.includes(path), path);
  }
});
