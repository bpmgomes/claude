// AF-03 (design 5.1, 5.2 e 6.1, critérios 1 a 7, 22, 24, 26, 27 e 28): pedido do link.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { signupAndLogin } from '../helpers/session.js';
import { seedBusiness, FRIDAY, outboxRows, drain } from '../helpers/email.js';
import { bookingBody } from '../helpers/appointments.js';
import { bookWithLink } from '../helpers/manage.js';
import {
  resetTestApp,
  requestReset,
  withIp,
  responseFingerprint,
  login,
  REQUESTED,
  mailsTo,
} from '../helpers/password-reset.js';
import { createPasswordResetService } from '../../src/modules/auth/password-reset.service.js';
import { createAuthRateLimiter } from '../../src/modules/auth/auth-rate-limits.service.js';

const HOUR = 3_600_000;

async function accountRows(db) {
  return db.all("SELECT * FROM email_outbox WHERE kind = 'password_reset' ORDER BY created_at, rowid");
}

/** Troca o serviço de redefinição por um com dependências trocadas (mesmo banco e relógio). */
function swapService(app, clock, over = {}) {
  const s = app.services;
  app.services.passwordResetService = createPasswordResetService({
    db: app.db,
    usersRepository: s.usersRepository,
    passwordResetTokensRepository: s.passwordResetTokensRepository,
    sessionsRepository: s.sessionsRepository,
    loginAttemptsRepository: s.loginAttemptsRepository,
    authRateLimitsRepository: s.authRateLimitsRepository,
    rateLimiter: createAuthRateLimiter({ authRateLimitsRepository: s.authRateLimitsRepository, now: clock.now }),
    enqueueEmail: over.enqueueEmail,
    config: app.config,
    now: clock.now,
  });
}

