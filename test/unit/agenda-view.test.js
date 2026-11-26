// AF-14 (design 4.3 e 6.1, critérios 6 e 17): serialização da agenda do dono.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toOwnerAgendaAppointment,
  toOwnerAgendaBlock,
  toOwnerAppointmentDetail,
  emptyAgendaDays,
  OWNER_AGENDA_FIELDS as F,
  OWNER_AGENDA_DETAIL_FIELDS as D,
} from '../../src/modules/agenda/agenda.view.js';
import { appointmentVersionOf } from '../../src/modules/appointments/manage-token.js';

const TZ = 'America/Sao_Paulo';
const NOW_MS = Date.parse('2026-11-26T12:00:00.000Z');
const keys = (o) => Object.keys(o).sort();
const sorted = (l) => [...l].sort();

const listRow = (over = {}) => ({
  id: '1b4e28ba-2fa1-4d2b-883f-0016d3cca427',
  professionalId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  professionalName: 'Ana Souza',
  professionalNameKey: 'ana souza',
  professionalRemoved: false,
  serviceName: 'Corte',
  customerName: 'Bia',
  startsAt: '2026-11-26T13:00:00.000Z',
  endsAt: '2026-11-26T14:00:00.000Z',
  status: 'confirmed',
  updatedAt: '2026-11-20T17:12:00.000Z',
  cancelledAt: null,
  cancelledBy: null,
  ...over,
});
const fullRow = (over = {}) => ({
  ...listRow(),
  businessId: 'b',
  customerId: 'c',
  serviceId: 's',
  durationMinutes: 60,
  priceCents: 5000,
  customerPhone: '11912345678',
  createdAt: '2026-11-20T17:12:00.000Z',
  ...over,
});

const noUtc = (obj) => assert.doesNotMatch(JSON.stringify(obj), /Z"/, JSON.stringify(obj));

test('item de agendamento: árvore fixa, hora local, version do AF-12, sem Z', () => {
  const item = toOwnerAgendaAppointment(listRow(), TZ);
  assert.deepEqual(keys(item), sorted(F.appointment));
  assert.deepEqual(keys(item.professional), sorted(F.professional));
  assert.equal(item.start, '2026-11-26T10:00');
  assert.equal(item.end, '2026-11-26T11:00');
  assert.equal(item.version, appointmentVersionOf(listRow()));
  assert.equal(item.cancelled, null);
  noUtc(item);
  const removed = toOwnerAgendaAppointment(listRow({ professionalRemoved: true }), TZ);
  assert.equal(removed.professional.removed, true);
  const c = toOwnerAgendaAppointment(listRow({ status: 'cancelled', cancelledAt: '2026-11-25T21:40:00.000Z', cancelledBy: 'owner' }), TZ);
  assert.deepEqual(c.cancelled, { by: 'owner', at: '2026-11-25T18:40' });
  assert.deepEqual(keys(c.cancelled), sorted(F.cancelled));
  assert.equal(toOwnerAgendaAppointment(listRow({ status: 'cancelled', cancelledAt: '2026-11-25T21:40:00.000Z' }), TZ).cancelled.by, null);
});

test('bloqueio: árvore fixa, sem startsAt/endsAt/createdAt', () => {
  const b = toOwnerAgendaBlock(
    {
      id: 'x',
      professionalId: null,
      professionalName: null,
      startsAt: '2026-11-25T03:00:00.000Z',
      endsAt: '2026-11-27T03:00:00.000Z',
      reasonKind: 'holiday',
      reasonNote: 'Feriado local',
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    TZ,
  );
  assert.deepEqual(keys(b), sorted(F.block));
  assert.deepEqual(b, { type: 'block', id: 'x', start: '2026-11-25T00:00', end: '2026-11-27T00:00', allDay: true, professional: null, reason: { kind: 'holiday', note: 'Feriado local' } });
  const p = toOwnerAgendaBlock({ id: 'y', professionalId: 'p', professionalName: 'Ana', startsAt: '2026-11-25T13:00:00.000Z', endsAt: '2026-11-25T14:00:00.000Z', reasonKind: null, reasonNote: null, createdAt: '2026-11-01T00:00:00.000Z' }, TZ);
  assert.deepEqual(keys(p.professional), sorted(F.blockProfessional));
  assert.equal(p.reason, null);
  assert.equal(p.allDay, false);
  noUtc([b, p]);
});

test('detalhe: árvore fixa, contato (snapshot e e-mail de customers), tel:, cadeia, canCancel e sob consulta', () => {
  const body = toOwnerAppointmentDetail({
    row: fullRow(),
    customer: { email: 'bia@example.com' },
    previous: { startsAt: '2026-11-25T18:00:00.000Z' },
    next: null,
    timeZone: TZ,
    nowMs: NOW_MS,
    emailEnabled: true,
  });
  assert.deepEqual(keys(body), sorted(D.root));
  const a = body.appointment;
  assert.deepEqual(keys(a), sorted(D.appointment));
  assert.deepEqual(keys(a.service), sorted(D.service));
  assert.deepEqual(keys(a.customer), sorted(D.customer));
  assert.deepEqual(a.customer, { name: 'Bia', phoneDisplay: '(11) 91234-5678', phoneHref: 'tel:+5511912345678', email: 'bia@example.com' });
  assert.deepEqual(a.rescheduledFrom, { start: '2026-11-25T15:00' });
  assert.equal(a.rescheduledTo, null);
  assert.equal(a.weekday, 4);
  assert.equal(a.createdAt, '2026-11-20T14:12');
  assert.equal(a.canCancel, true);
  assert.equal(a.service.priceLabel, 'R$ 50,00');
  assert.equal(body.now, '2026-11-26T09:00');
  assert.equal(body.emailEnabled, true);
  noUtc(body);

  const onRequest = toOwnerAppointmentDetail({ row: fullRow({ priceCents: null }), customer: undefined, timeZone: TZ, nowMs: NOW_MS, emailEnabled: false });
  assert.equal(onRequest.appointment.service.priceOnRequest, true);
  assert.equal(onRequest.appointment.service.priceLabel, 'Sob consulta');
  assert.equal(onRequest.appointment.customer.email, null);
  assert.equal(onRequest.emailEnabled, false);

  const can = (over, nowMs = NOW_MS) => toOwnerAppointmentDetail({ row: fullRow(over), customer: undefined, timeZone: TZ, nowMs, emailEnabled: true }).appointment.canCancel;
  assert.equal(can({}, Date.parse('2026-11-26T13:30:00.000Z')), true, 'em andamento');
  assert.equal(can({}, Date.parse('2026-11-26T14:00:00.000Z')), false, 'encerrado');
  assert.equal(can({ status: 'cancelled', cancelledAt: '2026-11-26T11:00:00.000Z' }), false);
  assert.equal(can({ status: 'completed' }), false);
});

test('emptyAgendaDays: counts zerados, weekday ISO', () => {
  assert.deepEqual(emptyAgendaDays(['2026-11-29', '2026-11-30']), [
    { date: '2026-11-29', weekday: 7, counts: { active: 0, cancelled: 0, rescheduled: 0 }, items: [] },
    { date: '2026-11-30', weekday: 1, counts: { active: 0, cancelled: 0, rescheduled: 0 }, items: [] },
  ]);
});
