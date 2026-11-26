// AF-18 (critério 23): adaptador de memória e classes de erro da porta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';
import { TransientMailError, PermanentMailError } from '../../src/modules/email/mail-transport.js';
import { buildMailMessage, messageIdOf } from '../../src/modules/email/message.js';

const message = () =>
  buildMailMessage({
    rendered: { subject: 'Assunto', text: 'Olá', html: '<p>Olá</p>', ics: { content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', method: 'PUBLISH' } },
    to: 'ana@example.com',
    from: { name: 'AgendaFácil', address: 'nao-responda@agendafacil.invalid' },
    messageId: messageIdOf('123e4567-e89b-42d3-a456-426614174000', 'agendafacil.invalid'),
    date: new Date('2026-11-26T12:00:00.000Z'),
  });

test('ok guarda a mensagem; raw(i) compõe o MIME; clear zera', async () => {
  const t = createMemoryMailTransport();
  const res = await t.send(message());
  assert.equal(res.messageId, '<123e4567-e89b-42d3-a456-426614174000@agendafacil.invalid>');
  assert.equal(t.messages.length, 1);
  assert.equal(t.calls, 1);
  assert.match(await t.raw(0), /^Auto-Submitted: auto-generated\r\n/m);
  t.clear();
  assert.equal(t.messages.length, 0);
  assert.equal(t.calls, 0);
});

test('throwSync lança na chamada; reject, transient e permanent rejeitam', async () => {
  const t = createMemoryMailTransport();
  t.setBehavior({ mode: 'throwSync', code: 'EX' });
  assert.throws(() => t.send(message()), (err) => err.code === 'EX');
  t.setBehavior({ mode: 'reject' });
  await assert.rejects(t.send(message()), (err) => err.code === 'ETEST');
  t.setBehavior({ mode: 'transient', code: 'timeout', maybeDelivered: true });
  await assert.rejects(t.send(message()), (err) => err instanceof TransientMailError && err.code === 'timeout' && err.maybeDelivered);
  t.setBehavior({ mode: 'permanent', code: 'recipient_rejected' });
  await assert.rejects(t.send(message()), (err) => err instanceof PermanentMailError && err.code === 'recipient_rejected');
  assert.equal(t.messages.length, 0);
});

test('hang nunca resolve; delay resolve depois e o temporizador não segura o processo (unref)', async () => {
  const t = createMemoryMailTransport();
  t.setBehavior({ mode: 'hang' });
  const hung = t.send(message());
  const raced = await Promise.race([hung.then(() => 'resolveu'), new Promise((r) => setTimeout(() => r('pendente'), 30))]);
  assert.equal(raced, 'pendente');
  t.setBehavior({ mode: 'delay', delayMs: 20 });
  // O timer do adaptador tem unref: o teste segura o event loop com um timer próprio.
  const keepAlive = setInterval(() => {}, 5);
  try {
    await t.send(message());
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(t.messages.length, 1);
  // Um delay enorme não impede o fim do teste (o timer tem unref).
  t.setBehavior({ mode: 'delay', delayMs: 3_600_000 });
  t.send(message());
});

test('setBehavior aceita função por chamada', async () => {
  const t = createMemoryMailTransport();
  t.setBehavior((_m, i) => (i === 0 ? { mode: 'transient' } : { mode: 'ok' }));
  await assert.rejects(t.send(message()));
  await t.send(message());
  assert.equal(t.messages.length, 1);
});

test('erros com mensagem fixa, sem cause, código fora da lista normalizado', () => {
  const a = new TransientMailError('qualquer coisa ana@example.com');
  assert.equal(a.code, 'unknown');
  assert.equal(a.message, 'Falha temporária no envio de e-mail.');
  assert.equal(a.cause, undefined);
  const b = new PermanentMailError('550 user ana@example.com unknown');
  assert.equal(b.code, 'smtp_5xx');
  assert.equal(JSON.stringify(b).includes('ana@'), false);
});
