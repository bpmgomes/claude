import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPublicAppointment, PUBLIC_APPOINTMENT_FIELDS } from '../../src/modules/appointments/appointments.view.js';

const BUSINESS = { id: 'b-id', ownerId: 'o', name: 'Salão da Ana', address: 'Rua A, 10', phone: '11912345678', slug: 'x' };
const booked = (service) => ({
  appointmentId: 'a-id',
  professional: { id: 'p-id', name: 'Ana Souza' },
  service: { serviceId: 's-id', name: 'Corte', durationMinutes: 60, ...service },
  startsAt: '2026-11-27T13:00:00.000Z',
  endsAt: '2026-11-27T14:00:00.000Z',
  start: '2026-11-27T10:00',
  end: '2026-11-27T11:00',
  weekday: 5,
  customerId: 'c-id',
  customerName: 'Cliente',
});

/**
 * Confere recursivamente a árvore de chaves contra PUBLIC_APPOINTMENT_FIELDS. Desde o AF-12, a raiz do
 * 201 é `appointment` e `manage`, mas `toPublicAppointment` devolve só `{ appointment }` (o corpo
 * guardado na idempotência, sem token; o serviço acrescenta `manage`).
 */
function assertTree(body) {
  assert.deepEqual(PUBLIC_APPOINTMENT_FIELDS.root, ['appointment', 'manage']);
  assert.deepEqual(PUBLIC_APPOINTMENT_FIELDS.manage, ['url', 'cancellationLeadMinutes', 'policy']);
  assert.deepEqual(Object.keys(body), ['appointment']);
  const { appointment } = body;
  assert.deepEqual(Object.keys(appointment), PUBLIC_APPOINTMENT_FIELDS.appointment);
  for (const key of ['service', 'professional', 'business']) {
    assert.deepEqual(Object.keys(appointment[key]), PUBLIC_APPOINTMENT_FIELDS[key], key);
  }
}

test('toPublicAppointment: árvore exata com preço (critério 26)', () => {
  const body = toPublicAppointment({ booked: booked({ priceCents: 5000, priceOnRequest: false }), business: BUSINESS, timezone: 'America/Sao_Paulo' });
  assertTree(body);
  assert.deepEqual(body.appointment, {
    start: '2026-11-27T10:00',
    end: '2026-11-27T11:00',
    weekday: 5,
    timezone: 'America/Sao_Paulo',
    service: { name: 'Corte', durationMinutes: 60, durationLabel: '1 h', priceCents: 5000, priceOnRequest: false, priceLabel: 'R$ 50,00' },
    professional: { name: 'Ana Souza' },
    business: { name: 'Salão da Ana', address: 'Rua A, 10', phoneDisplay: '(11) 91234-5678', phoneHref: 'tel:+5511912345678' },
  });
});

test('toPublicAppointment: "sob consulta" com as mesmas chaves', () => {
  const body = toPublicAppointment({ booked: booked({ priceCents: null, priceOnRequest: true }), business: BUSINESS, timezone: 'UTC' });
  assertTree(body);
  assert.equal(body.appointment.service.priceCents, null);
  assert.equal(body.appointment.service.priceOnRequest, true);
  assert.equal(body.appointment.service.priceLabel, 'Sob consulta');
});

test('não há id, customerId, professionalId, serviceId, businessId, startsAt nem dado do cliente', () => {
  const text = JSON.stringify(toPublicAppointment({ booked: booked({ priceCents: 1, priceOnRequest: false }), business: BUSINESS, timezone: 'UTC' }));
  for (const word of ['a-id', 'c-id', 'p-id', 's-id', 'b-id', 'startsAt', 'endsAt', '13:00:00', 'Cliente', 'customer', '"id"']) {
    assert.equal(text.includes(word), false, word);
  }
});
