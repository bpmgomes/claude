// AF-18 (critérios 18, 19, 23 e 24): adaptador SMTP contra um servidor SMTP FALSO em processo
// (smtp-server em 127.0.0.1, certificado de teste de test/fixtures/smtp/). Nenhum envio real.
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';
import { createSmtpTransport } from '../../src/modules/email/transports/smtp.js';
import { TransientMailError, PermanentMailError } from '../../src/modules/email/mail-transport.js';
import { buildMailMessage, messageIdOf } from '../../src/modules/email/message.js';
import { createEmailWorker } from '../../src/modules/email/email-worker.js';
import { emailTestApp, seedBusiness, FRIDAY, outboxRows } from '../helpers/email.js';
import { bookingBody, postAppointment } from '../helpers/appointments.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/smtp/', import.meta.url));
const TO = 'cliente.final@example.com';
const OUTBOX_ID = '123e4567-e89b-42d3-a456-426614174000';
const FAST = { connectionMs: 2000, greetingMs: 2000, socketMs: 2000 };
let cert;
let key;

before(async () => {
  cert = await readFile(`${FIXTURES}test-cert.pem`);
  key = await readFile(`${FIXTURES}test-key.pem`);
});

function message() {
  return buildMailMessage({
    rendered: {
      subject: 'Agendamento confirmado: Corte em 27/11, 10:00 · Salão da Ana',
      text: 'Olá, Ana,\nSeu agendamento está confirmado.',
      html: '<p>Olá, Ana,</p>',
      ics: { content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', method: 'PUBLISH' },
    },
    to: TO,
    from: { name: 'AgendaFácil', address: 'nao-responda@agendafacil.invalid' },
    messageId: messageIdOf(OUTBOX_ID, 'agendafacil.invalid'),
    date: new Date('2026-11-26T12:00:00.000Z'),
  });
}

const smtpError = (code, text) => Object.assign(new Error(text), { responseCode: code });

/**
 * Sobe um servidor falso. `hooks` sobrescreve onMailFrom/onRcptTo/onData/onAuth.
 * @returns {Promise<{ port: number, received: string[], sockets: Set<import('node:net').Socket>, close: () => Promise<void> }>}
 */
async function fakeServer({ secure = false, hooks = {}, options = {} } = {}) {
  const received = [];
  const server = new SMTPServer({
    secure,
    key,
    cert,
    logger: false,
    authOptional: true,
    onData(stream, _session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        cb();
      });
    },
    ...hooks,
    ...options,
  });
  // O cliente que recusa o certificado fecha o socket no meio do TLS: o servidor falso emite 'error'.
  server.on('error', () => {});
  const sockets = new Set();
  server.server.on('connection', (s) => sockets.add(s));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address();
  return {
    port,
    received,
    sockets,
    // Espera um pouco antes de destruir os sockets: destruir o TCP cru enquanto o TLS do servidor
    // ainda encerra um handshake recusado derruba o Node 22 com SIGSEGV (bug do runtime, não do app).
    close: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const s of sockets) if (!s.destroyed) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function transportFor(port, over = {}) {
  return createSmtpTransport({ host: '127.0.0.1', port, secure: false, ca: cert, timeouts: FAST, ...over });
}

/** Nada do servidor (endereço, resposta) no erro. */
function assertClean(err, ...secrets) {
  assert.equal(err.cause, undefined);
  for (const s of [TO, ...secrets]) {
    assert.equal(err.message.includes(s), false, s);
    assert.equal(JSON.stringify(err).includes(s), false, s);
    assert.equal(String(err.stack).includes(s), false, s);
  }
}

async function expectError(promise, check) {
  let error;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'esperava erro');
  check(error);
  return error;
}

/** Cabeçalhos desdobrados da mensagem recebida. */
const headersOf = (raw) => raw.slice(0, raw.indexOf('\r\n\r\n')).replace(/\r\n[ \t]+/g, ' ').split('\r\n');

