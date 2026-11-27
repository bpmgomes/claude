// AF-03 (design 5.3 e 6.1, critérios 4, 8, 11, 13, 25, 27, 28, 30 e 31): o worker do AF-18 com os
// e-mails de conta. Token emitido no envio, só o pedido mais novo vira e-mail, descarte do token nas
// falhas, cota de conta separada, `stale`, transporte `none` e conteúdo.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signupAndLogin } from '../helpers/session.js';
import { seedBusiness, FRIDAY, drain, outboxRows } from '../helpers/email.js';
import { bookingBody } from '../helpers/appointments.js';
import { bookWithLink } from '../helpers/manage.js';
import {
  resetTestApp,
  requestReset,
  confirmReset,
  resetBody,
  resetTokenFrom,
  resetLinkFrom,
  withIp,
  mailsTo,
  REQUESTED,
  LINK_INVALID,
} from '../helpers/password-reset.js';
import { createEmailWorker } from '../../src/modules/email/email-worker.js';
import { hashResetToken } from '../../src/modules/auth/password-reset-token.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Pedido sem limite por e-mail que atrapalhe: exercita a cota do worker. */
const LOOSE_REQUESTS = {
  requestPerEmail: [{ max: 1000, windowMinutes: 60 }],
  requestPerIp: { max: 1000, windowMinutes: 60 },
  confirmPerIp: { max: 1000, windowMinutes: 15 },
};

/** Worker novo com as dependências do app e `over` por cima (mesmo banco, relógio e transporte). */
function swapWorker(app, clock, transport, over = {}) {
  const s = app.services;
  const worker = createEmailWorker({
    db: app.db,
    outbox: s.emailOutboxRepository,
    appointmentsRepository: s.appointmentsRepository,
    businessesRepository: s.businessesRepository,
    customersRepository: s.customersRepository,
    reschedulesRepository: s.reschedulesRepository,
    manageTokensRepository: s.manageTokensRepository,
    tokenIssuer: s.tokenIssuer,
    usersRepository: s.usersRepository,
    passwordResetTokensRepository: s.passwordResetTokensRepository,
    passwordResetTokenIssuer: over.passwordResetTokenIssuer,
    mailTransport: transport,
    emailConfig: app.config.email,
    publicBaseUrl: app.config.publicBaseUrl,
    enabled: false,
    intervalMs: 15_000,
    now: clock.now,
    ...over,
  });
  app.services.emailWorker = worker;
  return worker;
}

const tokens = (db) => db.all('SELECT * FROM password_reset_tokens ORDER BY created_at, rowid');
const resetRows = (db) => db.all("SELECT * FROM email_outbox WHERE kind = 'password_reset' ORDER BY created_at, rowid");

describe('emissão no envio (decisão 12, critérios 4 e 8)', () => {
  test('depois do pedido, 0 tokens; depois do envio, 1 token com expires_at = envio + 1 h; só o hash no banco', async () => {
    const { app, clock, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      assert.equal((await tokens(app.db)).length, 0);
      clock.advance(10 * MIN);
      const sentAt = clock.now().toISOString();
      const summary = await app.services.emailWorker.runOnce();
      assert.equal(summary.sent, 1);
      const [row] = await tokens(app.db);
      assert.equal(row.created_at, sentAt);
      assert.equal(row.expires_at, new Date(Date.parse(sentAt) + HOUR).toISOString());
      assert.equal(row.used_at, null);
      const token = resetTokenFrom(transport.messages[0]);
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(token, 'base64url').length, 32);
      assert.equal(row.token_hash, hashResetToken(token));
      assert.equal((await resetRows(app.db))[0].status, 'sent');
    } finally {
      await app.close();
    }
  });

  test('preparo atômico: issue que lança -> linha volta a pending sem consumir tentativa e sem token (critério 4 (b))', async () => {
    const { app, clock, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      const worker = swapWorker(app, clock, transport, {
        passwordResetTokenIssuer: {
          async issue(tx, { userId, nowIso }) {
            await tx.run("INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
              'f'.repeat(64), userId, nowIso, new Date(Date.parse(nowIso) + HOUR).toISOString(),
            ]);
            throw new Error('falha injetada');
          },
        },
      });
      const summary = await worker.runOnce();
      assert.equal(summary.errors, 1);
      const [row] = await resetRows(app.db);
      assert.deepEqual({ status: row.status, attempts: row.attempts, locked: row.locked_until }, { status: 'pending', attempts: 0, locked: null });
      assert.equal((await tokens(app.db)).length, 0);
      assert.equal(transport.messages.length, 0);
    } finally {
      await app.close();
    }
  });
});

