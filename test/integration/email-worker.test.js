// AF-18 (critérios 7 a 11, 14 a 21, 26, 27, 29 e 32): worker de envio com relógio injetável e o
// adaptador de memória.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  emailTestApp, seedBusiness, FRIDAY, outboxRows, drain, linkFrom, tokenFrom, icsOf, parseIcs, logEntries,
} from '../helpers/email.js';
import { bookingBody, postAppointment, insertAppointmentDirect } from '../helpers/appointments.js';
import { bookWithLink, cancelManage, rescheduleManage, versionOf, getManage, tokensOf, everyColumnText } from '../helpers/manage.js';
import { createEmailWorker } from '../../src/modules/email/email-worker.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { EMAIL_RETRY_DELAYS_MS } from '../../src/modules/email/email-rules.js';
import { hashManageToken } from '../../src/modules/appointments/manage-token.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

let app;
let logs;
let clock;
let transport;
let seed;

const body = (over = {}) => bookingBody({ serviceId: seed.service.id, professionalId: seed.professionals[0].id, start: `${FRIDAY}T10:00`, ...over });
const reserve = (over = {}, opts) => bookWithLink(app, seed.slug, body(over), opts);

/** Worker próprio sobre os serviços do app, com `random` e relógio controlados. */
function makeWorker(over = {}) {
  const s = app.services;
  return createEmailWorker({
    db: app.db,
    outbox: s.emailOutboxRepository,
    appointmentsRepository: s.appointmentsRepository,
    businessesRepository: s.businessesRepository,
    customersRepository: s.customersRepository,
    reschedulesRepository: s.reschedulesRepository,
    manageTokensRepository: s.manageTokensRepository,
    tokenIssuer: s.tokenIssuer,
    mailTransport: transport,
    emailConfig: app.config.email,
    publicBaseUrl: app.config.publicBaseUrl,
    enabled: false,
    intervalMs: 1000,
    now: clock.now,
    random: () => 0,
    log: app.log,
    ...over,
  });
}

const rowOf = async (kind = 'appointment_confirmed') => (await outboxRows(app.db, { kind }))[0];
const nowMs = () => clock.now().getTime();
const iso = (ms) => new Date(ms).toISOString();

beforeEach(async () => {
  ({ app, logs, clock, transport } = await emailTestApp());
  seed = await seedBusiness(app);
});
afterEach(() => app.close());

