// AF-03 (design 5.4, 5.5, 5.6 e 6.1, critérios 9, 10, 12, 14 a 21, 23, 26 e 32): redefinição.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { signupAndLogin, createBusinessFor, setBusinessTimezone, TEST_PASSWORD, tokenFrom as sessionTokenFrom } from '../helpers/session.js';
import { drain, outboxRows } from '../helpers/email.js';
import {
  resetTestApp,
  requestReset,
  confirmReset,
  resetBody,
  requestAndSend,
  withIp,
  login,
  responseFingerprint,
  mailsTo,
  LINK_INVALID,
  NEW_PASSWORD,
} from '../helpers/password-reset.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { verifyPassword } from '../../src/modules/auth/password.js';
import { createPasswordResetService } from '../../src/modules/auth/password-reset.service.js';
import { createAuthRateLimiter } from '../../src/modules/auth/auth-rate-limits.service.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { InvalidCredentialsError } from '../../src/http/errors.js';
import { MESSAGES } from '../../src/shared/validation.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

async function setup(overrides) {
  const ctx = await resetTestApp(overrides);
  ctx.cookies = await signupAndLogin(ctx.app, { email: 'ana@x.com', name: 'Ana' });
  ctx.userId = (await ctx.app.db.get("SELECT id FROM users WHERE email = 'ana@x.com'")).id;
  return ctx;
}

const me = (app, cookie) => app.inject({ method: 'GET', url: '/api/me', cookies: { af_session: cookie } });
const userRow = (app) => app.db.get("SELECT password_hash, password_changed_at FROM users WHERE email = 'ana@x.com'");

describe('redefinição com sucesso (critérios 14, 18 e 21)', () => {
  test('200, mensagem, redirectTo, cookie limpo, hash novo com o custo do AF-01, used_at, outros links invalidados', async () => {
    const { app, transport, clock, userId } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      const before = await userRow(app);
      clock.advance(MIN);
      const res = await confirmReset(app, resetBody(token));
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { message: 'Senha alterada. Entre com a nova senha.', redirectTo: '/login?senha-alterada=1' });
      const cookie = [res.headers['set-cookie']].flat().find((c) => c.startsWith('af_session='));
      assert.match(cookie, /^af_session=;/);
      assert.match(cookie, /Max-Age=0/);
      const after = await userRow(app);
      assert.notEqual(after.password_hash, before.password_hash);
      assert.equal(bcrypt.getRounds(after.password_hash), app.config.bcryptCost);
      assert.equal(await bcrypt.compare(NEW_PASSWORD, after.password_hash), true);
      assert.equal(after.password_changed_at, clock.now().toISOString());
      const tokens = await app.db.all('SELECT * FROM password_reset_tokens WHERE user_id = ?', [userId]);
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].used_at, clock.now().toISOString());
      assert.equal(res.body.includes(after.password_hash), false);
      // Senha antiga deixa de funcionar; a nova funciona (critério 21). Sem sessão nova (decisão 3).
      assert.equal((await login(app, 'ana@x.com', TEST_PASSWORD)).statusCode, 401);
      assert.equal((await login(app, 'ana@x.com', NEW_PASSWORD)).statusCode, 200);
      assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE used_at IS NULL')).n), 0);
    } finally {
      await app.close();
    }
  });

  test('a mesma senha atual é aceita (decisão 10); sem passwordConfirmation também (critério 17)', async () => {
    const { app, transport } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      const res = await confirmReset(app, { token, password: TEST_PASSWORD });
      assert.equal(res.statusCode, 200);
      assert.equal((await login(app, 'ana@x.com', TEST_PASSWORD)).statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

describe('validade e uso único (critérios 9 e 10)', () => {
  for (const [label, offset, status] of [
    ['59 min 59 s: aceito', HOUR - SEC, 200],
    ['60 min 00 s: rejeitado', HOUR, 400],
    ['60 min 01 s: rejeitado', HOUR + SEC, 400],
  ]) {
    test(label, async () => {
      const { app, transport, clock } = await setup();
      try {
        const token = await requestAndSend(app, transport, 'ana@x.com');
        clock.advance(offset);
        const res = await confirmReset(app, resetBody(token));
        assert.equal(res.statusCode, status);
        if (status === 400) assert.equal(res.json().error.code, 'PASSWORD_RESET_LINK_INVALID');
      } finally {
        await app.close();
      }
    });
  }

  test('reuso depois do sucesso: 400', async () => {
    const { app, transport } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      assert.equal((await confirmReset(app, resetBody(token))).statusCode, 200);
      const again = await confirmReset(app, resetBody(token, 'outra1234'));
      assert.equal(again.statusCode, 400);
      assert.equal(again.json().error.message, LINK_INVALID);
    } finally {
      await app.close();
    }
  });

  test('duas redefinições simultâneas com o mesmo token: exatamente um 200, um 400 e uma troca de hash (10 rodadas)', async () => {
    for (let round = 0; round < 10; round++) {
      const { app, transport } = await setup();
      try {
        const token = await requestAndSend(app, transport, 'ana@x.com');
        const [a, b] = await Promise.all([
          confirmReset(app, resetBody(token, 'primeira123'), { headers: withIp('10.7.0.1') }),
          confirmReset(app, resetBody(token, 'segunda123'), { headers: withIp('10.7.0.2') }),
        ]);
        assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 400], `rodada ${round}`);
        const winner = a.statusCode === 200 ? 'primeira123' : 'segunda123';
        const { password_hash: hash } = await userRow(app);
        assert.equal(await bcrypt.compare(winner, hash), true);
        assert.equal((await outboxRows(app.db, { kind: 'password_changed' })).length, 1);
      } finally {
        await app.close();
      }
    }
  });

  test('consume que devolve changes 0 (corrida perdida): 400 e nada muda', async () => {
    const { app, transport, clock } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      const s = app.services;
      const tokensRepo = { ...s.passwordResetTokensRepository, consume: async () => ({ changes: 0 }) };
      app.services.passwordResetService = createPasswordResetService({
        db: app.db,
        usersRepository: s.usersRepository,
        passwordResetTokensRepository: tokensRepo,
        sessionsRepository: s.sessionsRepository,
        loginAttemptsRepository: s.loginAttemptsRepository,
        rateLimiter: createAuthRateLimiter({ authRateLimitsRepository: s.authRateLimitsRepository, now: clock.now }),
        enqueueEmail,
        config: app.config,
        now: clock.now,
      });
      const before = await userRow(app);
      const sessionsBefore = await app.db.all('SELECT * FROM sessions');
      const outboxBefore = await outboxRows(app.db);
      const res = await confirmReset(app, resetBody(token));
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'PASSWORD_RESET_LINK_INVALID');
      assert.deepEqual(await userRow(app), before);
      assert.deepEqual(await app.db.all('SELECT * FROM sessions'), sessionsBefore);
      assert.deepEqual(await outboxRows(app.db), outboxBefore);
    } finally {
      await app.close();
    }
  });
});

