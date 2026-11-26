// AF-18 (critérios 12 a 17): modelos dos e-mails, escape, links, privacidade e fuso.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderAppointmentEmail } from '../../src/modules/email/templates/appointment-email.js';
import { escapeHtml } from '../../src/http/html.js';
import { EMAIL_MESSAGES as EM } from '../../src/modules/email/email-messages.js';
import { parseIcs } from '../helpers/email.js';

const BASE = 'https://agendafacil.app';
const TOKEN = 'A'.repeat(43);
const MANAGE = `${BASE}/agendamento/${TOKEN}`;
const NOW_MS = Date.parse('2026-11-26T12:00:00.000Z');
const ROOT = '11111111-1111-4111-8111-111111111111';

function business(over = {}) {
  return {
    name: 'Salão da Ana',
    address: 'Rua A, 10',
    phone: '11912345678',
    slug: 'salao-da-ana',
    timezone: 'America/Sao_Paulo',
    cancellationLeadMinutes: 120,
    ...over,
  };
}

function row(over = {}) {
  return {
    id: ROOT,
    businessId: 'b',
    professionalId: 'p1',
    customerId: 'c',
    serviceId: 's',
    serviceName: 'Corte',
    durationMinutes: 60,
    priceCents: 5000,
    customerName: 'Ana Cliente',
    customerPhone: '21987654321',
    startsAt: '2026-11-27T13:00:00.000Z', // 10:00 em São Paulo
    endsAt: '2026-11-27T14:00:00.000Z',
    status: 'confirmed',
    professionalName: 'Bia Lima',
    ...over,
  };
}

function render(over = {}) {
  return renderAppointmentEmail({
    kind: 'appointment_confirmed',
    business: business(over.business),
    appointment: row(over.appointment),
    previous: over.previous,
    chain: { rootAppointmentId: ROOT, sequence: 0, ...over.chain },
    manageUrl: 'manageUrl' in over ? over.manageUrl : MANAGE,
    publicBaseUrl: BASE,
    nowMs: over.nowMs ?? NOW_MS,
    requireHttps: over.requireHttps ?? true,
    ...(over.kind ? { kind: over.kind } : {}),
  });
}