describe('transições (critérios 8 e 9)', () => {
  test('sucesso: sent, sent_at, attempts 1, last_error_code nulo; summary', async () => {
    await reserve();
    const summary = await app.services.emailWorker.runOnce();
    assert.equal(summary.claimed, 1);
    assert.equal(summary.sent, 1);
    const row = await rowOf();
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 1);
    assert.equal(row.sent_at, clock.now().toISOString());
    assert.equal(row.locked_until, null);
    assert.equal(row.last_error_code, null);
    assert.equal(transport.messages.length, 1);
    assert.equal((await app.services.emailWorker.runOnce()).claimed, 0, 'nada a reenviar');
  });

  test('temporária 4 vezes com os atrasos exatos (random 0) e failed no 5º envio', async () => {
    await reserve();
    transport.setBehavior({ mode: 'transient', code: 'network' });
    const worker = makeWorker();
    for (let k = 1; k <= 4; k++) {
      const before = nowMs();
      const s = await worker.runOnce();
      assert.equal(s.retried, 1, `tentativa ${k}`);
      const row = await rowOf();
      assert.equal(row.status, 'pending');
      assert.equal(row.attempts, k);
      assert.equal(row.last_error_code, 'network');
      assert.equal(row.next_attempt_at, iso(before + EMAIL_RETRY_DELAYS_MS[k - 1]));
      clock.advance(EMAIL_RETRY_DELAYS_MS[k - 1] - 1);
      assert.equal((await worker.runOnce()).claimed, 0, 'antes do atraso');
      clock.advance(1);
    }
    const s = await worker.runOnce();
    assert.equal(s.failed, 1);
    const row = await rowOf();
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 5);
    assert.equal(row.last_error_code, 'network');
    assert.equal(transport.calls, 5);
    clock.advance(DAY);
    assert.equal((await worker.runOnce()).claimed, 0);
  });

  test('jitter: random 0,999 fica abaixo de 1,2 × o nominal', async () => {
    await reserve();
    transport.setBehavior({ mode: 'transient', code: 'timeout' });
    const before = nowMs();
    await makeWorker({ random: () => 0.999 }).runOnce();
    const delay = Date.parse((await rowOf()).next_attempt_at) - before;
    assert.ok(delay > MIN && delay < 1.2 * MIN, String(delay));
  });

  test('permanente vai direto a failed, sem retry', async () => {
    await reserve();
    transport.setBehavior({ mode: 'permanent', code: 'recipient_rejected' });
    assert.equal((await makeWorker().runOnce()).failed, 1);
    const row = await rowOf();
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error_code, 'recipient_rejected');
  });

  test('erro desconhecido e exceção síncrona do adaptador viram unknown temporária', async () => {
    await reserve();
    transport.setBehavior({ mode: 'throwSync' });
    await makeWorker().runOnce();
    assert.equal((await rowOf()).last_error_code, 'unknown');
    clock.advance(EMAIL_RETRY_DELAYS_MS[0]);
    transport.setBehavior({ mode: 'reject' });
    await makeWorker().runOnce();
    const row = await rowOf();
    assert.equal(row.last_error_code, 'unknown');
    assert.equal(row.attempts, 2);
  });

  test('teto rígido de envio: send_timeout (maybeDelivered), token mantido', async () => {
    const { token: successToken } = await reserve();
    transport.setBehavior({ mode: 'hang' });
    // O teto de envio tem unref (não segura o processo): o teste segura o event loop.
    const keepAlive = setInterval(() => {}, 10);
    const s = await makeWorker({ sendTimeoutMs: 30 }).runOnce().finally(() => clearInterval(keepAlive));
    assert.equal(s.retried, 1);
    assert.equal(transport.aborts, 1, 'o worker aborta o envio no teto (B3)');
    const row = await rowOf();
    assert.equal(row.last_error_code, 'send_timeout');
    assert.ok(row.maybe_delivered_at, 'conta no teto por destinatário (B2)');
    const tokens = await tokensOf(app.db, row.appointment_id);
    assert.equal(tokens.length, 2, 'o token do envio pode ter chegado: fica');
    assert.ok(tokens.some((t) => t.token_hash === hashManageToken(successToken)));
  });

  test('recuperação de queda: sending com arrendamento vencido volta e consome uma tentativa; com 5, lease_expired', async () => {
    await reserve();
    const row = await rowOf();
    await app.db.run("UPDATE email_outbox SET status = 'sending', attempts = 2, locked_until = ? WHERE id = ?", [iso(nowMs() + 5 * MIN), row.id]);
    assert.equal((await makeWorker().runOnce()).claimed, 0, 'arrendamento vivo');
    clock.advance(5 * MIN);
    assert.equal((await makeWorker().runOnce()).sent, 1);
    const after = await rowOf();
    assert.equal(after.attempts, 3);
    assert.equal(after.status, 'sent');

    const { token: _t } = await reserve({ start: `${FRIDAY}T13:00` });
    const second = (await outboxRows(app.db, { kind: 'appointment_confirmed' }))[1];
    await app.db.run("UPDATE email_outbox SET status = 'sending', attempts = 5, locked_until = ? WHERE id = ?", [iso(nowMs() - 1), second.id]);
    const s = await makeWorker().runOnce();
    assert.equal(s.failed, 1);
    const failed = (await outboxRows(app.db, { id: second.id }))[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.last_error_code, 'lease_expired');
  });

  test('pending com 7 dias e 1 ms vira expired; com 7 dias menos 1 ms não', async () => {
    await reserve();
    const row = await rowOf();
    const created = Date.parse(row.created_at);
    transport.setBehavior({ mode: 'transient' });
    // Deixa a linha pendente no futuro para não ser enviada.
    await app.db.run('UPDATE email_outbox SET next_attempt_at = ? WHERE id = ?', [iso(created + 30 * DAY), row.id]);
    clock.advance(created + 7 * DAY - 1 - nowMs());
    assert.equal((await makeWorker().runOnce()).expired, 0);
    assert.equal((await rowOf()).status, 'pending');
    clock.advance(2);
    assert.equal((await makeWorker().runOnce()).expired, 1);
    const after = await rowOf();
    assert.equal(after.status, 'expired');
    assert.equal(after.last_error_code, 'expired');
  });
});