describe('pedido do link (critérios 1 a 7)', () => {
  test('202 com o texto fixo do critério 1; uma linha password_reset com user_id; nada de rede', async () => {
    const { app, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      const res = await requestReset(app, 'ana@x.com');
      assert.equal(res.statusCode, 202);
      assert.deepEqual(res.json(), { message: REQUESTED });
      assert.match(res.headers['content-type'], /^application\/json/);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      const rows = await accountRows(app.db);
      assert.equal(rows.length, 1);
      const { id: userId } = await app.db.get("SELECT id FROM users WHERE email = 'ana@x.com'");
      assert.equal(rows[0].user_id, userId);
      assert.equal(rows[0].business_id, null);
      assert.equal(rows[0].appointment_id, null);
      assert.equal(rows[0].status, 'pending');
      // O pedido não envia nem emite token (decisão 12).
      assert.equal(transport.messages.length, 0);
      assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM password_reset_tokens')).n), 0);
    } finally {
      await app.close();
    }
  });

  test('byte a byte: existente, inexistente, cliente do AF-04, limitado por e-mail e bloqueado pelo AF-02 (critério 2)', async () => {
    const { app } = await resetTestApp();
    try {
      const seed = await seedBusiness(app, { email: 'dono@x.com' });
      const customerEmail = 'cliente.so@example.com';
      await bookWithLink(app, seed.slug, bookingBody({ serviceId: seed.service.id, start: `${FRIDAY}T10:00`, customer: { email: customerEmail } }));
      await signupAndLogin(app, { email: 'limitada@x.com' });
      await signupAndLogin(app, { email: 'bloqueada@x.com' });
      for (let i = 0; i < 5; i++) await login(app, 'bloqueada@x.com', 'errada123');
      assert.equal((await login(app, 'bloqueada@x.com', 'errada123')).statusCode, 429);
      for (let i = 0; i < 3; i++) await requestReset(app, 'limitada@x.com', { headers: withIp('10.9.9.9') });

      const prints = [];
      for (const [i, email] of ['dono@x.com', 'ninguem@x.com', customerEmail, 'limitada@x.com', 'bloqueada@x.com'].entries()) {
        const res = await requestReset(app, email, { headers: withIp(`10.0.0.${i + 1}`) });
        assert.equal(res.headers['set-cookie'], undefined, email);
        assert.equal(res.headers.location, undefined, email);
        prints.push(responseFingerprint(res));
      }
      for (const p of prints.slice(1)) assert.deepEqual(p, prints[0]);
      // Com cookie de sessão válido: a resposta não muda (rota pública, a sessão não é lida).
      const cookies = await signupAndLogin(app, { email: 'logada@x.com' });
      const withCookie = await requestReset(app, 'ninguem2@x.com', { cookies, headers: withIp('10.0.0.9') });
      assert.deepEqual(responseFingerprint(withCookie), prints[0]);
      // Só as contas de dono que não estavam limitadas viraram linha.
      const users = await app.db.all('SELECT u.email FROM email_outbox o JOIN users u ON u.id = o.user_id ORDER BY u.email');
      assert.deepEqual(users.map((u) => u.email), ['bloqueada@x.com', 'dono@x.com', 'limitada@x.com', 'limitada@x.com', 'limitada@x.com']);
    } finally {
      await app.close();
    }
  });

  test('inexistente e só cliente: 0 linhas e 0 mensagens; existente: exatamente 1 (critérios 4 e 7)', async () => {
    const { app, transport } = await resetTestApp();
    try {
      const seed = await seedBusiness(app, { email: 'dono@x.com' });
      await bookWithLink(app, seed.slug, bookingBody({ serviceId: seed.service.id, start: `${FRIDAY}T10:00`, customer: { email: 'cli@example.com' } }));
      await drain(app);
      const before = transport.messages.length;
      await requestReset(app, 'ninguem@x.com');
      await requestReset(app, 'cli@example.com');
      await drain(app);
      assert.equal((await accountRows(app.db)).length, 0);
      assert.equal(transport.messages.length, before);
      await requestReset(app, 'dono@x.com');
      await drain(app);
      assert.equal((await accountRows(app.db)).length, 1);
      assert.equal(mailsTo(transport, 'dono@x.com').filter((m) => m.subject.startsWith('Redefinição')).length, 1);
    } finally {
      await app.close();
    }
  });

  test('ROLLBACK: enqueueEmail que lança não deixa linha e o token pendente anterior continua (critério 4)', async () => {
    const { app, clock, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await requestReset(app, 'ana@x.com');
      await app.services.emailWorker.runOnce();
      assert.equal(transport.messages.length, 1);
      const tokensBefore = await app.db.all('SELECT * FROM password_reset_tokens');
      assert.equal(tokensBefore.length, 1);
      const rowsBefore = await outboxRows(app.db);
      swapService(app, clock, {
        enqueueEmail: async () => {
          throw new TypeError('falha injetada');
        },
      });
      const res = await requestReset(app, 'ana@x.com');
      assert.equal(res.statusCode, 500);
      assert.deepEqual(await outboxRows(app.db), rowsBefore);
      assert.deepEqual(await app.db.all('SELECT * FROM password_reset_tokens'), tokensBefore, 'o pedido não mexe nos tokens (decisão 1 da revisão)');
    } finally {
      await app.close();
    }
  });

  test('validação: ausente, vazio, número, "a@" e outro tipo -> 400 "Informe um e-mail válido."; normaliza (critério 5)', async () => {
    const { app } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      for (const payload of [{}, { email: '' }, { email: 42 }, { email: 'a@' }, { email: null }, { email: ['ana@x.com'] }]) {
        const res = await requestReset(app, null, { payload });
        assert.equal(res.statusCode, 400, JSON.stringify(payload));
        assert.deepEqual(res.json().error, {
          code: 'VALIDATION_ERROR',
          message: 'Verifique os campos destacados.',
          fields: { email: 'Informe um e-mail válido.' },
        });
      }
      assert.equal((await accountRows(app.db)).length, 0);
      const res = await requestReset(app, '  ANA@X.COM ');
      assert.equal(res.statusCode, 202);
      assert.equal((await accountRows(app.db)).length, 1);
    } finally {
      await app.close();
    }
  });

  test('conta bloqueada pelo AF-02 ainda pede o link (critério 6)', async () => {
    const { app } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      for (let i = 0; i < 5; i++) await login(app, 'ana@x.com', 'errada123');
      assert.equal((await login(app, 'ana@x.com')).statusCode, 429);
      assert.equal((await requestReset(app, 'ana@x.com')).statusCode, 202);
      assert.equal((await accountRows(app.db)).length, 1);
    } finally {
      await app.close();
    }
  });

  test('só JSON (415) e CSRF do AF-02 (403) (critério 26)', async () => {
    const { app } = await resetTestApp();
    try {
      for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
        const res = await requestReset(app, 'ana@x.com', { headers });
        assert.equal(res.statusCode, 403, JSON.stringify(headers));
        assert.equal(res.json().error.code, 'FORBIDDEN_ORIGIN');
      }
      const text = await app.inject({ method: 'POST', url: '/api/auth/password-reset', headers: { 'content-type': 'text/plain' }, payload: 'email=a@x.com' });
      assert.equal(text.statusCode, 415);
      const same = await requestReset(app, 'ana@x.com', { headers: { 'sec-fetch-site': 'same-origin' } });
      assert.equal(same.statusCode, 202);
    } finally {
      await app.close();
    }
  });
});