describe('entrega com TLS obrigatório', () => {
  test('STARTTLS entrega; mensagem com um só To, sem Cc/Bcc/Reply-To, Auto-Submitted, Message-ID e assunto RFC 2047', async () => {
    const srv = await fakeServer();
    try {
      const res = await transportFor(srv.port).send(message());
      assert.equal(res.messageId, `<${OUTBOX_ID}@agendafacil.invalid>`);
      assert.equal(srv.received.length, 1);
      const headers = headersOf(srv.received[0]);
      const names = headers.map((h) => h.slice(0, h.indexOf(':')).toLowerCase());
      assert.equal(names.filter((n) => n === 'to').length, 1);
      assert.ok(headers.includes(`To: ${TO}`));
      for (const n of ['cc', 'bcc', 'reply-to']) assert.equal(names.includes(n), false, n);
      assert.ok(headers.includes('Auto-Submitted: auto-generated'));
      assert.ok(headers.includes(`Message-ID: <${OUTBOX_ID}@agendafacil.invalid>`));
      assert.match(headers.find((h) => h.startsWith('Subject:')), /=\?UTF-8\?[QB]\?/i);
    } finally {
      await srv.close();
    }
  });

  test('TLS implícito (secure) entrega', async () => {
    const srv = await fakeServer({ secure: true });
    try {
      await transportFor(srv.port, { secure: true }).send(message());
      assert.equal(srv.received.length, 1);
    } finally {
      await srv.close();
    }
  });

  test('servidor sem STARTTLS com secure=false: tls (temporária), nada entregue', async () => {
    const srv = await fakeServer({ options: { disabledCommands: ['STARTTLS'], hideSTARTTLS: true } });
    try {
      await expectError(transportFor(srv.port).send(message()), (err) => {
        assert.ok(err instanceof TransientMailError);
        assert.equal(err.code, 'tls');
        assertClean(err);
      });
      assert.equal(srv.received.length, 0);
    } finally {
      await srv.close();
    }
  });

  test('certificado não confiável (sem ca): tls, mesmo pedindo rejectUnauthorized:false e ignoreTLS (ignorados)', async () => {
    for (const secure of [false, true]) {
      const srv = await fakeServer({ secure });
      try {
        const t = createSmtpTransport({ host: '127.0.0.1', port: srv.port, secure, timeouts: FAST, rejectUnauthorized: false, ignoreTLS: true, tls: { rejectUnauthorized: false } });
        await expectError(t.send(message()), (err) => {
          assert.ok(err instanceof TransientMailError, String(err?.code));
          assert.equal(err.code, 'tls');
        });
        assert.equal(srv.received.length, 0);
      } finally {
        await srv.close();
      }
    }
  });
});