describe('reavaliação no envio (critério 10)', () => {
  test('confirmed depois de cancelar vira not_confirmed e o de cancelamento sai', async () => {
    const { token } = await reserve();
    assert.equal((await cancelManage(app, token, { version: await versionOf(app, token) })).statusCode, 200);
    await drain(app);
    assert.equal((await rowOf('appointment_confirmed')).status, 'skipped');
    assert.equal((await rowOf('appointment_confirmed')).last_error_code, 'not_confirmed');
    assert.equal((await rowOf('appointment_cancelled')).status, 'sent');
    assert.equal(transport.messages.length, 1);
    assert.match(transport.messages[0].subject, /^Agendamento cancelado/);
  });

  test('confirmed depois de remarcar e rescheduled de uma remarcação já remarcada viram not_confirmed', async () => {
    const { token } = await reserve();
    let res = await rescheduleManage(app, token, { start: `${FRIDAY}T11:00`, version: await versionOf(app, token) });
    res = await rescheduleManage(app, token, { start: `${FRIDAY}T14:00`, version: res.json().change.version });
    assert.equal(res.statusCode, 200);
    await drain(app);
    const rows = await outboxRows(app.db);
    assert.deepEqual(rows.map((r) => [r.kind, r.status, r.last_error_code]), [
      ['appointment_confirmed', 'skipped', 'not_confirmed'],
      ['appointment_rescheduled', 'skipped', 'not_confirmed'],
      ['appointment_rescheduled', 'sent', null],
    ]);
  });

  test('ended para os três tipos', async () => {
    const { token: t1 } = await reserve();
    const { token: t2 } = await reserve({ start: `${FRIDAY}T13:00` });
    const { token: t3 } = await reserve({ start: `${FRIDAY}T15:00` });
    await cancelManage(app, t2, { version: await versionOf(app, t2) });
    await rescheduleManage(app, t3, { start: `${FRIDAY}T16:00`, version: await versionOf(app, t3) });
    assert.ok(t1);
    clock.advance(2 * DAY);
    await drain(app);
    const rows = await outboxRows(app.db);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.status === 'skipped' && ['ended', 'not_confirmed'].includes(r.last_error_code)), JSON.stringify(rows));
    assert.ok(rows.some((r) => r.kind === 'appointment_cancelled' && r.last_error_code === 'ended'));
    assert.ok(rows.some((r) => r.kind === 'appointment_rescheduled' && r.last_error_code === 'ended'));
    assert.equal(transport.messages.length, 0);
  });

  test('cliente ausente: missing', async () => {
    await reserve();
    const row = await rowOf();
    const appt = await app.db.get('SELECT customer_id FROM appointments WHERE id = ?', [row.appointment_id]);
    await app.db.exec('PRAGMA foreign_keys = OFF');
    await app.db.run('DELETE FROM customers WHERE id = ?', [appt.customer_id]);
    await app.db.exec('PRAGMA foreign_keys = ON');
    await drain(app);
    assert.equal((await rowOf()).last_error_code, 'missing');
  });
});