describe('resposta uniforme do link inválido (critério 12)', () => {
  test('malformado, inexistente, vencido, usado e invalidado: mesmo status, corpo e cabeçalhos', async () => {
    const { app, transport, clock } = await setup();
    try {
      await signupAndLogin(app, { email: 'bia@x.com' });
      await signupAndLogin(app, { email: 'caio@x.com' });
      const used = await requestAndSend(app, transport, 'ana@x.com');
      assert.equal((await confirmReset(app, resetBody(used))).statusCode, 200);
      const invalidated = await requestAndSend(app, transport, 'bia@x.com');
      clock.advance(MIN);
      await requestReset(app, 'bia@x.com'); // o pedido novo invalida o link anterior
      const expired = await requestAndSend(app, transport, 'caio@x.com');
      clock.advance(HOUR);
      const cases = {
        malformado: 'curto',
        naoString: 42,
        inexistente: 'A'.repeat(43),
        vencido: expired,
        usado: used,
        invalidado: invalidated,
      };
      const prints = [];
      for (const [i, [label, token]] of Object.entries(cases).entries()) {
        const res = await confirmReset(app, resetBody(token), { headers: withIp(`10.8.0.${i}`) });
        assert.equal(res.statusCode, 400, label);
        assert.deepEqual(res.json(), { error: { code: 'PASSWORD_RESET_LINK_INVALID', message: LINK_INVALID } }, label);
        prints.push(responseFingerprint(res));
      }
      for (const p of prints.slice(1)) assert.deepEqual(p, prints[0]);
      // Sem token nenhum, também.
      const none = await confirmReset(app, { password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }, { headers: withIp('10.8.1.1') });
      assert.deepEqual(responseFingerprint(none), prints[0]);
    } finally {
      await app.close();
    }
  });
});

