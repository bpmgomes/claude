// AF-14 (design 5.5 e 6.1, critérios 25 a 28): o e-mail do cancelamento pelo dono no worker do AF-18.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { agendaApp, secondBusiness, bookReal, cancelAgenda, agendaVersionOf, spUtc } from '../helpers/agenda.js';
import { randomUUID } from 'node:crypto';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { rescheduleManage, versionOf, tokensOf } from '../helpers/manage.js';
import { drain, outboxRows, icsOf, parseIcs, linkFrom } from '../helpers/email.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { EMAIL_MESSAGES as EM } from '../../src/modules/email/email-messages.js';

const FRI = '2026-11-27';
let ctx;
let transport;

const ownerCancel = async (c, id) =>
  cancelAgenda(c.app, c.cookies, id, { version: await agendaVersionOf(c.app, c.business.id, id) });
const ownerRow = async (id) => (await outboxRows(ctx.app.db, { appointment_id: id, kind: 'appointment_cancelled_by_owner' }))[0];
const byOwnerMails = (to) => transport.messages.filter((m) => m.to === to && m.subject.startsWith('Agendamento cancelado pelo estabelecimento'));

beforeEach(async () => {
  transport = createMemoryMailTransport();
  ctx = await agendaApp({ mailTransport: transport, email: { worker: { enabled: true, intervalMs: 15_000 } } });
});
afterEach(() => ctx.app.close());