describe('token no e-mail sem guardar token (critério 11)', () => {
  test('envio de confirmed cria um token novo; o link abre o gerenciar; o da tela de sucesso continua valendo', async () => {
    const { token: successToken } = await reserve();
    const row = await rowOf();
    assert.equal((await tokensOf(app.db, row.appointment_id)).length, 1);
    await drain(app);
    const message = transport.messages[0];
    const mailToken = tokenFrom(message);
    assert.ok(mailToken);
    assert.notEqual(mailToken, successToken);
    assert.equal(linkFrom(message), `https://agendafacil.app/agendamento/${mailToken}`);
    assert.equal((await tokensOf(app.db, row.appointment_id)).length, 2);
    for (const t of [mailToken, successToken]) {
      const res = await getManage(app, t);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().appointment.status, 'confirmed');
    }
    const expires = (await tokensOf(app.db, row.appointment_id)).map((t) => t.expires_at);
    const appt = await app.db.get('SELECT ends_at FROM appointments WHERE id = ?', [row.appointment_id]);
    assert.ok(expires.every((e) => e === appt.ends_at));
  });

  test('cancelled não cria token; o e-mail aponta para a página pública', async () => {
    const { token } = await reserve();
    await cancelManage(app, token, { version: await versionOf(app, token) });
    const row = await rowOf('appointment_cancelled');
    const before = (await tokensOf(app.db, row.appointment_id)).length;
    await drain(app);
    assert.equal((await tokensOf(app.db, row.appointment_id)).length, before);
    const message = transport.messages.at(-1);
    assert.equal(linkFrom(message), null);
    assert.ok(message.text.includes(`https://agendafacil.app/${seed.slug}`));
  });

  test('falha temporária sem maybeDelivered apaga o token do envio; com maybeDelivered mantém', async () => {
    await reserve();
    const row = await rowOf();
    transport.setBehavior({ mode: 'transient', code: 'network', maybeDelivered: false });
    await makeWorker().runOnce();
    assert.equal((await tokensOf(app.db, row.appointment_id)).length, 1, 'apagado');
    clock.advance(EMAIL_RETRY_DELAYS_MS[0]);
    transport.setBehavior({ mode: 'transient', code: 'network', maybeDelivered: true });
    await makeWorker().runOnce();
    assert.equal((await tokensOf(app.db, row.appointment_id)).length, 2, 'mantido');
    clock.advance(EMAIL_RETRY_DELAYS_MS[1]);
    transport.setBehavior({ mode: 'permanent', code: 'smtp_5xx' });
    await makeWorker().runOnce();
    assert.equal((await tokensOf(app.db, row.appointment_id)).length, 2, 'permanente apaga o seu');
  });

  test('teto de 5 vivos: reserva + 4 repetições + envio deixa 5, e o mais antigo dá 404 uniforme (relógio fixo)', async () => {
    const key = randomUUID();
    const b = body();
    const links = [];
    for (let i = 0; i < 5; i++) {
      const res = await postAppointment(app, seed.slug, b, { headers: { 'idempotency-key': key } });
      assert.equal(res.statusCode, 201);
      links.push(res.json().manage.url.split('/').pop());
    }
    const row = await rowOf();
    assert.equal((await tokensOf(app.db, row.appointment_id)).length, 5);
    await drain(app);
    assert.equal((await tokensOf(app.db, row.appointment_id)).length, 5);
    const oldest = await getManage(app, links[0]);
    assert.equal(oldest.statusCode, 404);
    assert.equal(oldest.json().error.message, 'Link inválido ou expirado.');
    for (const t of [...links.slice(1), tokenFrom(transport.messages[0])]) assert.equal((await getManage(app, t)).statusCode, 200);
  });

  test('a repetição idempotente também aplica o teto (6ª chamada remove o mais antigo)', async () => {
    const key = randomUUID();
    const b = body();
    const links = [];
    for (let i = 0; i < 6; i++) {
      links.push((await postAppointment(app, seed.slug, b, { headers: { 'idempotency-key': key } })).json().manage.url.split('/').pop());
      clock.advance(1);
    }
    assert.equal((await tokensOf(app.db, (await rowOf()).appointment_id)).length, 5);
    assert.equal((await getManage(app, links[0])).statusCode, 404);
    assert.equal((await getManage(app, links[1])).statusCode, 200);
  });

  test('nada em claro: depois de sucesso, retry e falha, nenhuma tabela nem log contém o token', async () => {
    await reserve();
    await reserve({ start: `${FRIDAY}T13:00` });
    await reserve({ start: `${FRIDAY}T15:00` });
    transport.setBehavior((_m, i) => (i === 0 ? { mode: 'ok' } : i === 1 ? { mode: 'transient', maybeDelivered: true } : { mode: 'permanent' }));
    await makeWorker().runOnce();
    // retry com maybeDelivered: o token fica no banco só como hash; os e-mails têm os textos puros.
    transport.setBehavior({ mode: 'ok' });
    clock.advance(EMAIL_RETRY_DELAYS_MS[0]);
    await makeWorker().runOnce();
    const tokens = transport.messages.map(tokenFrom);
    assert.equal(tokens.length, 2);
    const all = `${await everyColumnText(app.db)}\n${logs()}`;
    for (const t of tokens) {
      assert.ok(t);
      assert.equal(all.includes(t), false);
    }
  });
});

