// AF-03, 2ª tentativa (pedido do Gerente, M2): casos que matam as mutações sobreviventes do QA.
// - 429 da confirmação com token VÁLIDO acima do limite por IP: o token não é consumido.
// - enqueueEmail recusa userId em kind de agendamento (e alvo de agendamento em kind de conta).
// - purga do boot: o caminho de falha não impede a subida; o de sucesso apaga o que venceu.
// - transporte file: o .eml leva o link com o token no fragmento.
// Revisão de segurança (B2): a limpeza também roda no ciclo do worker, num lote limitado.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signupAndLogin, TEST_PASSWORD } from '../helpers/session.js';
import { buildTestApp } from '../helpers/test-app.js';
import { logEntries } from '../helpers/email.js';
import { resetTestApp, requestAndSend, requestReset, confirmReset, resetBody, withIp, login, NEW_PASSWORD } from '../helpers/password-reset.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { createDatabase } from '../../src/db/index.js';
import { createPasswordResetService } from '../../src/modules/auth/password-reset.service.js';
import { hashResetToken } from '../../src/modules/auth/password-reset-token.js';

const NOW = '2026-11-26T12:00:00.000Z';
const DAY = 86_400_000;

describe('429 da confirmação com token válido (critério 23)', () => {
  test('acima de 10 tentativas do IP, o token válido dá 429 e continua utilizável de outro IP', async () => {
    const { app, transport } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      const token = await requestAndSend(app, transport, 'ana@x.com');
      const ip = withIp('192.0.2.10');
      for (let i = 0; i < 10; i++) assert.equal((await confirmReset(app, resetBody('C'.repeat(43)), { headers: ip })).statusCode, 400);
      const before = await app.db.get("SELECT password_hash, password_changed_at FROM users WHERE email = 'ana@x.com'");
      const limited = await confirmReset(app, resetBody(token), { headers: ip });
      assert.equal(limited.statusCode, 429);
      assert.ok(Number(limited.headers['retry-after']) > 0);
      const row = await app.db.get('SELECT used_at FROM password_reset_tokens WHERE token_hash = ?', [hashResetToken(token)]);
      assert.equal(row.used_at, null, 'o token não foi consumido');
      assert.deepEqual(await app.db.get("SELECT password_hash, password_changed_at FROM users WHERE email = 'ana@x.com'"), before);
      assert.equal(Number((await app.db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE kind = 'password_changed'")).n), 0);
      assert.equal((await login(app, 'ana@x.com', TEST_PASSWORD)).statusCode, 200);
      assert.equal((await confirmReset(app, resetBody(token), { headers: withIp('192.0.2.11') })).statusCode, 200);
      assert.equal((await login(app, 'ana@x.com', NEW_PASSWORD)).statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

describe('enqueueEmail: alvo coerente com a família do kind', () => {
  test('agendamento com userId e conta com businessId/appointmentId/previous: TypeError, nada gravado', async () => {
    const { app } = await buildTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      const { id: userId } = await app.db.get("SELECT id FROM users WHERE email = 'ana@x.com'");
      const uuid = randomUUID();
      const cases = [
        { kind: 'appointment_confirmed', businessId: uuid, appointmentId: randomUUID(), userId, nowIso: NOW },
        { kind: 'appointment_cancelled', businessId: uuid, appointmentId: randomUUID(), userId: 'x', nowIso: NOW },
        { kind: 'password_reset', userId, businessId: uuid, nowIso: NOW },
        { kind: 'password_reset', userId, appointmentId: uuid, nowIso: NOW },
        { kind: 'password_changed', userId, previousAppointmentId: uuid, nowIso: NOW },
        { kind: 'password_changed', userId: 'nao-uuid', nowIso: NOW },
        { kind: 'password_changed', nowIso: NOW },
        { kind: 'password_reset', userId, nowIso: '2026-11-26' },
      ];
      for (const e of cases) {
        await assert.rejects(app.db.transaction((tx) => enqueueEmail(tx, e)), TypeError, JSON.stringify(e));
      }
      assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM email_outbox')).n), 0);
      // Controle: conta com userId válido e sem alvo de agendamento passa.
      const ok = await app.db.transaction((tx) => enqueueEmail(tx, { kind: 'password_changed', userId, nowIso: NOW }));
      assert.equal(ok.enqueued, true);
    } finally {
      await app.close();
    }
  });
});

describe('purga do boot (design 5.7)', () => {
  test('sucesso: tokens vencidos há mais de 24 h e baldes velhos saem; o resto fica', async () => {
    const { app, clock } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      await signupAndLogin(app, { email: 'bia@x.com' });
      const users = await app.db.all('SELECT id FROM users ORDER BY email');
      const t = (ms) => new Date(Date.parse(NOW) + ms).toISOString();
      const insert = (hash, user, created, expires, used = null) =>
        app.db.run('INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [hash, user, created, expires, used]);
      await insert('a'.repeat(64), users[0].id, t(-3 * DAY), t(-3 * DAY + 3_600_000), t(-3 * DAY + 60_000)); // vencido há 2 dias
      await insert('b'.repeat(64), users[1].id, t(-2 * DAY), t(-DAY - 1)); // vencido há mais de 24 h
      await insert('c'.repeat(64), users[0].id, t(-DAY), t(-DAY + 3_600_000)); // vencido há menos de 24 h
      await app.db.run("INSERT INTO auth_rate_limits (scope, key_hash, window_started_at, hits) VALUES ('password_reset_request_ip', ?, ?, 1)", ['d'.repeat(64), t(-2 * DAY)]);
      await app.db.run("INSERT INTO auth_rate_limits (scope, key_hash, window_started_at, hits) VALUES ('password_reset_request_ip', ?, ?, 1)", ['e'.repeat(64), t(-60_000)]);
      assert.ok(clock.now().toISOString() === NOW);
      await app.services.passwordResetService.purgeExpired();
      assert.deepEqual((await app.db.all('SELECT token_hash FROM password_reset_tokens')).map((r) => r.token_hash[0]), ['c']);
      assert.deepEqual((await app.db.all('SELECT key_hash FROM auth_rate_limits')).map((r) => r.key_hash[0]), ['e']);
    } finally {
      await app.close();
    }
  });

  test('falha: purgeExpired não lança e loga password_reset_purge_failed (sem detalhe)', async () => {
    const log = { entries: [], info(e) { this.entries.push(e); }, warn(e) { this.entries.push(e); }, error(e) { this.entries.push(e); } };
    const boom = async () => {
      throw Object.assign(new Error('disco cheio'), { code: 'SQLITE_FULL' });
    };
    const service = createPasswordResetService({
      db: {},
      passwordResetTokensRepository: { purgeExpired: boom },
      authRateLimitsRepository: { purgeOld: boom },
      config: { passwordReset: {} },
      log,
    });
    await service.purgeExpired();
    assert.deepEqual(log.entries, [{ event: 'password_reset_purge_failed', errCode: 'SQLITE_FULL', errName: 'Error' }]);
  });

  test('falha na purga não impede a subida do app (tabela ausente no banco)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af03-purge-'));
    try {
      const databasePath = join(dir, 'db.sqlite');
      const first = await buildTestApp({ databasePath });
      await first.app.close();
      const raw = createDatabase({ databasePath });
      await raw.exec('DROP TABLE password_reset_tokens;');
      await raw.close();
      const second = await buildTestApp({ databasePath });
      try {
        assert.equal((await second.app.inject({ method: 'GET', url: '/login' })).statusCode, 200);
        const failed = logEntries(second.logs).filter((e) => e.event === 'password_reset_purge_failed');
        assert.equal(failed.length, 1);
        assert.equal(JSON.stringify(failed[0]).includes('password_reset_tokens'), false, 'sem a mensagem do driver');
      } finally {
        await second.app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('transporte file (critério 29, desenvolvimento)', () => {
  test('o .eml gravado tem o link /redefinir-senha#token=<43> no texto e no href', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af03-eml-'));
    try {
      const { app } = await buildTestApp({ nodeEnv: 'test', email: { transport: 'file', fileDir: dir, worker: { enabled: false, intervalMs: 15_000 } } });
      try {
        assert.equal(app.config.email.transport, 'file');
        await signupAndLogin(app, { email: 'ana@x.com' });
        assert.equal((await app.inject({ method: 'POST', url: '/api/auth/password-reset', payload: { email: 'ana@x.com' } })).statusCode, 202);
        assert.equal((await app.services.emailWorker.runOnce()).sent, 1);
        const files = await readdir(dir);
        assert.equal(files.length, 1);
        const raw = await readFile(join(dir, files[0]), 'utf8');
        // Quoted-printable: junta as quebras suaves e decodifica =XX.
        const decoded = Buffer.from(raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(Number.parseInt(h, 16))), 'latin1').toString('utf8');
        const m = /Redefinir senha: (https:\/\/agendafacil\.app\/redefinir-senha#token=([A-Za-z0-9_-]{43}))\n/.exec(decoded.replace(/\r\n/g, '\n'));
        assert.ok(m, decoded.slice(0, 800));
        assert.ok(decoded.includes(`href="${m[1]}"`));
        assert.match(raw, /^Subject: =\?UTF-8\?Q\?Redefini/m);
        // O link do .eml funciona.
        assert.equal((await confirmReset(app, resetBody(m[2]))).statusCode, 200);
      } finally {
        await app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('limpeza no ciclo do worker (B2 da revisão de segurança)', () => {
  test('cada ciclo apaga no máximo um lote de 100 por tabela; o 2º ciclo apaga o resto', async () => {
    const { app } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      const { id: userId } = await app.db.get("SELECT id FROM users WHERE email = 'ana@x.com'");
      const t = (ms) => new Date(Date.parse(NOW) + ms).toISOString();
      const hex = (i) => i.toString(16).padStart(64, '0');
      for (let i = 0; i < 130; i++) {
        await app.db.run('INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [
          hex(i), userId, t(-3 * DAY), t(-3 * DAY + 3_600_000), t(-3 * DAY + 60_000),
        ]);
        await app.db.run("INSERT INTO auth_rate_limits (scope, key_hash, window_started_at, hits) VALUES ('password_reset_request_ip', ?, ?, 1)", [hex(i), t(-2 * DAY)]);
        await app.db.run("INSERT INTO auth_rate_events (scope, key_hash, occurred_at) VALUES ('password_reset_request_email', ?, ?)", [hex(i), t(-2 * DAY)]);
      }
      // Um evento recente fica (ainda está na janela de 24 h).
      await app.db.run("INSERT INTO auth_rate_events (scope, key_hash, occurred_at) VALUES ('password_reset_request_email', ?, ?)", ['f'.repeat(64), t(-60_000)]);
      const count = async (table) => Number((await app.db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
      await app.services.emailWorker.runOnce();
      assert.deepEqual([await count('password_reset_tokens'), await count('auth_rate_limits'), await count('auth_rate_events')], [30, 30, 31]);
      await app.services.emailWorker.runOnce();
      assert.deepEqual([await count('password_reset_tokens'), await count('auth_rate_limits'), await count('auth_rate_events')], [0, 0, 1]);
    } finally {
      await app.close();
    }
  });

  test('falha da limpeza no ciclo não derruba o ciclo: loga password_reset_purge_failed e envia', async () => {
    const { app, transport, logs } = await resetTestApp();
    try {
      await signupAndLogin(app, { email: 'ana@x.com' });
      assert.equal((await requestReset(app, 'ana@x.com')).statusCode, 202);
      // Só o pedido e a limpeza leem auth_rate_events: sem ela, só a limpeza do ciclo falha.
      await app.db.exec('DROP TABLE auth_rate_events;');
      assert.equal((await app.services.emailWorker.runOnce()).sent, 1);
      const failed = logEntries(logs).filter((e) => e.event === 'password_reset_purge_failed');
      assert.ok(failed.length >= 1);
      assert.equal(transport.messages.length, 1);
    } finally {
      await app.close();
    }
  });
});
