// AF-03 (design 4.5 e 6.1, critérios 8, 33 e 34): fluxo completo com logs em `trace`. Nenhum log nem
// coluna de nenhuma tabela tem o token, o link, a senha nova, o hash novo ou o e-mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signupAndLogin } from '../helpers/session.js';
import { drain, logEntries } from '../helpers/email.js';
import { everyColumnText } from '../helpers/manage.js';
import {
  resetTestApp,
  requestReset,
  confirmReset,
  resetBody,
  resetLinkFrom,
  resetTokenFrom,
  login,
  mailsTo,
  NEW_PASSWORD,
} from '../helpers/password-reset.js';
import { hashResetToken } from '../../src/modules/auth/password-reset-token.js';

const EMAIL = 'privada.ana@x.com';
const ALLOWED_EVENTS = new Set([
  'password_reset_requested',
  'password_reset_completed',
  'password_reset_rejected',
  'password_reset_rate_limited',
  'email_enqueued',
  'email_sent',
  'email_retry',
  'email_failed',
  'email_skipped',
  'email_lease_lost',
]);

test('fluxo completo: pedido, envio, redefinição, aviso e login sem dado sensível em log nem no banco', async () => {
  const { app, transport, logs } = await resetTestApp();
  try {
    await signupAndLogin(app, { email: EMAIL, name: 'Ana Privada' });
    await requestReset(app, 'ninguem.privado@x.com');
    await requestReset(app, EMAIL);
    await drain(app);
    const message = mailsTo(transport, EMAIL)[0];
    const token = resetTokenFrom(message);
    const link = resetLinkFrom(message);
    assert.ok(token && link);
    await confirmReset(app, { token, password: 'fraca', passwordConfirmation: 'fraca' });
    await confirmReset(app, resetBody('Z'.repeat(43)));
    assert.equal((await confirmReset(app, resetBody(token))).statusCode, 200);
    await drain(app);
    assert.ok(mailsTo(transport, EMAIL).some((m) => m.subject.startsWith('Sua senha foi alterada')));
    assert.equal((await login(app, EMAIL, NEW_PASSWORD)).statusCode, 200);
    // Página com query: o log de acesso não tem a query (o fragmento nunca chega ao servidor).
    await app.inject({ method: 'GET', url: '/redefinir-senha?x=1' });

    const newHash = (await app.db.get('SELECT password_hash FROM users WHERE email = ?', [EMAIL])).password_hash;
    const text = logs();
    const columns = await everyColumnText(app.db);
    for (const [label, secret] of [
      ['token', token],
      ['link', link],
      ['senha nova', NEW_PASSWORD],
      ['hash novo', newHash],
      ['e-mail', EMAIL],
      ['e-mail inexistente', 'ninguem.privado@x.com'],
      ['senha fraca', '"fraca"'],
    ]) {
      assert.equal(text.includes(secret), false, `${label} no log`);
    }
    for (const [label, secret] of [['token', token], ['link', link], ['senha nova', NEW_PASSWORD]]) {
      assert.equal(columns.includes(secret), false, `${label} no banco`);
    }
    // O banco tem só o SHA-256 do token (critério 8).
    assert.ok(columns.includes(hashResetToken(token)));

    const entries = logEntries(logs);
    const events = entries.filter((e) => typeof e.event === 'string' && /password_reset|^email_(?!transport)/.test(e.event));
    for (const e of events) assert.ok(ALLOWED_EVENTS.has(e.event), e.event);
    const requested = entries.filter((e) => e.event === 'password_reset_requested').map((e) => e.outcome).sort();
    assert.deepEqual(requested, ['enqueued', 'no_account']);
    const rejected = entries.filter((e) => e.event === 'password_reset_rejected').map((e) => e.reason).sort();
    assert.deepEqual(rejected, ['invalid_link', 'policy']);
    assert.equal(entries.filter((e) => e.event === 'password_reset_completed').length, 1);
    for (const e of entries.filter((x) => x.event?.startsWith('password_reset'))) {
      assert.deepEqual(Object.keys(e).filter((k) => !['level', 'time', 'pid', 'hostname', 'reqId', 'msg'].includes(k)).sort(),
        ['event', ...(e.outcome ? ['outcome'] : []), ...(e.reason ? ['reason'] : []), ...(e.scope ? ['scope'] : []), ...(e.userId ? ['userId'] : [])].sort());
    }
    const access = entries.filter((e) => e.msg === 'incoming request' && String(e.req?.url).startsWith('/redefinir-senha'));
    assert.ok(access.length >= 1);
    for (const e of access) assert.equal(e.req.url, '/redefinir-senha');

    const cols = (await app.db.all('PRAGMA table_info(email_outbox)')).map((c) => c.name);
    assert.equal(cols.at(-1), 'user_id');
    assert.equal(cols.length, 15);
  } finally {
    await app.close();
  }
});