const hrefsOf = (htmlText) => [...htmlText.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe('appointment_confirmed (critérios 12, 14 e 15)', () => {
  test('assunto, saudação, data por extenso, fuso, serviço, profissional, negócio, link, política e segurança', () => {
    const r = render();
    assert.equal(r.subject, 'Agendamento confirmado: Corte em 27/11, 10:00 · Salão da Ana');
    for (const part of [
      'Olá, Ana Cliente,',
      EM.introConfirmed,
      'sexta-feira, 27/11/2026, das 10:00 às 11:00',
      'Horários no fuso America/Sao_Paulo.',
      'Corte (1 h, R$ 50,00)',
      'Profissional: Bia Lima',
      'Salão da Ana',
      'Rua A, 10',
      '(11) 91234-5678',
      `Cancelar ou remarcar: ${MANAGE}`,
      'Você pode cancelar ou remarcar por este link até 2 h antes do horário.',
      'Prazo: até sex, 27/11 às 08:00.',
      'Você pode remarcar online até 3 vezes.',
      EM.securityKeep,
      EM.securityNotYou,
      EM.footer,
    ]) {
      assert.ok(r.text.includes(part), `texto: ${part}`);
    }
    assert.ok(r.html.includes(escapeHtml(EM.securityKeep)));
    assert.ok(r.html.startsWith('<!doctype html>'));
    assert.match(r.html, /<html lang="pt-BR">/);
    assert.match(r.html, /<meta charset="utf-8">/);
    assert.equal(r.ics.method, 'PUBLISH');
  });

  test('sob consulta; política com a antecedência ATUAL; prazo vencido mostra o telefone', () => {
    assert.ok(render({ appointment: { priceCents: null } }).text.includes('Corte (1 h, Sob consulta)'));
    const lead0 = render({ business: { cancellationLeadMinutes: 0 } });
    assert.ok(lead0.text.includes('até o horário de início'));
    assert.ok(render({ business: { cancellationLeadMinutes: 1440 } }).text.includes('até 24 h antes'));
    const late = render({ nowMs: Date.parse('2026-11-27T12:00:00.000Z') }); // 09:00 local: prazo das 08:00 passou
    assert.ok(late.text.includes(EM.deadlinePassed('(11) 91234-5678')));
    assert.equal(late.text.includes('Prazo: até'), false);
  });

  test('privacidade: nada do telefone nem do e-mail do cliente', () => {
    const r = render();
    for (const v of ['21987654321', '(21) 98765-4321', '@example']) {
      assert.equal(r.text.includes(v), false, v);
      assert.equal(r.html.includes(v), false, v);
      assert.equal(r.ics.content.includes(v), false, v);
    }
    assert.equal(r.ics.content.includes('Ana Cliente'), false);
    assert.equal(r.ics.content.includes(TOKEN), false);
  });
});

describe('appointment_cancelled (critério 16)', () => {
  test('horário cancelado, página pública, telefone, sem link de gerenciar e .ics CANCEL', () => {
    const r = render({ kind: 'appointment_cancelled', manageUrl: undefined, appointment: { status: 'cancelled' }, chain: { sequence: 1 } });
    assert.match(r.subject, /^Agendamento cancelado: Corte em 27\/11, 10:00 · Salão da Ana$/);
    assert.ok(r.text.includes(EM.introCancelled));
    assert.ok(r.text.includes('Horário cancelado: sexta-feira, 27/11/2026, das 10:00 às 11:00'));
    assert.ok(r.text.includes(`Agendar novamente: ${BASE}/salao-da-ana`));
    assert.ok(r.text.includes('Dúvidas? Ligue para (11) 91234-5678.'));
    assert.equal(r.text.includes('/agendamento/'), false);
    assert.equal(r.html.includes('/agendamento/'), false);
    assert.equal(r.text.includes(EM.securityKeep), false);
    assert.deepEqual(hrefsOf(r.html).sort(), [`${BASE}/salao-da-ana`, 'tel:+5511912345678'].sort());
    const ics = parseIcs(r.ics.content);
    assert.equal(ics.get('METHOD'), 'CANCEL');
    assert.equal(ics.get('STATUS'), 'CANCELLED');
    assert.equal(ics.get('SEQUENCE'), '2');
  });
});

describe('appointment_rescheduled (critério 17)', () => {
  const previous = row({ id: '22222222-2222-4222-8222-222222222222', startsAt: '2026-11-27T12:00:00.000Z', endsAt: '2026-11-27T13:00:00.000Z', status: 'cancelled', professionalId: 'p0', professionalName: 'Ana Souza' });

  test('antes e agora, profissional que mudou, link, política e remarcações restantes', () => {
    const r = render({ kind: 'appointment_rescheduled', previous, chain: { sequence: 1 } });
    assert.match(r.subject, /^Agendamento remarcado: Corte para 27\/11, 10:00 · Salão da Ana$/);
    assert.ok(r.text.includes('Antes: sexta-feira, 27/11/2026, das 09:00 às 10:00'));
    assert.ok(r.text.includes('Agora: sexta-feira, 27/11/2026, das 10:00 às 11:00'));
    assert.ok(r.text.includes('Profissional: Bia Lima (antes: Ana Souza)'));
    assert.ok(r.text.includes(`Cancelar ou remarcar: ${MANAGE}`));
    assert.ok(r.text.includes('Você ainda pode remarcar online mais 2 vezes.'));
    assert.ok(render({ kind: 'appointment_rescheduled', previous, chain: { sequence: 2 } }).text.includes('mais 1 vez.'));
    assert.ok(r.text.includes(EM.securityKeep) && r.text.includes(EM.securityNotYou));
    assert.equal(parseIcs(r.ics.content).get('SEQUENCE'), '1');
  });

  test('mesmo profissional: sem "(antes: ...)"; 3ª da cadeia: sem remarcação online e com telefone', () => {
    const same = { ...previous, professionalId: 'p1', professionalName: 'Bia Lima' };
    const r = render({ kind: 'appointment_rescheduled', previous: same, chain: { sequence: 3 } });
    assert.ok(r.text.includes('Profissional: Bia Lima\n'));
    assert.equal(r.text.includes('(antes:'), false);
    assert.ok(r.text.includes(EM.rescheduleExhausted('(11) 91234-5678')));
  });

  test('sem o anterior lança', () => {
    assert.throws(() => render({ kind: 'appointment_rescheduled' }));
  });
});

describe('escape e conteúdo ativo (critério 13)', () => {
  const XSS = [`<img src=x onerror=alert(1)>`, '=HYPERLINK("http://x")', 'A & B', `"aspas" 'simples'`, 'emoji 💇‍♀️'];

  test('valores do banco aparecem escapados no HTML e literais no texto; nenhum vira tag', () => {
    const clean = render();
    const countLt = (s) => (s.match(/</g) || []).length;
    for (const v of XSS) {
      const r = render({
        appointment: { serviceName: v, professionalName: v, customerName: v },
        business: { name: v, address: v },
      });
      assert.ok(r.html.includes(escapeHtml(v)), v);
      if (/[<>&"']/.test(v)) assert.equal(r.html.includes(v), false, `cru no HTML: ${v}`);
      assert.ok(r.text.includes(v), `texto: ${v}`);
      assert.equal(countLt(r.html), countLt(clean.html), `tags: ${v}`);
      assert.equal(/[\r\n]/.test(r.subject), false);
    }
  });

  test('sem recurso externo, script nem on*=; todo href é o link, a página ou tel:', () => {
    const r = render();
    for (const forbidden of ['<img', '<script', '<link', 'src=', 'url(', '<style', '<iframe']) {
      assert.equal(r.html.toLowerCase().includes(forbidden), false, forbidden);
    }
    assert.equal(/\son[a-z]+=/i.test(r.html), false);
    assert.deepEqual(hrefsOf(r.html), [MANAGE]);
  });

  test('link fora de publicBaseUrl, sem https com requireHttps e tipo desconhecido lançam', () => {
    assert.throws(() => render({ manageUrl: 'https://evil.example/agendamento/x' }));
    assert.throws(() => render({ manageUrl: `${BASE}/outra/${TOKEN}` }));
    assert.throws(() => render({ manageUrl: undefined }));
    assert.throws(() => render({ kind: 'appointment_reminder' }));
    assert.throws(() =>
      renderAppointmentEmail({
        kind: 'appointment_confirmed', business: business(), appointment: row(), chain: { rootAppointmentId: ROOT, sequence: 0 },
        manageUrl: `http://agendafacil.app/agendamento/${TOKEN}`, publicBaseUrl: 'http://agendafacil.app', nowMs: NOW_MS, requireHttps: true,
      }),
    );
    // Sem requireHttps (dev/test), http é aceito.
    const dev = renderAppointmentEmail({
      kind: 'appointment_confirmed', business: business(), appointment: row(), chain: { rootAppointmentId: ROOT, sequence: 0 },
      manageUrl: `http://127.0.0.1/agendamento/${TOKEN}`, publicBaseUrl: 'http://127.0.0.1', nowMs: NOW_MS, requireHttps: false,
    });
    assert.ok(dev.text.includes('http://127.0.0.1/agendamento/'));
  });
});

describe('fuso (critério 33)', () => {
  test('a saída não depende de process.env.TZ', () => {
    const saved = process.env.TZ;
    const outputs = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        const r = render();
        outputs.push([r.subject, r.text, r.html].join('\n'));
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
    assert.equal(new Set(outputs).size, 1);
  });

  test('negócio em Asia/Tokyo com início às 01:00 locais mostra 01:00', () => {
    const r = render({
      business: { timezone: 'Asia/Tokyo', cancellationLeadMinutes: 0 },
      appointment: { startsAt: '2026-11-27T16:00:00.000Z', endsAt: '2026-11-27T17:00:00.000Z' },
    });
    assert.ok(r.text.includes('sábado, 28/11/2026, das 01:00 às 02:00'), r.text);
    assert.ok(r.text.includes('Horários no fuso Asia/Tokyo.'));
    assert.equal(r.subject, 'Agendamento confirmado: Corte em 28/11, 01:00 · Salão da Ana');
  });
});

describe('appointment_cancelled_by_owner (AF-14, critério 26)', () => {
  const owner = (over = {}) =>
    render({ kind: 'appointment_cancelled_by_owner', manageUrl: undefined, appointment: { status: 'cancelled', ...(over.appointment || {}) }, chain: { sequence: 0 }, ...over });

  test('assunto, introdução, horário, fuso, página pública, telefone, notYouCancelled; sem link de gerenciar; .ics CANCEL', () => {
    const r = owner();
    assert.equal(r.subject, 'Agendamento cancelado pelo estabelecimento: Corte em 27/11, 10:00 · Salão da Ana');
    for (const text of [r.text, r.html]) {
      assert.ok(text.includes(EM.introCancelledByOwner));
      assert.ok(text.includes(EM.notYouCancelled));
      assert.ok(text.includes('Horários no fuso America/Sao_Paulo.'));
      assert.ok(text.includes('Bia Lima'));
      assert.equal(text.includes('/agendamento/'), false);
      assert.equal(text.includes(EM.securityKeep), false);
      assert.equal(text.includes(EM.introCancelled), false);
    }
    assert.ok(r.text.includes('Horário cancelado: sexta-feira, 27/11/2026, das 10:00 às 11:00'));
    assert.ok(r.text.includes(`Agendar novamente: ${BASE}/salao-da-ana`));
    assert.ok(r.text.indexOf(EM.notYouCancelled) < r.text.indexOf(EM.footer));
    assert.deepEqual(hrefsOf(r.html).sort(), [`${BASE}/salao-da-ana`, 'tel:+5511912345678'].sort());
    const ics = parseIcs(r.ics.content);
    assert.equal(r.ics.method, 'CANCEL');
    assert.equal(ics.get('METHOD'), 'CANCEL');
    assert.equal(ics.get('STATUS'), 'CANCELLED');
    assert.equal(ics.get('SEQUENCE'), '1');
    // Sem telefone nem e-mail do cliente.
    for (const s of [r.text, r.html, r.ics.content]) {
      assert.equal(s.includes('21987654321'), false);
      assert.equal(s.includes('(21) 98765-4321'), false);
    }
  });

  test('com manageUrl presente lança (exigência invertida)', () => {
    assert.throws(() => owner({ manageUrl: MANAGE }), /gerenciar/);
  });

  test('escape: valores do banco escapados no HTML e literais no texto', () => {
    const clean = owner();
    const countLt = (s) => (s.match(/</g) || []).length;
    for (const v of [`<img src=x onerror=alert(1)>`, '=HYPERLINK("http://x")', `"aspas" 'simples'`, 'emoji 💇‍♀️']) {
      const r = owner({ appointment: { serviceName: v, professionalName: v, customerName: v }, business: { name: v, address: v } });
      assert.ok(r.html.includes(escapeHtml(v)), v);
      if (/[<>&"']/.test(v)) assert.equal(r.html.includes(v), false, v);
      assert.ok(r.text.includes(v), v);
      assert.equal(countLt(r.html), countLt(clean.html), v);
      assert.equal(/[\r\n]/.test(r.subject), false);
    }
  });

  test('mesma saída com TZ em UTC, Asia/Tokyo e America/Sao_Paulo', () => {
    const saved = process.env.TZ;
    const outputs = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        const r = owner();
        outputs.push([r.subject, r.text, r.html].join('\n'));
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
    assert.equal(new Set(outputs).size, 1);
  });
});