describe('e-mail appointment_cancelled_by_owner (critérios 25 a 27)', () => {
  test('sent: assunto, introdução, horário com fuso, serviço, profissional, telefone, pageUrl, notYouCancelled; sem link nem token; .ics CANCEL com o UID da confirmação', async () => {
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    await drain(ctx.app);
    const confirmation = transport.messages.find((m) => m.to === b.customer.email);
    const confirmationIcs = parseIcs(icsOf(confirmation));
    const tokensBefore = await tokensOf(ctx.app.db, b.id);
    assert.equal((await ownerCancel(ctx, b.id)).statusCode, 200);
    await drain(ctx.app);
    assert.equal((await ownerRow(b.id)).status, 'sent');
    const [mail] = byOwnerMails(b.customer.email);
    assert.ok(mail, 'e-mail enviado');
    assert.equal(mail.subject, 'Agendamento cancelado pelo estabelecimento: Corte em 27/11, 10:00 · Salão da Ana');
    for (const text of [mail.text, mail.html]) {
      assert.ok(text.includes(EM.introCancelledByOwner));
      assert.ok(text.includes(EM.notYouCancelled));
      assert.ok(text.includes('Horários no fuso do estabelecimento: Horário de Brasília (America/Sao_Paulo).'));
      assert.ok(text.includes('Corte'));
      assert.ok(text.includes('Ana Souza'));
      assert.ok(text.includes('(11) 91234-5678'));
      assert.ok(text.includes(`https://agendafacil.app/${ctx.business.slug}`));
      assert.ok(!text.includes('/agendamento/'), 'sem link de gerenciar');
      assert.ok(!text.includes(EM.manageLink));
      assert.ok(!text.includes(b.customer.phone.replace(/\D/g, '')), 'sem telefone do cliente');
    }
    assert.equal(linkFrom(mail), null);
    assert.ok(mail.text.indexOf(EM.notYouCancelled) < mail.text.indexOf(EM.footer));
    // Nenhum token emitido no envio do cancelamento (só a revogação).
    const after = await tokensOf(ctx.app.db, b.id);
    assert.deepEqual(after.map((t) => t.token_hash), tokensBefore.map((t) => t.token_hash));
    const ics = parseIcs(icsOf(mail));
    assert.equal(ics.get('METHOD'), 'CANCEL');
    assert.equal(ics.get('STATUS'), 'CANCELLED');
    assert.equal(ics.get('UID'), confirmationIcs.get('UID'));
    assert.equal(ics.get('SEQUENCE'), '1');
    const raw = icsOf(mail);
    assert.ok(!raw.includes(b.customer.email) && !raw.includes(b.customer.phone.replace(/\D/g, '')));
  });

  test('no 2º elo de uma cadeia: mesmo UID da raiz e SEQUENCE = posição + 1', async () => {
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    await drain(ctx.app);
    assert.equal((await rescheduleManage(ctx.app, b.token, { start: `${FRI}T11:00`, version: await versionOf(ctx.app, b.token) })).statusCode, 200);
    const nextId = (await ctx.app.db.get('SELECT appointment_id FROM appointment_reschedules WHERE previous_appointment_id = ?', [b.id])).appointment_id;
    await drain(ctx.app);
    const rootUid = parseIcs(icsOf(transport.messages.find((m) => m.to === b.customer.email && m.subject.startsWith('Agendamento confirmado')))).get('UID');
    assert.equal((await ownerCancel(ctx, nextId)).statusCode, 200);
    await drain(ctx.app);
    const ics = parseIcs(icsOf(byOwnerMails(b.customer.email)[0]));
    assert.equal(ics.get('UID'), rootUid);
    assert.equal(ics.get('SEQUENCE'), '2');
  });

  test('not_cancelled (linha com A confirmed) e ended (cancelado em andamento, envio depois do fim)', async () => {
    const a = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    await drain(ctx.app);
    await ctx.app.db.transaction((tx) => enqueueEmail(tx, { kind: 'appointment_cancelled_by_owner', businessId: ctx.business.id, appointmentId: a.id, nowIso: '2026-11-26T12:00:00.000Z' }));
    await drain(ctx.app);
    assert.deepEqual([(await ownerRow(a.id)).status, (await ownerRow(a.id)).last_error_code], ['skipped', 'not_cancelled']);

    const customerId = (await ctx.app.db.get('SELECT customer_id FROM appointments WHERE id = ?', [a.id])).customer_id;
    const ongoing = await insertAppointmentDirect(ctx.app.db, {
      businessId: ctx.business.id, professionalId: ctx.pros[1].id, customerId, serviceId: ctx.service.id, startsAt: spUtc('2026-11-26T08:30'),
    });
    assert.equal((await ownerCancel(ctx, ongoing)).statusCode, 200);
    ctx.clock.advance(31 * 60_000); // passa do fim (09:30)
    await drain(ctx.app);
    assert.deepEqual([(await ownerRow(ongoing)).status, (await ownerRow(ongoing)).last_error_code], ['skipped', 'ended']);
  });

  test('recipient_limited: 10 enviados ao mesmo e-mail em dois negócios nas últimas 24 h', async () => {
    const other = await secondBusiness(ctx.app);
    const email = 'limite@example.com';
    const target = await bookReal(ctx.app, ctx, { start: `${FRI}T16:00`, customer: { name: 'Limite', phone: '(11) 92000-0001', email } });
    await drain(ctx.app); // a confirmação dele conta como 1
    const otherCustomer = await insertCustomerDirect(ctx.app.db, other.business.id, { email });
    for (let i = 0; i < 9; i++) {
      const id = await insertAppointmentDirect(ctx.app.db, {
        businessId: other.business.id, professionalId: other.pros[0].id, customerId: otherCustomer, serviceId: other.service.id,
        startsAt: new Date(Date.parse('2026-11-30T12:00:00.000Z') + i * 3_600_000).toISOString(),
      });
      await ctx.app.db.run(
        `INSERT INTO "email_outbox" (id, business_id, kind, appointment_id, status, attempts, next_attempt_at, created_at, updated_at, sent_at)
         VALUES (?, ?, 'appointment_confirmed', ?, 'sent', 1, ?, ?, ?, ?)`,
        [randomUUID(), other.business.id, id, '2026-11-26T11:00:00.000Z', '2026-11-26T11:00:00.000Z', '2026-11-26T11:00:00.000Z', '2026-11-26T11:00:00.000Z'],
      );
    }
    assert.equal((await ownerCancel(ctx, target.id)).statusCode, 200);
    await drain(ctx.app);
    assert.deepEqual([(await ownerRow(target.id)).status, (await ownerRow(target.id)).last_error_code], ['skipped', 'recipient_limited']);
    assert.equal(byOwnerMails(email).length, 0);
  });
});

describe('confirmação pendente (critério 28)', () => {
  test('appointment_confirmed pendente vira not_confirmed e só o do dono sai', async () => {
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    assert.equal((await ownerCancel(ctx, b.id)).statusCode, 200);
    await drain(ctx.app);
    const rows = await outboxRows(ctx.app.db, { appointment_id: b.id });
    assert.deepEqual(rows.map((r) => [r.kind, r.status, r.last_error_code]).sort(), [
      ['appointment_cancelled_by_owner', 'sent', null],
      ['appointment_confirmed', 'skipped', 'not_confirmed'],
    ]);
    assert.deepEqual(transport.messages.filter((m) => m.to === b.customer.email).map((m) => m.subject.split(':')[0]), ['Agendamento cancelado pelo estabelecimento']);
  });
});