describe('política e confirmação (critérios 15, 16 e 17)', () => {
  test('abcd1234 aceita; fracas recusadas com as mensagens do AF-01; o token continua usável', async () => {
    const { app, transport } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      for (const [password, message] of [
        ['abcdefgh', MESSAGES.passwordRequirement],
        ['12345678', MESSAGES.passwordRequirement],
        ['abc1234', MESSAGES.passwordRequirement],
        [`a1${'x'.repeat(71)}`, MESSAGES.passwordTooLong],
        [undefined, MESSAGES.passwordRequirement],
      ]) {
        const res = await confirmReset(app, { token, password, passwordConfirmation: password });
        assert.equal(res.statusCode, 400, String(password));
        assert.deepEqual(res.json().error, { code: 'VALIDATION_ERROR', message: 'Verifique os campos destacados.', fields: { password: message } });
      }
      const mismatch = await confirmReset(app, { token, password: 'abcd1234', passwordConfirmation: 'abcd12345' });
      assert.equal(mismatch.statusCode, 400);
      assert.deepEqual(mismatch.json().error.fields, { passwordConfirmation: 'As senhas não coincidem.' });
      assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE used_at IS NULL')).n), 1);
      assert.equal((await confirmReset(app, resetBody(token, 'abcd1234'))).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('a política é conferida só com token válido: link vencido e senha fraca dão o 400 do link', async () => {
    const { app, transport, clock } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      clock.advance(2 * HOUR);
      const res = await confirmReset(app, { token, password: 'x', passwordConfirmation: 'y' });
      assert.equal(res.json().error.code, 'PASSWORD_RESET_LINK_INVALID');
    } finally {
      await app.close();
    }
  });
});

describe('sessões e bloqueio (critérios 19, 20 e 35)', () => {
  test('3 sessões abertas (inclusive a do navegador do link): todas 401 depois da troca', async () => {
    const { app, transport, cookies } = await setup();
    try {
      const sessions = [cookies.af_session];
      for (let i = 0; i < 2; i++) sessions.push(sessionTokenFrom(await login(app, 'ana@x.com')));
      for (const s of sessions) assert.equal((await me(app, s)).statusCode, 200);
      const token = await requestAndSend(app, transport, 'ana@x.com');
      const res = await confirmReset(app, resetBody(token), { cookies: { af_session: sessions[0] } });
      assert.equal(res.statusCode, 200);
      for (const s of sessions) assert.equal((await me(app, s)).statusCode, 401);
      const active = await app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL');
      assert.equal(Number(active.n), 0);
    } finally {
      await app.close();
    }
  });

  test('defesa em profundidade: sessão criada antes de password_changed_at e não revogada dá 401', async () => {
    const { app, transport, clock, userId } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      const old = clock.now().toISOString();
      clock.advance(MIN);
      assert.equal((await confirmReset(app, resetBody(token))).statusCode, 200);
      const raw = 'sessao-antiga-inserida-direto-no-banco-xyz';
      const hash = createHash('sha256').update(raw).digest('hex');
      await app.db.run(
        'INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        [randomUUID(), userId, hash, old, clock.now().toISOString(), new Date(clock.now().getTime() + 7 * 24 * HOUR).toISOString()],
      );
      assert.equal((await me(app, raw)).statusCode, 401);
      // Login depois da troca, no mesmo milissegundo: vale (>=).
      const fresh = await login(app, 'ana@x.com', NEW_PASSWORD);
      assert.equal((await me(app, sessionTokenFrom(fresh))).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('corrida login × troca: login com a senha antiga que termina depois da troca não cria sessão (5.5, R5)', async () => {
    const { app, transport, clock } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      let release;
      let entered;
      const enteredP = new Promise((r) => {
        entered = r;
      });
      const gate = new Promise((r) => {
        release = r;
      });
      const s = app.services;
      const slowAuth = createAuthService({
        db: app.db,
        usersRepository: s.usersRepository,
        sessionsService: s.sessionsService,
        loginAttemptsService: s.loginAttemptsService,
        businessesRepository: s.businessesRepository,
        config: app.config,
        now: clock.now,
        verifyPassword: async (plain, hash) => {
          const ok = await verifyPassword(plain, hash);
          entered();
          await gate;
          return ok;
        },
      });
      const sessionsBefore = Number((await app.db.get('SELECT COUNT(*) AS n FROM sessions')).n);
      const pending = slowAuth.login({ email: 'ana@x.com', password: TEST_PASSWORD }, { ip: '10.9.0.1' });
      await enteredP;
      assert.equal((await confirmReset(app, resetBody(token))).statusCode, 200);
      release();
      await assert.rejects(pending, InvalidCredentialsError);
      assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM sessions')).n), sessionsBefore);
      assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL')).n), 0);
    } finally {
      await app.close();
    }
  });

  test('bloqueio do AF-02 em dois IPs é zerado pela troca; login com a nova senha passa nos dois (critério 20)', async () => {
    const { app, transport } = await setup();
    try {
      for (const ip of ['10.10.0.1', '10.10.0.2']) {
        for (let i = 0; i < 5; i++) await login(app, 'ana@x.com', 'errada123', { headers: withIp(ip) });
        assert.equal((await login(app, 'ana@x.com', TEST_PASSWORD, { headers: withIp(ip) })).statusCode, 429);
      }
      const token = await requestAndSend(app, transport, 'ana@x.com');
      assert.equal((await confirmReset(app, resetBody(token))).statusCode, 200);
      assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM login_attempts')).n), 0);
      for (const ip of ['10.10.0.1', '10.10.0.2']) {
        assert.equal((await login(app, 'ana@x.com', NEW_PASSWORD, { headers: withIp(ip) })).statusCode, 200, ip);
      }
    } finally {
      await app.close();
    }
  });
});

describe('limite por IP e CSRF (critérios 23 e 26)', () => {
  test('11ª tentativa do IP em 15 min: 429; tokens inválidos contam; um sucesso no meio não zera', async () => {
    const { app, transport, clock } = await setup();
    try {
      const ip = withIp('198.51.100.7');
      for (let i = 0; i < 5; i++) assert.equal((await confirmReset(app, resetBody('B'.repeat(43)), { headers: ip })).statusCode, 400);
      const token = await requestAndSend(app, transport, 'ana@x.com');
      assert.equal((await confirmReset(app, resetBody(token), { headers: ip })).statusCode, 200);
      for (let i = 0; i < 4; i++) assert.equal((await confirmReset(app, resetBody('x'), { headers: ip })).statusCode, 400);
      clock.advance(5 * MIN);
      const limited = await confirmReset(app, resetBody('x'), { headers: ip });
      assert.equal(limited.statusCode, 429);
      assert.deepEqual(limited.json(), { error: { code: 'RATE_LIMITED', message: 'Muitas tentativas. Tente novamente mais tarde.' } });
      assert.equal(limited.headers['retry-after'], String(10 * 60));
      assert.equal((await confirmReset(app, resetBody('x'), { headers: withIp('198.51.100.8') })).statusCode, 400);
      clock.advance(10 * MIN);
      assert.equal((await confirmReset(app, resetBody('x'), { headers: ip })).statusCode, 400);
    } finally {
      await app.close();
    }
  });

  test('CSRF: Origin de fora e Sec-Fetch-Site cross-site dão 403 sem consumir o token', async () => {
    const { app, transport } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
        const res = await confirmReset(app, resetBody(token), { headers });
        assert.equal(res.statusCode, 403, JSON.stringify(headers));
      }
      assert.equal((await confirmReset(app, resetBody(token))).statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

describe('aviso pós-troca (critério 32)', () => {
  test('1 linha password_changed; assunto, data e hora no fuso do negócio do dono (Manaus) e nenhum link', async () => {
    const { app, transport, cookies } = await setup();
    try {
      const business = await createBusinessFor(app, cookies, { name: 'Salão Manaus', slug: 'salao-manaus' });
      await setBusinessTimezone(app, business.id, 'America/Manaus');
      const token = await requestAndSend(app, transport, 'ana@x.com');
      assert.equal((await confirmReset(app, resetBody(token))).statusCode, 200);
      const rows = await outboxRows(app.db, { kind: 'password_changed' });
      assert.equal(rows.length, 1);
      await drain(app);
      const notice = mailsTo(transport, 'ana@x.com').find((m) => m.subject === 'Sua senha foi alterada · AgendaFácil');
      assert.ok(notice);
      // 2026-11-26T12:00Z = 08:00 em Manaus (UTC-4).
      const when = 'quinta-feira, 26/11/2026, às 08:00 (Horário de Manaus, America/Manaus)';
      for (const part of [notice.text, notice.html]) {
        assert.ok(part.includes(`A senha da sua conta no AgendaFácil foi alterada em ${when}.`), part);
        assert.ok(part.includes('Por segurança, todas as sessões abertas foram encerradas.'));
        assert.ok(part.includes('Esqueci minha senha'));
        assert.equal(/http/i.test(part.replace(/<meta[^>]*>/g, '')), false, 'sem URL');
      }
      assert.equal(/href=/.test(notice.html), false);
      assert.deepEqual(notice.attachments, []);
    } finally {
      await app.close();
    }
  });

  test('dono sem negócio: Horário de Brasília', async () => {
    const { app, transport } = await setup();
    try {
      const token = await requestAndSend(app, transport, 'ana@x.com');
      await confirmReset(app, resetBody(token));
      await drain(app);
      const notice = mailsTo(transport, 'ana@x.com').find((m) => m.subject === 'Sua senha foi alterada · AgendaFácil');
      assert.ok(notice.text.includes('quinta-feira, 26/11/2026, às 09:00 (Horário de Brasília, America/Sao_Paulo)'), notice.text);
    } finally {
      await app.close();
    }
  });
});