describe('só o link mais recente vale (critério 11)', () => {
  test('dois pedidos antes do envio: o 1º skipped superseded, uma mensagem só', async () => {
    const { app, clock, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      clock.advance(1000);
      await requestReset(app, 'ana@x.com');
      await drain(app);
      const rows = await resetRows(app.db);
      assert.deepEqual(rows.map((r) => [r.status, r.last_error_code]), [['skipped', 'superseded'], ['sent', null]]);
      assert.equal(transport.messages.length, 1);
      assert.equal((await tokens(app.db)).length, 1);
    } finally {
      await app.close();
    }
  });

  test('dois pedidos no MESMO milissegundo: o desempate pelo rowid deixa só o segundo', async () => {
    const { app, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      await requestReset(app, 'ana@x.com');
      await drain(app);
      const rows = await resetRows(app.db);
      assert.deepEqual(rows.map((r) => r.status), ['skipped', 'sent']);
      assert.equal(transport.messages.length, 1);
    } finally {
      await app.close();
    }
  });

  test('pedido, envio, pedido, envio: o link 1 dá 400 e o link 2 funciona', async () => {
    const { app, clock, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      await drain(app);
      const t1 = resetTokenFrom(transport.messages[0]);
      clock.advance(MIN);
      await requestReset(app, 'ana@x.com');
      // Revisão de segurança (decisão 1): o pedido NÃO invalida o link que saiu; só a emissão do novo.
      assert.deepEqual((await tokens(app.db)).map((t) => t.token_hash), [hashResetToken(t1)]);
      assert.ok(await app.services.passwordResetTokensRepository.findUsable(hashResetToken(t1), clock.now().toISOString()));
      await drain(app);
      const t2 = resetTokenFrom(transport.messages[1]);
      assert.notEqual(t1, t2);
      const r1 = await confirmReset(app, resetBody(t1));
      assert.equal(r1.statusCode, 400);
      assert.equal(r1.json().error.message, LINK_INVALID);
      assert.equal((await confirmReset(app, resetBody(t2))).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('pedido feito antes de uma troca de senha não vira link (superseded)', async () => {
    const { app, clock } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      clock.advance(MIN);
      await app.db.run("UPDATE users SET password_changed_at = ? WHERE email = 'ana@x.com'", [clock.now().toISOString()]);
      await drain(app);
      const [row] = await resetRows(app.db);
      assert.deepEqual([row.status, row.last_error_code], ['skipped', 'superseded']);
    } finally {
      await app.close();
    }
  });
});

describe('falhas e descarte do token (critério 31)', () => {
  async function setup(behavior) {
    const ctx = await resetTestApp();
    await signupAndLogin(ctx.app, { email: 'ana@x.com' });
    ctx.worker = swapWorker(ctx.app, ctx.clock, ctx.transport, {
      passwordResetTokenIssuer: ctx.app.services.passwordResetTokenIssuer ?? undefined,
      random: () => 0,
    });
    ctx.transport.setBehavior(behavior);
    await requestReset(ctx.app, 'ana@x.com');
    return ctx;
  }

  test('temporária sem maybeDelivered apaga o token; a retentativa emite outro, que vale', async () => {
    const ctx = await setup((_m, i) => (i === 0 ? { mode: 'transient', code: 'network' } : { mode: 'ok' }));
    try {
      await ctx.worker.runOnce();
      assert.equal((await tokens(ctx.app.db)).length, 0);
      ctx.clock.advance(MIN);
      await ctx.worker.runOnce();
      assert.equal(ctx.transport.messages.length, 1);
      const live = await tokens(ctx.app.db);
      assert.equal(live.length, 1);
      assert.equal(live[0].token_hash, hashResetToken(resetTokenFrom(ctx.transport.messages[0])));
    } finally {
      await ctx.app.close();
    }
  });

  test('temporária com maybeDelivered mantém o token até a retentativa, que deixa só o novo', async () => {
    const ctx = await setup((_m, i) => (i === 0 ? { mode: 'transient', code: 'timeout', maybeDelivered: true } : { mode: 'ok' }));
    try {
      await ctx.worker.runOnce();
      const first = await tokens(ctx.app.db);
      assert.equal(first.length, 1);
      ctx.clock.advance(MIN);
      await ctx.worker.runOnce();
      const after = await tokens(ctx.app.db);
      assert.equal(after.length, 1);
      assert.notEqual(after[0].token_hash, first[0].token_hash);
      assert.equal(after[0].token_hash, hashResetToken(resetTokenFrom(ctx.transport.messages[0])));
    } finally {
      await ctx.app.close();
    }
  });

  test('permanente apaga o token; o 5º envio temporário apaga mesmo com maybeDelivered', async () => {
    const perm = await setup({ mode: 'permanent', code: 'recipient_rejected' });
    try {
      await perm.worker.runOnce();
      assert.equal((await resetRows(perm.app.db))[0].status, 'failed');
      assert.equal((await tokens(perm.app.db)).length, 0);
    } finally {
      await perm.app.close();
    }
    const temp = await setup({ mode: 'transient', code: 'timeout', maybeDelivered: true });
    try {
      for (const delay of [0, MIN, 5 * MIN, 30 * MIN, 2 * HOUR]) {
        temp.clock.advance(delay);
        const s = await temp.worker.runOnce();
        assert.equal(s.claimed, 1, `envio depois de ${delay} ms`);
      }
      const [row] = await resetRows(temp.app.db);
      assert.deepEqual([row.status, row.attempts], ['failed', 5]);
      assert.equal((await tokens(temp.app.db)).length, 0);
    } finally {
      await temp.app.close();
    }
  });

  test('render_failed não deixa token', async () => {
    const ctx = await resetTestApp();
    try {
      await signupAndLogin(ctx.app, { email: 'ana@x.com' });
      const worker = swapWorker(ctx.app, ctx.clock, ctx.transport, {
        passwordResetTokenIssuer: ctx.app.services.passwordResetTokenIssuer,
        renderAccount: () => {
          throw new Error('render');
        },
      });
      await requestReset(ctx.app, 'ana@x.com');
      await worker.runOnce();
      const [row] = await resetRows(ctx.app.db);
      assert.deepEqual([row.status, row.last_error_code], ['failed', 'render_failed']);
      assert.equal((await tokens(ctx.app.db)).length, 0);
    } finally {
      await ctx.app.close();
    }
  });

  test('sem as dependências de conta, a linha vira skipped missing (worker montado direto)', async () => {
    const ctx = await resetTestApp();
    try {
      await signupAndLogin(ctx.app, { email: 'ana@x.com' });
      const worker = swapWorker(ctx.app, ctx.clock, ctx.transport, { usersRepository: undefined, passwordResetTokenIssuer: undefined });
      await requestReset(ctx.app, 'ana@x.com');
      await worker.runOnce();
      const [row] = await resetRows(ctx.app.db);
      assert.deepEqual([row.status, row.last_error_code], ['skipped', 'missing']);
    } finally {
      await ctx.app.close();
    }
  });
});

describe('cota de conta (critério 25, decisão 5) e idade (stale)', () => {
  test('5 links em 24 h: o 6º skipped recipient_limited, resposta igual; 24 h depois sai (limite do pedido afrouxado)', async () => {
    // Com os limites padrão o 6º pedido em 24 h já para no pedido (decisão 3); aqui o pedido é
    // afrouxado para exercitar a cota do worker, que fica como defesa em profundidade.
    const { app, clock, transport } = await resetTestApp({ passwordReset: LOOSE_REQUESTS });
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      const bodies = [];
      for (let i = 0; i < 6; i++) {
        const res = await requestReset(app, 'ana@x.com', { headers: withIp(`10.5.0.${i}`) });
        bodies.push(res.body);
        await drain(app);
        clock.advance(HOUR);
      }
      assert.ok(bodies.every((b) => JSON.parse(b).message === REQUESTED));
      const rows = await resetRows(app.db);
      assert.deepEqual(rows.map((r) => r.status), ['sent', 'sent', 'sent', 'sent', 'sent', 'skipped']);
      assert.equal(rows.at(-1).last_error_code, 'recipient_limited');
      assert.equal(mailsTo(transport, 'ana@x.com').length, 5);
      clock.advance(19 * HOUR);
      await requestReset(app, 'ana@x.com', { headers: withIp('10.5.0.9') });
      await drain(app);
      assert.equal((await resetRows(app.db)).at(-1).status, 'sent');
    } finally {
      await app.close();
    }
  });

  test('pedido barrado pela cota NÃO destrói o link já recebido; só o último link enviado vale (decisão 1)', async () => {
    const { app, clock, transport } = await resetTestApp({ passwordReset: LOOSE_REQUESTS });
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      const sent = [];
      for (let i = 0; i < 5; i++) {
        await requestReset(app, 'ana@x.com', { headers: withIp(`10.7.0.${i}`) });
        await drain(app);
        sent.push(resetTokenFrom(transport.messages.at(-1)));
        clock.advance(MIN);
      }
      // Pedidos do "atacante" com a cota cheia: viram linha, o worker pula, o link 5 continua.
      for (let i = 0; i < 3; i++) {
        await requestReset(app, 'ana@x.com', { headers: withIp(`10.7.1.${i}`) });
        await drain(app);
      }
      assert.ok((await resetRows(app.db)).slice(5).every((r) => r.status === 'skipped' && r.last_error_code === 'recipient_limited'));
      assert.equal(transport.messages.length, 5);
      for (const old of sent.slice(0, 4)) assert.equal((await confirmReset(app, resetBody(old))).statusCode, 400);
      assert.deepEqual((await tokens(app.db)).filter((t) => t.used_at === null).map((t) => t.token_hash), [hashResetToken(sent[4])]);
      assert.equal((await confirmReset(app, resetBody(sent[4]))).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('password_changed é isento da cota e não a consome (decisão 2)', async () => {
    const { app, clock, transport } = await resetTestApp({ passwordReset: LOOSE_REQUESTS });
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      const changedMails = () => mailsTo(transport, 'ana@x.com').filter((m) => !resetTokenFrom(m));
      // 4 links e uma troca: o aviso sai e não conta, então o 5º link ainda sai.
      let last;
      for (let i = 0; i < 4; i++) {
        await requestReset(app, 'ana@x.com', { headers: withIp(`10.8.0.${i}`) });
        await drain(app);
        last = resetTokenFrom(transport.messages.at(-1));
        clock.advance(MIN);
      }
      assert.equal((await confirmReset(app, resetBody(last))).statusCode, 200);
      await drain(app);
      assert.equal(changedMails().length, 1);
      await requestReset(app, 'ana@x.com', { headers: withIp('10.8.1.1') });
      await drain(app);
      last = resetTokenFrom(transport.messages.at(-1));
      assert.ok(last, 'o 5º link saiu apesar do aviso');
      // Cota cheia (5 links): a troca ainda manda o aviso, um por troca.
      clock.advance(MIN);
      assert.equal((await confirmReset(app, resetBody(last))).statusCode, 200);
      await drain(app);
      assert.equal(changedMails().length, 2);
      const changed = await app.db.all("SELECT status FROM email_outbox WHERE kind = 'password_changed'");
      assert.deepEqual(changed.map((r) => r.status), ['sent', 'sent']);
      await requestReset(app, 'ana@x.com', { headers: withIp('10.8.1.2') });
      await drain(app);
      assert.deepEqual([(await resetRows(app.db)).at(-1).status, (await resetRows(app.db)).at(-1).last_error_code], ['skipped', 'recipient_limited']);
    } finally {
      await app.close();
    }
  });

  test('cotas separadas: 10 e-mails de agendamento não bloqueiam a redefinição; 5 de conta não bloqueiam o agendamento', async () => {
    const { app, clock, transport } = await resetTestApp();
    try {
      const seed = await seedBusiness(app, { email: 'dono@x.com' });
      await signupAndLogin(app, { email: 'bia@x.com' });
      const book = (target, start, email, phone) =>
        bookWithLink(app, target.slug, bookingBody({ serviceId: target.service.id, start, customer: { email, ...(phone ? { phone } : {}) } }));
      // O dono também é cliente, em 4 negócios: 12 confirmações, 10 saem e a cota de agendamento enche.
      const seeds = [seed];
      for (let b = 1; b < 4; b++) seeds.push(await seedBusiness(app, { email: `outro${b}@x.com`, name: `Negócio ${b}` }));
      let k = 0;
      for (const target of seeds) {
        for (const hour of ['09', '10', '11']) {
          await book(target, `${FRIDAY}T${hour}:00`, 'dono@x.com', `119123460${String(k++).padStart(2, '0')}`);
          await drain(app);
        }
      }
      assert.equal(mailsTo(transport, 'dono@x.com').length, 10);
      const limited = (await outboxRows(app.db)).filter((r) => r.last_error_code === 'recipient_limited');
      assert.equal(limited.length, 2);
      await requestReset(app, 'dono@x.com', { headers: withIp('10.6.0.1') });
      await drain(app);
      assert.equal(mailsTo(transport, 'dono@x.com').filter((m) => resetTokenFrom(m)).length, 1);
      // 5 e-mails de conta da Bia; a confirmação de agendamento para ela ainda sai.
      for (let i = 0; i < 5; i++) {
        await requestReset(app, 'bia@x.com', { headers: withIp(`10.6.1.${i}`) });
        await drain(app);
        clock.advance(HOUR);
      }
      assert.equal(mailsTo(transport, 'bia@x.com').length, 5);
      await book(seed, '2026-11-30T09:00', 'bia@x.com');
      await drain(app);
      assert.equal(mailsTo(transport, 'bia@x.com').length, 6);
      assert.ok(mailsTo(transport, 'bia@x.com').at(-1).subject.startsWith('Agendamento confirmado'));
    } finally {
      await app.close();
    }
  });

  test('pedido com 4 h e 1 ms no preparo: skipped stale, sem token; com 4 h exatas ainda sai', async () => {
    const { app, clock, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await signupAndLogin(app, { email: 'bia@x.com' });
      await requestReset(app, 'ana@x.com');
      clock.advance(1);
      await requestReset(app, 'bia@x.com');
      clock.advance(4 * HOUR);
      await drain(app);
      const rows = await resetRows(app.db);
      assert.deepEqual(rows.map((r) => [r.status, r.last_error_code]), [['skipped', 'stale'], ['sent', null]]);
      assert.equal(mailsTo(transport, 'ana@x.com').length, 0);
      assert.equal(mailsTo(transport, 'bia@x.com').length, 1);
    } finally {
      await app.close();
    }
  });
});

describe('conteúdo do e-mail (critérios 13 e 30)', () => {
  test('assunto, saudação, link com href, validade, aviso, rodapé, cabeçalhos e nenhum anexo', async () => {
    const { app, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com', name: 'Ana' });
      await requestReset(app, 'ana@x.com');
      await drain(app);
      const [m] = transport.messages;
      assert.equal(m.subject, 'Redefinição de senha · AgendaFácil');
      assert.equal(m.to, 'ana@x.com');
      assert.deepEqual(m.attachments, []);
      assert.deepEqual(m.headers, { 'Auto-Submitted': 'auto-generated' });
      assert.equal(m.cc, undefined);
      assert.equal(m.bcc, undefined);
      assert.equal(m.replyTo, undefined);
      const link = resetLinkFrom(m);
      assert.ok(link.startsWith('https://agendafacil.app/redefinir-senha#token='), link);
      for (const part of [m.text, m.html]) {
        assert.ok(part.includes('Olá, Ana,'));
        assert.ok(part.includes('Redefinir senha'));
        assert.ok(part.includes('Este link vale por 1 hora e só pode ser usado uma vez.'));
        assert.ok(part.includes('Se você não pediu isso, ignore este e-mail: sua senha continua a mesma.'));
        assert.ok(part.includes('Este é um e-mail automático. Não responda a esta mensagem.'));
        assert.equal(part.includes('abcd1234'), false, 'sem senha');
        assert.equal(part.includes('af_session'), false, 'sem sessão');
      }
      const hrefs = [...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]);
      assert.deepEqual(hrefs, [link]);
      assert.ok(m.text.includes(`Redefinir senha: ${link}`));
      const raw = await transport.raw(0);
      assert.match(raw, /^Auto-Submitted: auto-generated\r$/m);
      assert.doesNotMatch(raw, /^(Cc|Bcc|Reply-To):/im);
    } finally {
      await app.close();
    }
  });

  test('nome com CR/LF não vira cabeçalho; o nome é escapado no HTML', async () => {
    const { app, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await app.db.run("UPDATE users SET name = ? WHERE email = 'ana@x.com'", ['Ana\r\nBcc: x@y.com <b>']);
      await requestReset(app, 'ana@x.com');
      await drain(app);
      const raw = await transport.raw(0);
      assert.doesNotMatch(raw, /^Bcc:/im);
      assert.ok(transport.messages[0].html.includes('Ana Bcc: x@y.com &lt;b&gt;'));
    } finally {
      await app.close();
    }
  });

  test('link http com publicBaseUrl http e sem requireHttps (desenvolvimento)', async () => {
    const { app, transport } = await resetTestApp({ publicBaseUrl: 'http://localhost:3000' });
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      await drain(app);
      assert.ok(resetLinkFrom(transport.messages[0]).startsWith('http://localhost:3000/redefinir-senha#token='));
    } finally {
      await app.close();
    }
  });

  test('outbox: nenhuma coluna nova além de user_id (critério 34)', async () => {
    const { app } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      const [row] = await outboxRows(app.db);
      assert.deepEqual(Object.keys(row), [
        'id', 'business_id', 'kind', 'appointment_id', 'previous_appointment_id', 'status', 'attempts', 'next_attempt_at',
        'locked_until', 'last_error_code', 'created_at', 'updated_at', 'sent_at', 'maybe_delivered_at', 'user_id',
      ]);
    } finally {
      await app.close();
    }
  });
});