describe('limites persistidos (critérios 22 e 24)', () => {
  test('4º pedido do e-mail na hora: 202 sem linha; volta depois de 60 min', async () => {
    const { app, clock } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      for (let i = 0; i < 4; i++) {
        const res = await requestReset(app, 'ana@x.com', { headers: withIp(`10.0.1.${i}`) });
        assert.equal(res.statusCode, 202);
        assert.deepEqual(res.json(), { message: REQUESTED });
      }
      assert.equal((await accountRows(app.db)).length, 3);
      clock.advance(HOUR);
      await requestReset(app, 'ana@x.com', { headers: withIp('10.0.1.9') });
      assert.equal((await accountRows(app.db)).length, 4);
    } finally {
      await app.close();
    }
  });

  test('janela deslizante por e-mail (decisão 3): 3 no fim da hora + 3 no início da seguinte dão só 3 linhas', async () => {
    const { app, clock } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      // 1 em t0 (abriria a janela fixa), 2 em t0 + 59:59 e 3 em t0 + 60:00: a janela fixa aceitaria 6.
      await requestReset(app, 'ana@x.com', { headers: withIp('10.0.2.1') });
      clock.advance(HOUR - 1000);
      for (let i = 0; i < 2; i++) await requestReset(app, 'ana@x.com', { headers: withIp(`10.0.2.${i + 2}`) });
      clock.advance(1000);
      for (let i = 0; i < 3; i++) {
        const res = await requestReset(app, 'ana@x.com', { headers: withIp(`10.0.3.${i}`) });
        assert.deepEqual([res.statusCode, res.json()], [202, { message: REQUESTED }]);
      }
      // Na virada, só o pedido de t0 saiu da janela: entra 1, os outros 2 ficam de fora.
      assert.equal((await accountRows(app.db)).length, 4);
      // Rajada inteira na borda (sem pedido antes): 3 + 3 dão 3.
      await signupAndLogin(app, { email: 'bia@x.com' });
      for (let i = 0; i < 3; i++) await requestReset(app, 'bia@x.com', { headers: withIp(`10.0.4.${i}`) });
      clock.advance(1000);
      for (let i = 0; i < 3; i++) await requestReset(app, 'bia@x.com', { headers: withIp(`10.0.5.${i}`) });
      const bia = await app.db.all("SELECT o.id FROM email_outbox o JOIN users u ON u.id = o.user_id WHERE u.email = 'bia@x.com'");
      assert.equal(bia.length, 3);
    } finally {
      await app.close();
    }
  });

  test('5 pedidos por e-mail em 24 h (decisão 3): a cada 61 min, o 6º não vira linha; volta 24 h depois do 1º', async () => {
    const { app, clock } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      for (let i = 0; i < 6; i++) {
        assert.equal((await requestReset(app, 'ana@x.com', { headers: withIp(`10.1.0.${i}`) })).statusCode, 202);
        clock.advance(61 * 60_000);
      }
      assert.equal((await accountRows(app.db)).length, 5);
      // Agora t0 + 366 min; o 1º sai em t0 + 24 h.
      clock.advance(24 * HOUR - 366 * 60_000 - 1);
      await requestReset(app, 'ana@x.com', { headers: withIp('10.1.1.1') });
      assert.equal((await accountRows(app.db)).length, 5);
      clock.advance(1);
      await requestReset(app, 'ana@x.com', { headers: withIp('10.1.1.2') });
      assert.equal((await accountRows(app.db)).length, 6);
    } finally {
      await app.close();
    }
  });

  test('11º pedido do IP: 429 com Retry-After e corpo fixo, igual para conta existente e inexistente; corpo inválido consome', async () => {
    const { app, clock } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      const ip = withIp('203.0.113.5');
      await requestReset(app, null, { headers: ip, payload: { email: 'x' } }); // inválido: consome
      for (let i = 0; i < 9; i++) assert.equal((await requestReset(app, `p${i}@x.com`, { headers: ip })).statusCode, 202);
      clock.advance(10 * 60_000);
      const a = await requestReset(app, 'ana@x.com', { headers: ip });
      const b = await requestReset(app, 'ninguem@x.com', { headers: ip });
      const c = await requestReset(app, null, { headers: ip, payload: {} });
      for (const res of [a, b, c]) {
        assert.equal(res.statusCode, 429);
        assert.deepEqual(res.json(), { error: { code: 'RATE_LIMITED', message: 'Muitas tentativas. Tente novamente mais tarde.' } });
        assert.equal(res.headers['retry-after'], String(50 * 60));
      }
      assert.deepEqual(responseFingerprint(a), responseFingerprint(b));
      assert.equal(a.headers['x-ratelimit-limit'], undefined);
      assert.equal((await accountRows(app.db)).length, 0);
      // Outro IP segue livre; depois da janela, o mesmo IP volta.
      assert.equal((await requestReset(app, 'ana@x.com', { headers: withIp('203.0.113.6') })).statusCode, 202);
      clock.advance(50 * 60_000);
      assert.equal((await requestReset(app, 'ana@x.com', { headers: ip })).statusCode, 202);
    } finally {
      await app.close();
    }
  });

  test('IPv6 agrupado no /64 (rateLimitKey) e trustProxy respeitado', async () => {
    const { app } = await resetTestApp();
    try {
      for (let i = 0; i < 10; i++) await requestReset(app, `p${i}@x.com`, { headers: withIp(`2001:db8:1:2::${i + 1}`) });
      assert.equal((await requestReset(app, 'p@x.com', { headers: withIp('2001:db8:1:2:ffff::1') })).statusCode, 429);
      assert.equal((await requestReset(app, 'p@x.com', { headers: withIp('2001:db8:1:3::1') })).statusCode, 202);
    } finally {
      await app.close();
    }
  });

  test('os limites valem com rateLimit.enabled = false (padrão dos testes) e sobrevivem a reinício (critério 24)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af03-persist-'));
    try {
      const databasePath = join(dir, 'db.sqlite');
      const first = await resetTestApp({ databasePath });
      await signupAndLogin(first.app, { email: 'ana@x.com' });
      assert.equal(first.app.config.rateLimit.enabled, false);
      for (let i = 0; i < 3; i++) await requestReset(first.app, 'ana@x.com', { headers: withIp(`10.2.0.${i}`) });
      await first.app.close();
      const second = await resetTestApp({ databasePath });
      try {
        assert.equal((await requestReset(second.app, 'ana@x.com', { headers: withIp('10.2.0.9') })).statusCode, 202);
        assert.equal((await accountRows(second.app.db)).length, 3);
      } finally {
        await second.app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('20 pedidos simultâneos para o mesmo e-mail enfileiram no máximo 3 (5 rodadas)', async () => {
    for (let round = 0; round < 5; round++) {
      const { app } = await resetTestApp();
      try {
        await signupAndLogin(app, { email: 'ana@x.com' });
        const all = await Promise.all(
          Array.from({ length: 20 }, (_, i) => requestReset(app, 'ana@x.com', { headers: withIp(`10.3.${round}.${i}`) })),
        );
        assert.ok(all.every((r) => r.statusCode === 202));
        assert.equal((await accountRows(app.db)).length, 3, `rodada ${round}`);
        // No mesmo tick, direto no serviço (o inject espaça as requisições em tarefas separadas).
        await signupAndLogin(app, { email: 'bia@x.com' });
        const direct = await Promise.all(
          Array.from({ length: 20 }, (_, i) => app.services.passwordResetService.request({ email: 'bia@x.com' }, { ip: `10.4.${round}.${i}` })),
        );
        assert.ok(direct.every((r) => r.accepted));
        const bia = await app.db.all("SELECT o.id FROM email_outbox o JOIN users u ON u.id = o.user_id WHERE u.email = 'bia@x.com'");
        assert.equal(bia.length, 3, `rodada ${round} (serviço)`);
      } finally {
        await app.close();
      }
    }
  });
});