describe('destinatário e cabeçalhos (critérios 18 e 19)', () => {
  test('nome com CR/LF (snapshot) não vai para cabeçalho; vai escapado/literal no corpo', async () => {
    await reserve();
    const row = await rowOf();
    await app.db.run('UPDATE appointments SET customer_name = ? WHERE id = ?', ['Ana\r\nBcc: x@y.com', row.appointment_id]);
    await drain(app);
    const raw = await transport.raw(0);
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    assert.equal(/^Bcc:/im.test(head), false);
    assert.equal(head.includes('x@y.com'), false);
    assert.equal(/^Cc:/im.test(head), false);
    assert.equal(/^Reply-To:/im.test(head), false);
  });

  test('e-mail inseguro inserido direto em customers vira failed invalid_header sem chamar send nem emitir token', async () => {
    const bad = ['ana%0d%0abcc@example.com', 'ana@example.com\r\nBcc: x@y.com', '<ana>@example.com', '"ana"@example.com', 'joão@example.com'];
    for (let i = 0; i < bad.length; i++) {
      await reserve({ start: `${FRIDAY}T${String(10 + i + (i >= 2 ? 1 : 0)).padStart(2, '0')}:00`, customer: { phone: `1191234567${i}` } });
    }
    const rows = await outboxRows(app.db);
    for (const [i, row] of rows.entries()) {
      const appt = await app.db.get('SELECT customer_id FROM appointments WHERE id = ?', [row.appointment_id]);
      await app.db.run('UPDATE customers SET email = ? WHERE id = ?', [bad[i], appt.customer_id]);
    }
    await drain(app);
    assert.equal(transport.calls, 0);
    for (const row of await outboxRows(app.db)) {
      assert.equal(row.status, 'failed');
      assert.equal(row.last_error_code, 'invalid_header');
      assert.equal(row.attempts, 1);
      assert.equal((await tokensOf(app.db, row.appointment_id)).length, 1, 'só o da reserva');
    }
  });

  test('From da configuração, um To, Auto-Submitted e Message-ID <id@domínio>; igual em duas tentativas, diferente entre linhas', async () => {
    await reserve();
    await reserve({ start: `${FRIDAY}T13:00` });
    transport.setBehavior((_m, i) => (i === 0 ? { mode: 'transient' } : { mode: 'ok' }));
    await makeWorker().runOnce();
    clock.advance(EMAIL_RETRY_DELAYS_MS[0]);
    await makeWorker().runOnce();
    const rows = await outboxRows(app.db);
    const [m1, m2] = transport.messages;
    assert.deepEqual(m1.from, { name: 'AgendaFácil', address: 'nao-responda@agendafacil.invalid' });
    assert.deepEqual(m1.headers, { 'Auto-Submitted': 'auto-generated' });
    const ids = new Set(rows.map((r) => `<${r.id}@agendafacil.invalid>`));
    assert.ok(ids.has(m1.messageId) && ids.has(m2.messageId));
    assert.notEqual(m1.messageId, m2.messageId);
    // A primeira linha falhou na 1ª tentativa e saiu na 2ª, com o mesmo Message-ID.
    const retried = rows.find((r) => r.attempts === 2);
    assert.equal(transport.messages.filter((m) => m.messageId === `<${retried.id}@agendafacil.invalid>`).length, 1);
  });
});

