import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toPublicManage,
  toManageLink,
  toPublicManageAvailability,
  PUBLIC_MANAGE_FIELDS,
  PUBLIC_MANAGE_AVAILABILITY_FIELDS,
} from '../../src/modules/appointments/manage.view.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BUSINESS = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  name: 'Salão da Ana', slug: 'salao-da-ana', address: 'Rua A, 10', phone: '11912345678',
  timezone: 'America/Sao_Paulo', cancellationLeadMinutes: 120,
};
const ROW = {
  id: '33333333-3333-4333-8333-333333333333', businessId: BUSINESS.id,
  professionalId: '44444444-4444-4444-8444-444444444444', customerId: '55555555-5555-4555-8555-555555555555',
  serviceId: '66666666-6666-4666-8666-666666666666', serviceName: 'Corte', durationMinutes: 60, priceCents: 5000,
  customerName: 'Carla Cliente', customerPhone: '21987654321', startsAt: '2026-11-27T13:00:00.000Z',
  endsAt: '2026-11-27T14:00:00.000Z', status: 'confirmed', createdAt: '2026-11-26T12:00:00.000Z',
  updatedAt: '2026-11-26T12:00:00.000Z', cancelledAt: null, professionalName: 'Ana Souza',
};
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const RESCHEDULE = { allowed: true, sameProfessional: true, notice: null };

function assertTree(body) {
  const F = PUBLIC_MANAGE_FIELDS;
  assert.deepEqual(Object.keys(body), F.root);
  assert.deepEqual(Object.keys(body.appointment), F.appointment);
  for (const key of ['service', 'professional', 'business']) assert.deepEqual(Object.keys(body.appointment[key]), F[key], key);
  assert.deepEqual(Object.keys(body.change), F.change);
  assert.deepEqual(Object.keys(body.change.reschedule), F.reschedule);
}

function assertPrivate(body) {
  const text = JSON.stringify(body);
  assert.equal(UUID_RE.test(text), false, 'nenhum UUID');
  assert.doesNotMatch(text, /\d{2}:\d{2}:\d{2}\.\d{3}Z/, 'nenhum instante UTC');
  for (const word of ['Carla', '21987654321', 'customer', 'ownerId', 'token']) assert.equal(text.includes(word), false, word);
}

test('confirmed dentro do prazo: árvore exata, hora local e prazo local (critérios 11 e 12)', () => {
  const body = toPublicManage({ row: ROW, business: BUSINESS, publicBaseUrl: 'https://agendafacil.app', nowMs: NOW, reschedule: RESCHEDULE });
  assertTree(body);
  assertPrivate(body);
  const { version, ...change } = body.change;
  assert.match(version, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(body.appointment, {
    start: '2026-11-27T10:00', end: '2026-11-27T11:00', weekday: 5, timezone: 'America/Sao_Paulo', status: 'confirmed',
    service: { name: 'Corte', durationMinutes: 60, durationLabel: '1 h', priceCents: 5000, priceOnRequest: false, priceLabel: 'R$ 50,00' },
    professional: { name: 'Ana Souza' },
    business: { name: 'Salão da Ana', address: 'Rua A, 10', phoneDisplay: '(11) 91234-5678', phoneHref: 'tel:+5511912345678', pageUrl: 'https://agendafacil.app/salao-da-ana' },
  });
  assert.deepEqual(change, {
    canChange: true, changeDeadline: '2026-11-27T08:00', cancellationLeadMinutes: 120,
    policy: 'Você pode cancelar ou remarcar por este link até 2 h antes do horário.',
    reschedule: { allowed: true, sameProfessional: true, notice: null, today: '2026-11-26', maxDate: '2027-02-24' },
  });
});

test('fora do prazo, cancelled, completed e sob consulta: mesmas chaves, canChange false e allowed false', () => {
  const cases = [
    { row: ROW, nowMs: Date.parse('2026-11-27T11:00:01.000Z') },
    { row: { ...ROW, status: 'cancelled', cancelledAt: '2026-11-26T12:30:00.000Z' }, nowMs: NOW },
    { row: { ...ROW, status: 'completed' }, nowMs: NOW },
    { row: { ...ROW, status: 'no_show', priceCents: null }, nowMs: NOW },
  ];
  for (const { row, nowMs } of cases) {
    const body = toPublicManage({ row, business: BUSINESS, publicBaseUrl: 'https://agendafacil.app', nowMs, reschedule: RESCHEDULE });
    assertTree(body);
    assertPrivate(body);
    assert.equal(body.change.canChange, false);
    assert.equal(body.change.reschedule.allowed, false);
  }
  const onRequest = toPublicManage({ row: { ...ROW, priceCents: null }, business: BUSINESS, publicBaseUrl: 'x', nowMs: NOW, reschedule: RESCHEDULE });
  assert.equal(onRequest.appointment.service.priceOnRequest, true);
  assert.equal(onRequest.appointment.service.priceLabel, 'Sob consulta');
});

test('a versão muda quando o agendamento é cancelado', () => {
  const a = toPublicManage({ row: ROW, business: BUSINESS, publicBaseUrl: '', nowMs: NOW, reschedule: RESCHEDULE });
  const b = toPublicManage({ row: { ...ROW, status: 'cancelled', updatedAt: '2026-11-26T12:30:00.000Z' }, business: BUSINESS, publicBaseUrl: '', nowMs: NOW, reschedule: RESCHEDULE });
  assert.notEqual(a.change.version, b.change.version);
});

test('toManageLink: url, antecedência e política', () => {
  assert.deepEqual(toManageLink({ url: 'u', business: { cancellationLeadMinutes: 0 } }), {
    url: 'u', cancellationLeadMinutes: 0, policy: 'Você pode cancelar ou remarcar por este link até o horário de início.',
  });
});

test('toPublicManageAvailability: sem professionals e horários só { start, end }', () => {
  const body = toPublicManageAvailability({
    timezone: 'America/Sao_Paulo', now: '2026-11-26T09:00', from: '2026-11-27', to: '2026-11-27', durationMinutes: 60,
    stepMinutes: 15, professionals: ['x'], truncated: false,
    days: [{ date: '2026-11-27', weekday: 5, extra: 1, slots: [{ start: '2026-11-27T10:00', end: '2026-11-27T11:00', professionals: [0] }] }],
  });
  const F = PUBLIC_MANAGE_AVAILABILITY_FIELDS;
  assert.deepEqual(Object.keys(body), F.root);
  assert.deepEqual(Object.keys(body.days[0]), F.day);
  assert.deepEqual(Object.keys(body.days[0].slots[0]), F.slot);
});