describe('tempo e transporte (critérios 3, 27 e 28)', () => {
  test('mediana de "existe" e "não existe" difere menos de 50 ms (30 amostras intercaladas)', async () => {
    // Transporte que trava: a requisição não espera o envio (nada de rede na requisição).
    const stuck = { messages: [], send: () => new Promise(() => {}), close: async () => {} };
    const { app } = await resetTestApp({
      mailTransport: stuck,
      passwordReset: {
        requestPerEmail: [{ max: 1000, windowMinutes: 60 }],
        requestPerIp: { max: 1000, windowMinutes: 60 },
        confirmPerIp: { max: 1000, windowMinutes: 15 },
      },
    });
    try {
      const N = 30;
      for (let i = 0; i < N; i++) await signupAndLogin(app, { email: `conta${i}@x.com` });
      // Aquecimento.
      for (let i = 0; i < 5; i++) {
        await requestReset(app, `aquece${i}@x.com`);
        await requestReset(app, `conta${i}@x.com`);
      }
      const timeOf = async (email) => {
        const t0 = performance.now();
        const res = await requestReset(app, email);
        const ms = performance.now() - t0;
        assert.equal(res.statusCode, 202);
        return ms;
      };
      const exists = [];
      const missing = [];
      for (let i = 0; i < N; i++) {
        exists.push(await timeOf(`conta${i}@x.com`));
        missing.push(await timeOf(`fantasma${i}@x.com`));
      }
      const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const diff = Math.abs(median(exists) - median(missing));
      assert.ok(diff < 50, `diferença de mediana ${diff.toFixed(2)} ms`);
      assert.ok(median(exists) < 1000, 'a requisição não espera o transporte');
    } finally {
      await app.close();
    }
  });

  test('transporte none (email.enabled = false): 202 igual, linha gravada, worker não envia; aviso no boot', async () => {
    const { buildTestApp } = await import('../helpers/test-app.js');
    const { app, logs } = await buildTestApp({ trustProxy: true });
    try {
      assert.equal(app.config.email.enabled, false);
      assert.equal(app.config.email.transport, 'none');
      await signupAndLogin(app, { email: 'ana@x.com' });
      const a = await requestReset(app, 'ana@x.com', { headers: withIp('10.4.0.1') });
      const b = await requestReset(app, 'ninguem@x.com', { headers: withIp('10.4.0.2') });
      assert.equal(a.statusCode, 202);
      assert.deepEqual(responseFingerprint(a), responseFingerprint(b));
      assert.equal((await accountRows(app.db)).length, 1);
      const summary = await app.services.emailWorker.runOnce();
      assert.equal(summary.claimed, 0);
      const warns = logs().split('\n').filter((l) => l.includes('"email_transport_not_configured"'));
      assert.equal(warns.length, 1);
    } finally {
      await app.close();
    }
  });
});
