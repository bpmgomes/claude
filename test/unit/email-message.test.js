// AF-18 (critérios 9, 18 e 19): texto de cabeçalho, endereço seguro e montagem da mensagem.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { headerText, isSafeAddress, toSafeAddress, buildMailMessage, messageIdOf } from '../../src/modules/email/message.js';
import { composeMime } from '../../src/modules/email/mime.js';
import { PermanentMailError } from '../../src/modules/email/mail-transport.js';

const ch = (code) => String.fromCharCode(code);
const LS = ch(0x2028);
const ZWSP = ch(0x200b);
const RLO = ch(0x202e);
const OUTBOX_ID = '123e4567-e89b-42d3-a456-426614174000';

function rendered(over = {}) {
  return {
    subject: 'Agendamento confirmado: Corte em 27/11, 10:00 · Salão',
    text: 'Olá, Ana,',
    html: '<p>Olá, Ana,</p>',
    ics: { content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', method: 'PUBLISH' },
    ...over,
  };
}

function message(over = {}) {
  return buildMailMessage({
    rendered: rendered(over.rendered),
    to: 'ana@exemplo.com.br',
    from: { name: 'AgendaFácil', address: 'nao-responda@agendafacil.invalid' },
    messageId: messageIdOf(OUTBOX_ID, 'agendafacil.invalid'),
    date: new Date('2026-11-26T12:00:00.000Z'),
    ...over.input,
  });
}

/** Cabeçalhos do MIME (até a primeira linha vazia), desdobrados. */
function headersOf(raw) {
  const head = raw.slice(0, raw.indexOf('\r\n\r\n')).replace(/\r\n[ \t]+/g, ' ');
  return head.split('\r\n');
}

describe('headerText', () => {
  test('remove CR, LF, NUL, TAB, U+2028 e \\p{Cf}; junta brancos e apara', () => {
    const value = ` Ana\r\nBcc: x@y.com${ch(0)}\t${LS}${ZWSP}${RLO}fim `;
    const out = headerText(value);
    assert.equal(out, 'Ana Bcc: x@y.com fim');
    assert.equal(/[\r\n\0\t]/.test(out), false);
  });

  test('corte em code points com "…"', () => {
    assert.equal(headerText('abcdef', 4), 'abc…');
    assert.equal(headerText('😀😀😀😀😀', 3), '😀😀…');
    assert.equal(headerText('abc', 3), 'abc');
  });
});

describe('isSafeAddress (decisão 4 do Gerente)', () => {
  test('válidos comuns, com +, subdomínio e IDN no domínio', () => {
    for (const v of ['ana@example.com', 'ana.souza+agenda@mail.example.com.br', 'a_b-c@x.io', 'x@xn--bcher-kva.de', 'ana@bücher.de']) {
      assert.equal(isSafeAddress(v), true, v);
    }
    assert.equal(toSafeAddress('ana@bücher.de'), 'ana@xn--bcher-kva.de');
  });

  test('inválidos: dois @, %, <, aspas, espaço, CR/LF, %0d%0a, NUL, tamanhos, sem TLD, local não ASCII', () => {
    const cases = [
      'a@b@example.com',
      'ana%x@example.com',
      'ana%0d%0abcc@example.com',
      'ana@example.com%0d%0aBcc:x@y.com',
      '<ana>@example.com',
      '"ana"@example.com',
      'ana souza@example.com',
      'ana\r\n@example.com',
      'ana@example.com\r\nBcc: x@y.com',
      `ana${ch(0)}@example.com`,
      'ana@exa\tmple.com',
      `${'a'.repeat(65)}@example.com`,
      `a@${'b'.repeat(250)}.com`,
      'ana@localhost',
      'ana@example',
      'ana@-example.com',
      'ana@example..com',
      'joão@example.com',
      '.ana@example.com',
      'ana.@example.com',
      'an..a@example.com',
      '@example.com',
      'ana@',
      'ana@[127.0.0.1]',
      'ana@127.0.0.1',
      '',
      null,
      42,
    ];
    for (const v of cases) assert.equal(isSafeAddress(v), false, JSON.stringify(v));
    assert.equal(isSafeAddress(`${'a'.repeat(64)}@example.com`), true);
  });
});

describe('buildMailMessage e MIME (critérios 18 e 19)', () => {
  test('negócio com CR/LF no assunto: um só To, sem Bcc/Cc/Reply-To, Auto-Submitted, From da configuração, assunto em uma linha lógica', async () => {
    const m = message({ rendered: { subject: 'Agendamento confirmado: Corte · Salão\r\nBcc: x@y.com' } });
    assert.equal(m.subject.includes('\r'), false);
    const raw = (await composeMime(m)).toString('utf8');
    const headers = headersOf(raw);
    const names = headers.map((h) => h.slice(0, h.indexOf(':')).toLowerCase());
    assert.equal(names.filter((n) => n === 'to').length, 1);
    for (const forbidden of ['bcc', 'cc', 'reply-to']) assert.equal(names.includes(forbidden), false, forbidden);
    assert.ok(headers.includes('Auto-Submitted: auto-generated'));
    assert.ok(headers.includes('To: ana@exemplo.com.br'));
    assert.ok(headers.some((h) => /^From: .*<nao-responda@agendafacil\.invalid>$/.test(h)));
    assert.ok(headers.includes(`Message-ID: <${OUTBOX_ID}@agendafacil.invalid>`));
    assert.ok(headers.includes('Date: Thu, 26 Nov 2026 12:00:00 +0000'));
    const subject = headers.filter((h) => h.startsWith('Subject:'));
    assert.equal(subject.length, 1);
    assert.match(subject[0], /=\?UTF-8\?/i, 'RFC 2047');
    assert.match(raw, /Content-Type: multipart\/alternative/);
    assert.match(raw, /Content-Type: text\/plain; charset=utf-8/);
    assert.match(raw, /Content-Type: text\/html; charset=utf-8/);
    assert.match(raw, /Content-Type: text\/calendar; charset=UTF-8; method=PUBLISH;\s+name=agendamento\.ics/);
    assert.equal(/[^\r]\n/.test(raw), false, 'CRLF');
  });

  test('método CANCEL no Content-Type do anexo', async () => {
    const m = message({ rendered: { ics: { content: 'X\r\n', method: 'CANCEL' } } });
    assert.equal(m.attachments[0].contentType, 'text/calendar; charset=UTF-8; method=CANCEL');
  });

  test('destinatário ou remetente inseguro, ou Message-ID fora do formato: invalid_header', () => {
    for (const input of [
      { to: 'ana@example.com\r\nBcc: x@y.com' },
      { to: 'ana%0d%0a@example.com' },
      { from: { name: 'X', address: 'x@y.com\r\nBcc: z@w.com' } },
      { messageId: '<x\r\n@y.com>' },
    ]) {
      assert.throws(() => message({ input }), (err) => err instanceof PermanentMailError && err.code === 'invalid_header');
    }
  });

  test('messageIdOf', () => {
    assert.equal(messageIdOf(OUTBOX_ID, 'agendafacil.app'), `<${OUTBOX_ID}@agendafacil.app>`);
  });
});