describe('conteúdo e .ics na cadeia (critérios 14, 17 e 21)', () => {
  test('confirmação, remarcação e cancelamento com o mesmo UID e SEQUENCE 0, 1 e 2', async () => {
    const { token } = await reserve();
    await drain(app);
    const res = await rescheduleManage(app, token, { start: `${FRIDAY}T14:00`, professionalId: seed.professionals[1].id, version: await versionOf(app, token) });
    assert.equal(res.statusCode, 200);
    await drain(app);
    const t2 = tokenFrom(transport.messages[1]);
    await cancelManage(app, t2, { version: await versionOf(app, t2) });
    await drain(app);
    const [conf, resc, canc] = transport.messages;
    assert.match(conf.subject, /^Agendamento confirmado: Corte em 27\/11, 10:00 · Salão da Ana$/);
    assert.match(resc.subject, /^Agendamento remarcado: Corte para 27\/11, 14:00/);
    assert.ok(resc.text.includes('Antes: sexta-feira, 27/11/2026, das 10:00 às 11:00'));
    assert.ok(resc.text.includes('Agora: sexta-feira, 27/11/2026, das 14:00 às 15:00'));
    assert.ok(resc.text.includes('Profissional: Bia Lima (antes: Ana Souza)'));
    assert.ok(resc.text.includes('Você ainda pode remarcar online mais 2 vezes.'));
    assert.ok(conf.text.includes('Olá, Ana Souza,'));
    assert.ok(conf.text.includes('Você pode cancelar ou remarcar por este link até 2 h antes do horário.'));
    const [i1, i2, i3] = [conf, resc, canc].map((m) => parseIcs(icsOf(m)));
    assert.equal(i1.get('UID'), i2.get('UID'));
    assert.equal(i1.get('UID'), i3.get('UID'));
    assert.deepEqual([i1, i2, i3].map((i) => i.get('SEQUENCE')), ['0', '1', '2']);
    assert.equal(i3.get('METHOD'), 'CANCEL');
    // Cadeias diferentes, UIDs diferentes.
    await reserve({ start: `${FRIDAY}T16:00` });
    await drain(app);
    assert.notEqual(parseIcs(icsOf(transport.messages.at(-1))).get('UID'), i1.get('UID'));
  });

  test('política com a antecedência ATUAL do negócio (mudada entre a reserva e o envio)', async () => {
    await reserve();
    await app.db.run('UPDATE businesses SET cancellation_lead_minutes = 1440 WHERE id = ?', [seed.business.id]);
    await drain(app);
    assert.ok(transport.messages[0].text.includes('até 24 h antes do horário'));
  });
});

describe('teto por destinatário (critério 27)', () => {
  async function seedSent(email, sentAtMs) {
    const other = await seedBusiness(app, { email: `dono-${randomUUID()}@x.com`, name: `Outro ${randomUUID().slice(0, 6)}` });
    for (const [i, biz] of [seed, other].entries()) {
      const customerId = randomUUID();
      await app.db.run(
        "INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at) VALUES (?, ?, 'Cliente', '11912345678', ?, ?, ?)",
        [customerId, biz.business.id, email, iso(nowMs()), iso(nowMs())],
      ).catch(async () => {});
      const cid = (await app.db.get('SELECT id FROM customers WHERE business_id = ? AND email = ?', [biz.business.id, email])).id;
      for (let k = 0; k < 5; k++) {
        // No passado: não contam no limite de futuros do AF-11; o teto de e-mail só olha a fila.
        const startsAt = `2026-11-${String(10 + k).padStart(2, '0')}T${String(12 + i).padStart(2, '0')}:00:00.000Z`;
        const aid = await insertAppointmentDirect(app.db, { businessId: biz.business.id, professionalId: biz.professionals[0].id, customerId: cid, serviceId: biz.service.id, startsAt });
        const sentAt = iso(sentAtMs);
        await app.db.run(
          `INSERT INTO email_outbox (id, business_id, kind, appointment_id, status, attempts, next_attempt_at, created_at, updated_at, sent_at)
           VALUES (?, ?, 'appointment_confirmed', ?, 'sent', 1, ?, ?, ?, ?)`,
          [randomUUID(), biz.business.id, aid, sentAt, sentAt, sentAt, sentAt],
        );
      }
    }
  }

  test('10 sent em 24 h em dois negócios: o 11º vira recipient_limited e o agendamento segue confirmed', async () => {
    const email = 'alvo@example.com';
    await seedSent(email, nowMs() - 23 * HOUR);
    await reserve({ customer: { email } });
    await drain(app);
    const row = (await outboxRows(app.db)).at(-1);
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_code, 'recipient_limited');
    assert.equal((await app.db.get('SELECT status FROM appointments WHERE id = ?', [row.appointment_id])).status, 'confirmed');
    assert.equal(transport.calls, 0);
  });

  test('B2: 10 tentativas que podem ter sido entregues (timeout depois do envelope) contam: a 11ª linha é recipient_limited', async () => {
    const email = 'talvez-entregue@example.com';
    const customerId = randomUUID();
    await app.db.run(
      "INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at) VALUES (?, ?, 'Cliente', '11912345678', ?, ?, ?)",
      [customerId, seed.business.id, email, iso(nowMs()), iso(nowMs())],
    );
    await app.db.transaction(async (tx) => {
      for (let i = 0; i < 11; i++) {
        // Direto no banco (fora do limite de 3 futuros do AF-11), todos no futuro.
        const startsAt = new Date(Date.parse('2026-12-07T12:00:00.000Z') + i * HOUR).toISOString();
        const id = await insertAppointmentDirect(tx, { businessId: seed.business.id, professionalId: seed.professionals[i % 2].id, customerId, serviceId: seed.service.id, startsAt });
        await enqueueEmail(tx, { kind: 'appointment_confirmed', businessId: seed.business.id, appointmentId: id, nowIso: iso(nowMs()) });
      }
    });
    transport.setBehavior((_m, index) => (index < 10 ? { mode: 'transient', code: 'timeout', maybeDelivered: true } : { mode: 'ok' }));
    const first = await makeWorker().runOnce();
    assert.equal(first.retried, 10);
    const second = await makeWorker().runOnce();
    assert.equal(second.skipped, 1);
    assert.equal(transport.calls, 10, 'a 11ª não chega ao transporte');
    const rows = await outboxRows(app.db);
    assert.equal(rows.filter((r) => r.maybe_delivered_at !== null).length, 10);
    assert.deepEqual(rows.filter((r) => r.status === 'skipped').map((r) => r.last_error_code), ['recipient_limited']);
  });

  test('B2: falha temporária SEM maybeDelivered não conta no teto', async () => {
    const email = 'nao-entregue@example.com';
    const customerId = randomUUID();
    await app.db.run(
      "INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at) VALUES (?, ?, 'Cliente', '11912345678', ?, ?, ?)",
      [customerId, seed.business.id, email, iso(nowMs()), iso(nowMs())],
    );
    await app.db.transaction(async (tx) => {
      for (let i = 0; i < 11; i++) {
        const startsAt = new Date(Date.parse('2026-12-07T12:00:00.000Z') + i * HOUR).toISOString();
        const id = await insertAppointmentDirect(tx, { businessId: seed.business.id, professionalId: seed.professionals[i % 2].id, customerId, serviceId: seed.service.id, startsAt });
        await enqueueEmail(tx, { kind: 'appointment_confirmed', businessId: seed.business.id, appointmentId: id, nowIso: iso(nowMs()) });
      }
    });
    transport.setBehavior((_m, index) => (index < 10 ? { mode: 'transient', code: 'network', maybeDelivered: false } : { mode: 'ok' }));
    await makeWorker().runOnce();
    const second = await makeWorker().runOnce();
    assert.equal(second.sent, 1);
    assert.equal(transport.messages.length, 1);
  });

  test('os mesmos 10, enviados há 25 h, não bloqueiam', async () => {
    const email = 'alvo2@example.com';
    await seedSent(email, nowMs() - 25 * HOUR);
    await reserve({ customer: { email } });
    await drain(app);
    assert.equal((await outboxRows(app.db)).at(-1).status, 'sent');
    assert.equal(transport.messages.length, 1);
  });
});

