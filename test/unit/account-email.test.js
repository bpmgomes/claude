// AF-03 (design 4.2 e 4.3, critérios 30 e 32): modelos dos e-mails de conta. Puros e iguais com
// qualquer TZ do processo (AF-23).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderAccountEmail } from '../../src/modules/email/templates/account-email.js';
import { formatInstant } from '../../src/modules/email/email-format.js';
import { ACCOUNT_EMAIL_MESSAGES } from '../../src/modules/email/email-messages.js';

const BASE = 'https://agendafacil.app';
const TOKEN = 'Q'.repeat(43);
const URL_OK = `${BASE}/redefinir-senha#token=${TOKEN}`;
const AT = Date.parse('2026-11-27T13:00:00.000Z'); // sexta, 10:00 em São Paulo

const reset = (over = {}) => renderAccountEmail({ kind: 'password_reset', user: { name: 'Ana' }, resetUrl: URL_OK, publicBaseUrl: BASE, requireHttps: true, ...over });
const changed = (over = {}) =>
  renderAccountEmail({ kind: 'password_changed', user: { name: 'Ana' }, changedAtMs: AT, timeZone: 'America/Sao_Paulo', publicBaseUrl: BASE, requireHttps: true, ...over });

test('redefinição: textos exatos, um único href = link, link por extenso no texto, sem anexo', () => {
  const r = reset();
  assert.deepEqual(Object.keys(r).sort(), ['html', 'subject', 'text']);
  assert.equal(r.subject, 'Redefinição de senha · AgendaFácil');
  assert.equal(
    r.text,
    [
      'Olá, Ana,',
      '',
      'Recebemos um pedido para redefinir a senha da sua conta no AgendaFácil.',
      '',
      `Redefinir senha: ${URL_OK}`,
      '',
      'Este link vale por 1 hora e só pode ser usado uma vez.',
      'Se você não pediu isso, ignore este e-mail: sua senha continua a mesma.',
      '',
      'Este é um e-mail automático. Não responda a esta mensagem.',
      '',
    ].join('\n'),
  );
  assert.deepEqual([...r.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), [URL_OK]);
  assert.match(r.html, /<html lang="pt-BR">/);
  assert.doesNotMatch(r.html, /<script|<img|\son[a-z]+=/i);
});

test('aviso de troca: data, hora e fuso pelo AF-23, nenhum link nem URL', () => {
  const c = changed();
  assert.equal(c.subject, 'Sua senha foi alterada · AgendaFácil');
  const when = 'sexta-feira, 27/11/2026, às 10:00 (Horário de Brasília, America/Sao_Paulo)';
  assert.ok(c.text.includes(`A senha da sua conta no AgendaFácil foi alterada em ${when}.`));
  assert.ok(c.text.includes(ACCOUNT_EMAIL_MESSAGES.changedSessions));
  assert.ok(c.text.includes(ACCOUNT_EMAIL_MESSAGES.changedNotYou));
  assert.doesNotMatch(c.html, /href=/);
  assert.doesNotMatch(c.text + c.html, /https?:/);
  const manaus = changed({ timeZone: 'America/Manaus' });
  assert.ok(manaus.text.includes('sexta-feira, 27/11/2026, às 09:00 (Horário de Manaus, America/Manaus)'));
  assert.ok(changed({ timeZone: undefined }).text.includes('(Horário de Brasília, America/Sao_Paulo)'));
  assert.throws(() => changed({ resetUrl: URL_OK }), /não leva link/);
  assert.throws(() => changed({ changedAtMs: Number.NaN }));
});

test('escape do nome: <img onerror>, aspas e &', () => {
  for (const name of ['<img src=x onerror=alert(1)>', '"Ana" & \'Bia\'']) {
    const r = reset({ user: { name } });
    const c = changed({ user: { name } });
    for (const html of [r.html, c.html]) {
      assert.doesNotMatch(html, /<img/);
      assert.equal(html.includes(name), false);
    }
    assert.ok(r.text.includes(`Olá, ${name},`));
  }
  assert.ok(reset({ user: { name: 'A & B' } }).html.includes('Olá, A &amp; B,'));
});

test('link fora da base, com outro caminho, token fora do formato ou sem https com requireHttps: lança', () => {
  for (const resetUrl of [
    `https://evil.example/redefinir-senha#token=${TOKEN}`,
    `${BASE}/agendamento/${TOKEN}`,
    `${BASE}/redefinir-senha?token=${TOKEN}`,
    `${BASE}/redefinir-senha#token=curto`,
    `${BASE}/redefinir-senha#token=${TOKEN}"><a href="x`,
    undefined,
  ]) {
    assert.throws(() => reset({ resetUrl }), String(resetUrl));
  }
  assert.throws(() => reset({ publicBaseUrl: 'http://agendafacil.app', resetUrl: `http://agendafacil.app/redefinir-senha#token=${TOKEN}` }), /https/);
  assert.doesNotThrow(() => reset({ publicBaseUrl: 'http://localhost:3000', resetUrl: `http://localhost:3000/redefinir-senha#token=${TOKEN}`, requireHttps: false }));
  assert.throws(() => renderAccountEmail({ kind: 'x', user: { name: 'A' }, publicBaseUrl: BASE }), /tipo/);
});

test('formatInstant: tabela fixa de dias, no fuso pedido', () => {
  assert.equal(formatInstant(AT, 'America/Sao_Paulo'), 'sexta-feira, 27/11/2026, às 10:00');
  assert.equal(formatInstant(AT, 'Asia/Tokyo'), 'sexta-feira, 27/11/2026, às 22:00');
  assert.equal(formatInstant(AT + 2 * 3_600_000, 'Asia/Tokyo'), 'sábado, 28/11/2026, às 00:00');
});

test('mesma saída com TZ do processo em UTC, Asia/Tokyo e America/Sao_Paulo', () => {
  const script = `
    const { renderAccountEmail } = await import(${JSON.stringify(fileURLToPath(new URL('../../src/modules/email/templates/account-email.js', import.meta.url)))});
    const a = renderAccountEmail({ kind: 'password_changed', user: { name: 'Ana' }, changedAtMs: ${AT}, timeZone: 'America/Manaus', publicBaseUrl: '${BASE}', requireHttps: true });
    const b = renderAccountEmail({ kind: 'password_reset', user: { name: 'Ana' }, resetUrl: '${URL_OK}', publicBaseUrl: '${BASE}', requireHttps: true });
    process.stdout.write(JSON.stringify([a, b]));
  `;
  const outs = ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo'].map((TZ) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.equal(outs[1], outs[0]);
  assert.equal(outs[2], outs[0]);
});