describe('classificação (tabela do design 4.3)', () => {
  const cases = [
    ['451 no MAIL FROM: smtp_4xx', { onMailFrom: (_a, _s, cb) => cb(smtpError(451, 'Tente depois cliente.final@example.com')) }, TransientMailError, 'smtp_4xx'],
    ['550 no MAIL FROM: smtp_sender (temporária)', { onMailFrom: (_a, _s, cb) => cb(smtpError(550, 'Remetente recusado')) }, TransientMailError, 'smtp_sender'],
    ['450 no RCPT: smtp_4xx', { onRcptTo: (_a, _s, cb) => cb(smtpError(450, 'Caixa ocupada cliente.final@example.com')) }, TransientMailError, 'smtp_4xx'],
    ['550 no RCPT: recipient_rejected (permanente)', { onRcptTo: (_a, _s, cb) => cb(smtpError(550, 'Usuário cliente.final@example.com não existe')) }, PermanentMailError, 'recipient_rejected'],
    [
      '554 no DATA: smtp_5xx (permanente)',
      { onData: (stream, _s, cb) => { stream.on('data', () => {}); stream.on('end', () => cb(smtpError(554, 'Conteúdo recusado'))); } },
      PermanentMailError,
      'smtp_5xx',
    ],
  ];
  for (const [name, hooks, Klass, code] of cases) {
    test(name, async () => {
      const srv = await fakeServer({ hooks });
      try {
        await expectError(transportFor(srv.port).send(message()), (err) => {
          assert.ok(err instanceof Klass, `${err?.name} ${err?.code}`);
          assert.equal(err.code, code);
          assert.equal(err.maybeDelivered, false);
          assertClean(err, 'Tente depois', 'não existe', 'Conteúdo recusado', 'Remetente recusado', 'Caixa ocupada');
        });
      } finally {
        await srv.close();
      }
    });
  }

  test('535 na autenticação: smtp_auth (temporária), sem a senha no erro', async () => {
    const PASSWORD = 'senha-de-teste-falsa-123';
    const srv = await fakeServer({ options: { authOptional: false, onAuth: (_auth, _s, cb) => cb(smtpError(535, 'Credenciais inválidas')) } });
    try {
      await expectError(transportFor(srv.port, { user: 'usuario', password: PASSWORD }).send(message()), (err) => {
        assert.ok(err instanceof TransientMailError);
        assert.equal(err.code, 'smtp_auth');
        assertClean(err, PASSWORD, 'Credenciais inválidas');
      });
    } finally {
      await srv.close();
    }
  });

  test('autenticação aceita entrega', async () => {
    const srv = await fakeServer({ options: { authOptional: false, onAuth: (auth, _s, cb) => cb(null, { user: auth.username }) } });
    try {
      await transportFor(srv.port, { user: 'usuario', password: 'senha-de-teste' }).send(message());
      assert.equal(srv.received.length, 1);
    } finally {
      await srv.close();
    }
  });

  test('servidor que não responde, com timeouts de 200 ms: timeout, sem maybeDelivered', async () => {
    const silent = createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const sockets = new Set();
    silent.on('connection', (s) => sockets.add(s));
    try {
      const t = transportFor(silent.address().port, { timeouts: { connectionMs: 200, greetingMs: 200, socketMs: 200 } });
      await expectError(t.send(message()), (err) => {
        assert.ok(err instanceof TransientMailError);
        assert.equal(err.code, 'timeout');
        assert.equal(err.maybeDelivered, false);
      });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  test('conexão recusada: network, sem maybeDelivered', async () => {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    await expectError(transportFor(port).send(message()), (err) => {
      assert.ok(err instanceof TransientMailError);
      assert.equal(err.code, 'network');
      assert.equal(err.maybeDelivered, false);
    });
  });

  test('servidor que derruba a conexão depois de receber o DATA: maybeDelivered true', async () => {
    let srv;
    srv = await fakeServer({
      hooks: {
        onData(stream) {
          stream.on('data', () => {});
          stream.on('end', () => {
            for (const s of srv.sockets) s.destroy();
          });
        },
      },
    });
    try {
      await expectError(transportFor(srv.port).send(message()), (err) => {
        assert.ok(err instanceof TransientMailError, `${err?.name} ${err?.code}`);
        assert.ok(['network', 'timeout'].includes(err.code), err.code);
        assert.equal(err.maybeDelivered, true);
        assertClean(err);
      });
    } finally {
      await srv.close();
    }
  });
});

// B3 (revisão de segurança): no teto do worker e no stop, a conexão SMTP é fechada na hora, e não
// fica pendurada até os timeouts de socket. Servidor falso lento: recebe o DATA e não responde.
describe('abortar o envio fecha a conexão (B3)', () => {
  const SLOW_TIMEOUTS = { connectionMs: 30_000, greetingMs: 30_000, socketMs: 30_000 };

  /** Servidor que engole o DATA e nunca responde; `dataSeen` resolve quando o corpo chegou. */
  async function slowServer() {
    let markData;
    const dataSeen = new Promise((resolve) => {
      markData = resolve;
    });
    const srv = await fakeServer({
      hooks: {
        onData(stream) {
          stream.on('data', () => {});
          stream.on('end', () => markData());
        },
      },
    });
    return { ...srv, dataSeen };
  }

  /** Espera todos os sockets do servidor fecharem; devolve o tempo gasto. */
  async function socketsClosed(srv, limitMs = 2000) {
    const t0 = Date.now();
    while ([...srv.sockets].some((s) => !s.destroyed && !s.closed) && Date.now() - t0 < limitMs) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return Date.now() - t0;
  }

  test('signal abortado durante o DATA: send_timeout maybeDelivered, conexão fechada logo', async () => {
    const srv = await slowServer();
    try {
      const t = transportFor(srv.port, { timeouts: SLOW_TIMEOUTS });
      const controller = new AbortController();
      const sending = t.send(message(), { signal: controller.signal });
      await srv.dataSeen;
      assert.equal(t.openConnections, 1);
      controller.abort();
      await expectError(sending, (err) => {
        assert.ok(err instanceof TransientMailError);
        assert.equal(err.code, 'send_timeout');
        assert.equal(err.maybeDelivered, true);
      });
      assert.equal(t.openConnections, 0);
      const waited = await socketsClosed(srv);
      assert.ok(waited < 1000, `socket do servidor ainda aberto depois de ${waited} ms`);
      assert.ok([...srv.sockets].every((s) => s.destroyed || s.closed));
    } finally {
      await srv.close();
    }
  });

  test('signal já abortado: nem conecta', async () => {
    const srv = await slowServer();
    try {
      const controller = new AbortController();
      controller.abort();
      await expectError(transportFor(srv.port).send(message(), { signal: controller.signal }), (err) => assert.equal(err.code, 'send_timeout'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(srv.sockets.size, 0);
    } finally {
      await srv.close();
    }
  });

  test('close() do adaptador encerra o envio pendurado', async () => {
    const srv = await slowServer();
    try {
      const t = transportFor(srv.port, { timeouts: SLOW_TIMEOUTS });
      const sending = t.send(message());
      await srv.dataSeen;
      await t.close();
      await expectError(sending, (err) => assert.ok(err instanceof TransientMailError));
      assert.ok((await socketsClosed(srv)) < 1000);
    } finally {
      await srv.close();
    }
  });

  describe('com o worker', () => {
    let app;
    let seed;
    let keepAlive;
    beforeEach(async () => {
      keepAlive = setInterval(() => {}, 20);
    });
    afterEach(async () => {
      clearInterval(keepAlive);
      if (app) await app.close();
      app = null;
    });

    async function setup(srv) {
      const transport = transportFor(srv.port, { timeouts: SLOW_TIMEOUTS });
      let clock;
      ({ app, clock } = await emailTestApp({ mailTransport: transport }));
      seed = await seedBusiness(app);
      const res = await postAppointment(app, seed.slug, bookingBody({ serviceId: seed.service.id, professionalId: seed.professionals[0].id, start: `${FRIDAY}T10:00` }));
      assert.equal(res.statusCode, 201);
      const s = app.services;
      const worker = (over = {}) =>
        createEmailWorker({
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
          ...over,
        });
      return { transport, worker };
    }

    test('teto de envio do worker (200 ms): send_timeout gravado e a conexão SMTP fechada', async () => {
      const srv = await slowServer();
      try {
        const { transport, worker } = await setup(srv);
        const summary = await worker({ sendTimeoutMs: 200 }).runOnce();
        assert.equal(summary.retried, 1);
        const [row] = await outboxRows(app.db);
        assert.equal(row.last_error_code, 'send_timeout');
        assert.ok(row.maybe_delivered_at);
        assert.equal(transport.openConnections, 0);
        assert.ok((await socketsClosed(srv)) < 1000);
      } finally {
        await srv.close();
      }
    });

    test('stop() com envio pendurado: a conexão SMTP é fechada e a linha fica sending', async () => {
      const srv = await slowServer();
      try {
        const { transport, worker } = await setup(srv);
        const w = worker({ sendTimeoutMs: 60_000 });
        const run = w.runOnce();
        await srv.dataSeen;
        const t0 = Date.now();
        await w.stop({ graceMs: 5000 });
        await run;
        assert.ok(Date.now() - t0 < 1000);
        assert.equal(transport.openConnections, 0);
        assert.ok((await socketsClosed(srv)) < 1000);
        const [row] = await outboxRows(app.db);
        assert.equal(row.status, 'sending');
      } finally {
        await srv.close();
      }
    });
  });
});