describe('isolamento entre negócios (critério 29)', () => {
  test('dois negócios, mesmo horário, clientes diferentes: cada mensagem só tem dados do seu negócio', async () => {
    const other = await seedBusiness(app, { email: 'bia@x.com', name: 'Barbearia do Zé', serviceName: 'Barba Completa', professionals: ['Zé Navalha'] });
    await reserve({ customer: { name: 'Cliente Alfa', email: 'alfa@example.com' } });
    await bookWithLink(app, other.slug, bookingBody({ serviceId: other.service.id, professionalId: other.professionals[0].id, start: `${FRIDAY}T10:00`, customer: { name: 'Cliente Beta', email: 'beta@example.com' } }));
    await drain(app);
    const byTo = Object.fromEntries(transport.messages.map((m) => [m.to, m]));
    const a = byTo['alfa@example.com'];
    const b = byTo['beta@example.com'];
    assert.ok(a && b);
    const all = (m) => [m.subject, m.text, m.html, icsOf(m)].join('\n');
    for (const forbidden of ['Barbearia do Zé', 'Barba Completa', 'Zé Navalha', 'Cliente Beta', other.slug]) assert.equal(all(a).includes(forbidden), false, forbidden);
    for (const forbidden of ['Salão da Ana', 'Ana Souza', 'Cliente Alfa', seed.slug]) assert.equal(all(b).includes(forbidden), false, forbidden);
  });
});

describe('logs (critério 26)', () => {
  const ALLOWED = {
    email_enqueued: ['outboxId', 'kind'],
    email_sent: ['outboxId', 'kind', 'attempt'],
    email_retry: ['outboxId', 'kind', 'attempt', 'errCode', 'errName'],
    email_failed: ['outboxId', 'kind', 'attempt', 'errCode', 'errName'],
    email_skipped: ['outboxId', 'kind', 'errCode'],
    email_transport_misconfigured: ['errCode', 'errName'],
  };
  const BASE_KEYS = ['level', 'time', 'pid', 'hostname', 'event', 'msg'];

  test('sucesso, retry, falha, skip, invalid_header e configuração: só as chaves permitidas, nada pessoal', async () => {
    const r1 = await reserve({ customer: { name: 'Nome Secreto', email: 'secreto@example.com' } });
    await reserve({ start: `${FRIDAY}T13:00`, customer: { email: 'outro.secreto@example.com', phone: '11912340001' } });
    await reserve({ start: `${FRIDAY}T15:00`, customer: { phone: '11912340002' } });
    const third = (await outboxRows(app.db))[2];
    const appt = await app.db.get('SELECT customer_id FROM appointments WHERE id = ?', [third.appointment_id]);
    await app.db.run("UPDATE customers SET email = 'x%y@example.com' WHERE id = ?", [appt.customer_id]);
    transport.setBehavior((_m, i) => [{ mode: 'ok' }, { mode: 'transient', code: 'smtp_auth' }][i] ?? { mode: 'permanent' });
    await app.services.emailWorker.runOnce();
    await cancelManage(app, r1.token, { version: await versionOf(app, r1.token) });
    clock.advance(3 * DAY);
    await app.services.emailWorker.runOnce();
    const entries = logEntries(logs).filter((e) => typeof e.event === 'string' && e.event.startsWith('email_'));
    const events = new Set(entries.map((e) => e.event));
    for (const ev of ['email_enqueued', 'email_sent', 'email_retry', 'email_failed', 'email_skipped', 'email_transport_misconfigured']) {
      assert.ok(events.has(ev), ev);
    }
    for (const e of entries) {
      if (!ALLOWED[e.event]) continue;
      const own = Object.keys(e).filter((k) => !BASE_KEYS.includes(k)).sort();
      assert.deepEqual(own, [...ALLOWED[e.event]].sort(), JSON.stringify(e));
    }
    assert.ok(entries.find((e) => e.event === 'email_transport_misconfigured').level >= 50, 'nível error');
    const text = logs();
    for (const forbidden of ['Nome Secreto', 'secreto@example.com', 'x%y@example.com', 'Agendamento confirmado', '/agendamento/', 'Salão da Ana']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
    // Os logs de e-mail também não levam businessId nem appointmentId (os do AF-11/AF-12 levam ids).
    const emailText = JSON.stringify(entries);
    const appointmentIds = (await outboxRows(app.db)).map((r) => r.appointment_id);
    for (const id of [seed.business.id, ...appointmentIds]) assert.equal(emailText.includes(id), false, id);
    for (const m of transport.messages) assert.equal(text.includes(tokenFrom(m) ?? '§'), false);
  });
});

describe('purga por ciclo (critério 10)', () => {
  test('cada ciclo apaga um lote de 100 terminais com mais de 30 dias', async () => {
    const { insertCustomerDirect } = await import('../helpers/appointments.js');
    const customerId = await insertCustomerDirect(app.db, seed.business.id);
    const old = iso(nowMs() - 31 * DAY);
    await app.db.transaction(async (tx) => {
      for (let i = 0; i < 150; i++) {
        const aid = await insertAppointmentDirect(tx, {
          businessId: seed.business.id, professionalId: seed.professionals[0].id, customerId, serviceId: seed.service.id,
          startsAt: iso(Date.parse('2027-01-04T00:00:00.000Z') + i * HOUR),
        });
        await tx.run(
          `INSERT INTO email_outbox (id, business_id, kind, appointment_id, status, attempts, next_attempt_at, created_at, updated_at, last_error_code)
           VALUES (?, ?, 'appointment_confirmed', ?, 'failed', 5, ?, ?, ?, 'network')`,
          [randomUUID(), seed.business.id, aid, old, old, old],
        );
      }
    });
    await app.services.emailWorker.runOnce();
    assert.equal((await outboxRows(app.db)).length, 50);
    await app.services.emailWorker.runOnce();
    assert.equal((await outboxRows(app.db)).length, 0);
  });
});
