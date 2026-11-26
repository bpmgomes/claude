// E2E da agenda do dono (AF-14, design 6.2) no Chromium: lista do dia e da semana, filtro na URL,
// detalhe com contato, cancelamento com confirmação e e-mail, origens do cancelamento, dois donos ao
// mesmo tempo, 409 na tela, nomes maliciosos, larguras, contraste, cores forçadas, teclado, estados,
// fuso do navegador, ausência de polling e acesso sem sessão. Transporte de memória (nenhuma rede
// real). Fora do `npm test`: `npm run test:e2e`.
/* global document, window, getComputedStyle */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import { smallTargets, contrastFailures } from './a11y.js';
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18, getAvailability } from '../helpers/session.js';
import { bookReal, insertServiceDirect, insertProfessionalDirect, seedWeek, spUtc } from '../helpers/agenda.js';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { cancelManage, rescheduleManage, versionOf, getManage } from '../helpers/manage.js';
import { icsOf, parseIcs } from '../helpers/email.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';

const NOW = '2026-11-26T12:00:00.000Z'; // quinta-feira, 09:00 em São Paulo
const XSS = Object.freeze({
  customer: '<img src=x onerror=window.__x=1>',
  service: '"><script>window.__y=1</script>',
  professional: '=HYPERLINK("http://x")<img src=x onerror=window.__x=2>',
  reason: '"><script>window.__y=2</script>',
  email: '=hyperlink("http://x")<img/src=x/onerror=window.__x=3>@x.com',
});
const LONG = 'A'.repeat(60);

let server;
let browser;
const transport = createMemoryMailTransport();

async function seed(app) {
  const cookies = await signupAndLogin(app, { email: 'dono-agenda@x.com' });
  const business = await createBusinessFor(app, cookies, { name: 'Salão Agenda', slug: 'salao-agenda' });
  const service = await createService(app, cookies, { name: 'Corte', durationMinutes: 60, price: '50' });
  const pros = [];
  for (const name of ['Ana Souza', 'Bia Lima']) {
    const p = await createProfessional(app, cookies, { name, serviceIds: [service.id] });
    const res = await putHours(app, cookies, p.id, WEEK_9_TO_18);
    if (res.statusCode !== 200) throw new Error(`grade: ${res.body}`);
    pros.push(p);
  }
  // Profissional removido (sem agendamentos): o uuid dele na URL cai em "Todos".
  const gone = await createProfessional(app, cookies, { name: 'Caio Removido', serviceIds: [service.id] });
  const del = await app.inject({ method: 'DELETE', url: `/api/professionals/${gone.id}`, cookies, headers: { 'sec-fetch-site': 'same-origin' } });
  if (del.statusCode !== 204) throw new Error(`remoção: ${del.statusCode} ${del.body}`);

  const db = app.db;
  const customerId = await insertCustomerDirect(db, business.id, { email: 'cliente-direto@example.com' });
  // Nomes maliciosos e longos (INSERT direto: a validação de entrada não é o que se testa aqui).
  const evilService = await insertServiceDirect(db, business.id, { name: XSS.service });
  const evilPro = await insertProfessionalDirect(db, business.id, XSS.professional);
  const longPro = await insertProfessionalDirect(db, business.id, LONG);
  const evilCustomerId = await insertCustomerDirect(db, business.id, { email: XSS.email });
  const evil = await insertAppointmentDirect(db, {
    businessId: business.id, professionalId: evilPro, customerId: evilCustomerId, serviceId: evilService, serviceName: XSS.service,
    customerName: XSS.customer, startsAt: spUtc('2026-12-07T10:00'),
  });
  await insertAppointmentDirect(db, {
    businessId: business.id, professionalId: longPro, customerId, serviceId: evilService, serviceName: LONG,
    customerName: LONG, startsAt: spUtc('2026-12-07T11:00'),
  });
  await db.run(
    `INSERT INTO time_blocks (id, business_id, professional_id, starts_at, ends_at, reason_kind, reason_note, created_at)
     VALUES (?, ?, NULL, ?, ?, 'other', ?, ?)`,
    [randomUUID(), business.id, spUtc('2026-12-07T14:00'), spUtc('2026-12-07T15:00'), XSS.reason, NOW],
  );
  // Todos os status no mesmo dia (terça 08/12), para legenda, contraste, cores forçadas e teclado.
  const statusDay = '2026-12-08';
  const statusRows = [
    ['confirmed', null, '09:00'],
    ['completed', null, '10:00'],
    ['no_show', null, '11:00'],
    ['cancelled', 'owner', '13:00'],
    ['cancelled', 'customer', '14:00'],
    ['cancelled', 'reschedule', '15:00'],
  ];
  for (const [status, by, time] of statusRows) {
    const id = await insertAppointmentDirect(db, {
      businessId: business.id, professionalId: pros[1].id, customerId, serviceId: service.id, customerName: `Status ${status} ${by ?? ''}`.trim(),
      startsAt: spUtc(`${statusDay}T${time}`), status,
    });
    if (by) await db.run('UPDATE appointments SET cancelled_by = ? WHERE id = ?', [by, id]);
  }
  // Semana com 1.001 agendamentos (teto de 1.000): 11 a 17/01/2027, 11 profissionais x 7 dias x 13.
  await seedWeek(db, {
    businessId: business.id,
    serviceId: service.id,
    days: ['2027-01-11', '2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15', '2027-01-16', '2027-01-17'],
    perDay: 13,
    professionals: 11,
  });
  return { cookies, business, service, pros, gone, evil, statusDay };
}

before(async () => {
  const { chromium } = loadPlaywright();
  server = await startServer({
    now: NOW,
    overrides: {
      mailTransport: transport,
      email: { worker: { enabled: true, intervalMs: 60_000 } },
      rateLimit: {
        enabled: true,
        publicPage: { perIp: 5000 },
        publicAvailability: { perIp: 5000 },
        publicBooking: { perIp: 5000 },
        publicManage: { perIp: 5000 },
        agendaRead: { perUser: 5000, perIp: 5000 },
        agendaCancel: { perUser: 5000, perIp: 5000 },
      },
    },
    seed,
  });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

const ctxOf = () => ({ business: server.data.business, service: server.data.service, pros: server.data.pros });
const runOnce = () => server.app.services.emailWorker.runOnce();
const mailsTo = (email) => transport.messages.filter((m) => m.to === email);

async function ownerContext(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  await context.addCookies([{ name: 'af_session', value: server.data.cookies.af_session, url: server.baseUrl }]);
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective));
  });
  return context;
}

const loads = (page) => page.evaluate(() => Number(document.getElementById('agenda-section').dataset.loads || 0));

/** Espera a próxima leitura terminar depois de `action` (contador `data-loads` da seção). */
async function afterReload(page, action) {
  const before = await loads(page);
  await action();
  await page.waitForFunction((n) => Number(document.getElementById('agenda-section').dataset.loads || 0) > n, before);
}

async function openAgenda(page, query = '') {
  await page.goto(`${server.baseUrl}/agenda${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const s = document.getElementById('agenda-section');
    return s && Number(s.dataset.loads || 0) > 0 && s.dataset.state !== 'loading';
  });
}

const itemButton = (page, text) => page.locator('button.ag-item').filter({ hasText: text });

async function openDetail(page, text) {
  await itemButton(page, text).first().click();
  await page.waitForFunction(() => !document.getElementById('detail-list').hidden || document.getElementById('detail-alert').textContent !== '');
}

describe('lista, detalhe e filtro (critérios 17 a 20 e 42)', () => {
  test('reserva pela página pública aparece no Dia e na Semana; detalhe com tel: e e-mail; copiar e-mail', async () => {
    const customer = { name: 'Bia Cliente', phone: '11961234567', email: 'bia-e2e@example.com' };
    const pub = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const pp = await pub.newPage();
    const { slug } = server.data.business;
    await pp.goto(`${server.baseUrl}/${slug}`, { waitUntil: 'load' });
    await pp.selectOption('#bk-service', server.data.service.id);
    await pp.selectOption('#bk-professional', server.data.pros[0].id);
    await pp.fill('#bk-date', '2026-11-27');
    await pp.locator('#bk-date').dispatchEvent('change');
    await pp.waitForFunction(() => document.querySelector('.pp-booking').dataset.state === 'ready');
    await pp.locator('.pp-slot').filter({ hasText: /^\s*10:00/ }).click();
    await pp.locator('#bk-customer').waitFor({ state: 'visible' });
    await pp.fill('#bk-name', customer.name);
    await pp.fill('#bk-phone', customer.phone);
    await pp.fill('#bk-email', customer.email);
    await pp.locator('#bk-customer .pp-confirm-button').click();
    await pp.locator('.pp-success').waitFor({ state: 'visible' });
    await pub.close();

    const context = await ownerContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.baseUrl });
    const page = await context.newPage();
    try {
      await openAgenda(page, '?view=day&date=2026-11-27');
      assert.equal(await page.locator('#agenda-title').textContent(), 'sexta-feira, 27/11/2026');
      const item = itemButton(page, 'Bia Cliente');
      assert.equal(await item.count(), 1);
      const text = await item.innerText();
      for (const part of ['10:00 às 11:00', 'Corte', 'Bia Cliente', 'Ana Souza', 'Confirmado']) assert.ok(text.includes(part), part);

      await afterReload(page, () => page.click('#view-week'));
      assert.equal(await page.locator('#agenda-title').textContent(), 'Semana de 23/11 a 29/11');
      assert.equal(await itemButton(page, 'Bia Cliente').count(), 1);
      assert.match(page.url(), /view=week&date=2026-11-27/);

      await openDetail(page, 'Bia Cliente');
      assert.equal(await page.locator('#detail-call').getAttribute('href'), 'tel:+5511961234567');
      assert.equal(await page.locator('#detail-email').textContent(), customer.email);
      assert.equal(await page.locator('#detail-dialog a[href^="mailto:"]').count(), 0);
      await page.click('#copy-email');
      await page.waitForFunction(() => document.getElementById('copy-status').textContent !== '');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), customer.email);
      // Nada de dado pessoal na URL nem no storage.
      assert.ok(!page.url().includes('bia'));
      assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    } finally {
      await context.close();
    }
  });

  test('filtro por profissional na URL sobrevive a Próximo/Anterior/Hoje; removido cai em "Todos" com aviso', async () => {
    const [ana, bia] = server.data.pros;
    await bookReal(server.app, ctxOf(), { start: '2026-11-30T10:00', professional: 0, customer: { name: 'Filtro Ana', phone: '11962000001', email: 'f-ana@example.com' } });
    await bookReal(server.app, ctxOf(), { start: '2026-11-30T11:00', professional: 1, customer: { name: 'Filtro Bia', phone: '11962000002', email: 'f-bia@example.com' } });
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      await openAgenda(page, '?view=day&date=2026-11-30');
      assert.equal(await itemButton(page, 'Filtro').count(), 2);
      await afterReload(page, () => page.selectOption('#agenda-professional', bia.id));
      assert.equal(await itemButton(page, 'Filtro Ana').count(), 0);
      assert.equal(await itemButton(page, 'Filtro Bia').count(), 1);
      assert.ok(page.url().includes(`professional=${bia.id}`));
      await afterReload(page, () => page.click('#next'));
      assert.ok(page.url().includes(`professional=${bia.id}`) && page.url().includes('date=2026-12-01'));
      await afterReload(page, () => page.click('#prev'));
      await afterReload(page, () => page.click('#today'));
      assert.ok(page.url().includes(`professional=${bia.id}`) && page.url().includes('date=2026-11-26'));
      assert.equal(await page.locator('#agenda-professional').inputValue(), bia.id);
      assert.notEqual(ana.id, bia.id);

      await openAgenda(page, `?view=week&date=2026-11-30&professional=${server.data.gone.id}`);
      assert.equal(await page.locator('#agenda-professional').inputValue(), 'all');
      assert.equal(await page.locator('#filter-notice').textContent(), 'O profissional escolhido não está mais disponível. Mostrando todos.');
      assert.ok(!page.url().includes(server.data.gone.id));
      assert.equal(await itemButton(page, 'Filtro').count(), 2);
    } finally {
      await context.close();
    }
  });
});

describe('cancelamento (critérios 9, 11, 12, 21, 24, 39)', () => {
  test('confirmação com foco em Voltar; sucesso; some e conta oculto; riscado com a origem; horário volta; e-mail CANCEL; link mostra cancelado', async () => {
    const b = await bookReal(server.app, ctxOf(), { start: '2026-12-01T10:00', customer: { name: 'Cancela Dono', phone: '11963000001', email: 'cancela-dono@example.com' } });
    await runOnce();
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      await openAgenda(page, '?view=day&date=2026-12-01');
      await openDetail(page, 'Cancela Dono');
      await page.click('#detail-cancel');
      await page.locator('#cancel-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'cancel-back');
      assert.equal(
        await page.locator('#cancel-question').textContent(),
        'Cancelar o agendamento de Cancela Dono em 01/12 às 10:00? O cliente será avisado por e-mail.',
      );
      await afterReload(page, () => page.click('#cancel-confirm'));
      assert.equal(await page.locator('#page-status').textContent(), 'Agendamento cancelado. O aviso ao cliente será enviado por e-mail.');
      assert.equal(await page.locator('#detail-dialog').evaluate((d) => d.open), false);
      assert.equal(await itemButton(page, 'Cancela Dono').count(), 0);
      assert.match(await page.locator('.ag-day').first().innerText(), /1 cancelado oculto/);

      await afterReload(page, () => page.check('#show-cancelled'));
      const struck = itemButton(page, 'Cancela Dono');
      assert.equal(await struck.count(), 1);
      assert.match(await struck.innerText(), /Cancelado pelo estabelecimento/);
      assert.equal(await struck.locator('.ag-struck').evaluate((el) => getComputedStyle(el).textDecorationLine), 'line-through');
      assert.ok(!page.url().includes('cancel'), 'o interruptor não vai para a URL');

      const avail = await getAvailability(server.app, server.data.business.slug, {
        serviceId: server.data.service.id, professionalId: server.data.pros[0].id, from: '2026-12-01', to: '2026-12-01',
      });
      assert.ok(JSON.stringify(avail.json()).includes('2026-12-01T10:00'), 'o horário volta a ser oferecido');

      await runOnce();
      const mail = mailsTo(b.customer.email).find((m) => m.subject.startsWith('Agendamento cancelado pelo estabelecimento'));
      assert.ok(mail);
      assert.equal(parseIcs(icsOf(mail)).get('METHOD'), 'CANCEL');
      assert.equal((await getManage(server.app, b.token)).json().appointment.status, 'cancelled');
    } finally {
      await context.close();
    }
  });

  test('cliente cancela pelo link: "Cancelado pelo cliente"; cliente remarca: antigo "Remarcado" só com o interruptor, novo com "Remarcado de"', async () => {
    const a = await bookReal(server.app, ctxOf(), { start: '2026-12-02T10:00', customer: { name: 'Pelo Link', phone: '11964000001', email: 'pelo-link@example.com' } });
    const r = await bookReal(server.app, ctxOf(), { start: '2026-12-02T11:00', customer: { name: 'Remarca Link', phone: '11964000002', email: 'remarca-link@example.com' } });
    assert.equal((await cancelManage(server.app, a.token, { version: await versionOf(server.app, a.token) })).statusCode, 200);
    assert.equal((await rescheduleManage(server.app, r.token, { start: '2026-12-02T15:00', version: await versionOf(server.app, r.token) })).statusCode, 200);
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      await openAgenda(page, '?view=day&date=2026-12-02');
      assert.equal(await itemButton(page, 'Pelo Link').count(), 0);
      assert.equal(await itemButton(page, 'Remarca Link').count(), 1, 'só o novo');
      assert.match(await itemButton(page, 'Remarca Link').innerText(), /15:00/);
      assert.match(await page.locator('.ag-day').first().innerText(), /1 cancelado e 1 remarcado ocultos/);
      await afterReload(page, () => page.check('#show-cancelled'));
      assert.match(await itemButton(page, 'Pelo Link').innerText(), /Cancelado pelo cliente/);
      const old = itemButton(page, 'Remarca Link').filter({ hasText: '11:00' });
      assert.match(await old.innerText(), /Remarcado/);
      await itemButton(page, 'Remarca Link').filter({ hasText: '15:00' }).click();
      await page.locator('#detail-list').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#detail-chain').innerText(), 'Remarcado de 02/12 11:00');
    } finally {
      await context.close();
    }
  });

  test('dois donos cancelando o mesmo ao mesmo tempo: um "cancelado", outro "já estava cancelado"; um e-mail só', async () => {
    const b = await bookReal(server.app, ctxOf(), { start: '2026-12-03T10:00', customer: { name: 'Dois Donos', phone: '11965000001', email: 'dois-donos@example.com' } });
    await runOnce();
    const c1 = await ownerContext();
    const c2 = await ownerContext();
    try {
      const pages = [await c1.newPage(), await c2.newPage()];
      for (const page of pages) {
        await openAgenda(page, '?view=day&date=2026-12-03');
        await openDetail(page, 'Dois Donos');
        await page.click('#detail-cancel');
        await page.locator('#cancel-dialog').waitFor({ state: 'visible' });
      }
      await Promise.all(pages.map((page) => afterReload(page, () => page.click('#cancel-confirm'))));
      const messages = (await Promise.all(pages.map((p) => p.locator('#page-status').textContent()))).sort();
      assert.deepEqual(messages, ['Agendamento cancelado. O aviso ao cliente será enviado por e-mail.', 'Este agendamento já estava cancelado.'].sort());
      await runOnce();
      assert.equal(mailsTo(b.customer.email).filter((m) => m.subject.startsWith('Agendamento cancelado pelo estabelecimento')).length, 1);
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  test('409 na tela: o cliente remarca com o detalhe aberto; alerta role=alert e a agenda mostra o novo', async () => {
    const b = await bookReal(server.app, ctxOf(), { start: '2026-12-04T10:00', customer: { name: 'Mudou Antes', phone: '11966000001', email: 'mudou@example.com' } });
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      await openAgenda(page, '?view=day&date=2026-12-04');
      await openDetail(page, 'Mudou Antes');
      await page.click('#detail-cancel');
      assert.equal((await rescheduleManage(server.app, b.token, { start: '2026-12-04T16:00', version: await versionOf(server.app, b.token) })).statusCode, 200);
      await afterReload(page, () => page.click('#cancel-confirm'));
      const alert = page.locator('#detail-alert');
      assert.equal(await alert.getAttribute('role'), 'alert');
      assert.equal(await alert.textContent(), 'Este agendamento mudou desde que a agenda foi carregada. Confira a situação atual.');
      assert.equal(await page.locator('#cancel-dialog').evaluate((d) => d.open), false);
      // F4: o foco não cai no <body> quando o botão "Cancelar agendamento" some.
      const focused = await page.evaluate(() => ({ tag: document.activeElement.tagName, id: document.activeElement.id }));
      assert.notEqual(focused.tag, 'BODY');
      assert.equal(focused.id, 'detail-alert');
      assert.equal(await page.locator('#detail-cancel').isHidden(), true);
      await page.click('#detail-close');
      assert.match(await itemButton(page, 'Mudou Antes').innerText(), /16:00/);
    } finally {
      await context.close();
    }
  });
});

describe('segurança e layout (critérios 31 e 37)', () => {
  test('nomes maliciosos: texto literal na lista, no detalhe e na confirmação; nenhum script; CSP sem unsafe-inline', async () => {
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      const response = await page.goto(`${server.baseUrl}/agenda?view=day&date=2026-12-07`, { waitUntil: 'load' });
      assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
      await page.waitForFunction(() => Number(document.getElementById('agenda-section').dataset.loads || 0) > 0);
      const list = await page.locator('#agenda-days').innerText();
      for (const s of [XSS.customer, XSS.service, XSS.professional, XSS.reason]) assert.ok(list.includes(s), s);
      await openDetail(page, XSS.customer);
      const detail = await page.locator('#detail-dialog').innerText();
      for (const s of [XSS.customer, XSS.service, XSS.professional]) assert.ok(detail.includes(s), s);
      assert.equal(await page.locator('#detail-email').textContent(), XSS.email);
      assert.equal(await page.locator('#detail-dialog a[href^="mailto:"]').count(), 0);
      await page.click('#detail-cancel');
      assert.ok((await page.locator('#cancel-question').textContent()).includes(XSS.customer));
      assert.equal(await page.locator('#agenda-days img, #detail-dialog img, #agenda-days script').count(), 0);
      assert.deepEqual(await page.evaluate(() => [window.__x, window.__y, window.__csp]), [undefined, undefined, []]);
    } finally {
      await context.close();
    }
  });

  for (const width of [360, 768, 1280]) {
    test(`${width} px: sem rolagem horizontal, alvos de 44 x 44 e diálogo na largura`, async () => {
      const context = await ownerContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      try {
        await openAgenda(page, '?view=week&date=2026-12-07');
        assert.ok((await itemButton(page, LONG).count()) >= 1);
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok((await overflow()) <= 0, `scrollWidth ${await overflow()}`);
        assert.deepEqual(await smallTargets(page, 'main'), []);
        await openDetail(page, LONG);
        const box = await page.locator('#detail-dialog').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
        assert.deepEqual(await smallTargets(page, '#detail-dialog'), []);
        assert.ok((await overflow()) <= 0);
      } finally {
        await context.close();
      }
    });
  }
});

describe('contraste, cores forçadas e teclado (critérios 36, 38 e 40)', () => {
  test('contraste AA nos textos e 3:1 nas bordas e ícones; diálogos também', async () => {
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      await openAgenda(page, `?view=day&date=${server.data.statusDay}`);
      await afterReload(page, () => page.check('#show-cancelled'));
      assert.deepEqual(await contrastFailures(page, { root: 'main', borders: true }), []);
      await openDetail(page, 'Status confirmed');
      assert.deepEqual(await contrastFailures(page, { root: '#detail-dialog' }), []);
      await page.click('#detail-cancel');
      assert.deepEqual(await contrastFailures(page, { root: '#cancel-dialog' }), []);
    } finally {
      await context.close();
    }
  });

  for (const mode of ['forced-colors', 'grayscale']) {
    test(`${mode}: cada status com rótulo e ícone distintos e visíveis`, async () => {
      const context = await ownerContext();
      const page = await context.newPage();
      try {
        if (mode === 'forced-colors') await page.emulateMedia({ forcedColors: 'active' });
        await openAgenda(page, `?view=day&date=${server.data.statusDay}`);
        if (mode === 'grayscale') {
          // Folha de estilo de teste servida na mesma origem (a CSP recusa estilo inline).
          await page.route('**/css/test-grayscale.css', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: 'html { filter: grayscale(1); }' }));
          await page.addStyleTag({ url: '/css/test-grayscale.css' });
          assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).filter), 'grayscale(1)');
        }
        await afterReload(page, () => page.check('#show-cancelled'));
        const items = await page.evaluate(() =>
          [...document.querySelectorAll('.ag-item')].map((el) => {
            const icon = el.querySelector('.ag-icon');
            const label = el.querySelector('.ag-label');
            const visible = (n) => n && n.getBoundingClientRect().width > 0 && getComputedStyle(n).visibility !== 'hidden';
            return {
              icon: icon.textContent,
              label: label.textContent,
              ok: visible(icon) && visible(label) && getComputedStyle(el).borderLeftStyle !== 'none',
            };
          }),
        );
        assert.ok(items.length >= 6, JSON.stringify(items));
        assert.ok(items.every((i) => i.ok), JSON.stringify(items));
        const pairs = new Map(items.map((i) => [i.label, i.icon]));
        assert.ok(pairs.size >= 5, JSON.stringify([...pairs]));
        assert.equal(new Set(pairs.values()).size, pairs.size, 'ícones distintos');
        const legend = await page.locator('#agenda-legend li').allInnerTexts();
        assert.equal(new Set(legend).size, legend.length);
      } finally {
        await context.close();
      }
    });
  }

  test('teclado: Tab até o item, Enter abre o detalhe, Esc fecha e o foco volta; Esc na confirmação volta; nome acessível com o status', async () => {
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      await openAgenda(page, `?view=day&date=${server.data.statusDay}`);
      assert.equal(await page.getByRole('button', { name: /Confirmado/ }).count(), 1);
      assert.ok((await page.getByRole('button', { name: /Concluído/ }).count()) >= 1);
      const target = 'Status confirmed';
      let found = false;
      for (let i = 0; i < 40 && !found; i++) {
        await page.keyboard.press('Tab');
        found = await page.evaluate((t) => document.activeElement.classList.contains('ag-item') && document.activeElement.textContent.includes(t), target);
      }
      assert.ok(found, 'item alcançado pelo Tab');
      await page.keyboard.press('Enter');
      await page.locator('#detail-list').waitFor({ state: 'visible' });
      assert.ok(await page.evaluate(() => document.getElementById('detail-dialog').contains(document.activeElement)));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('detail-dialog').open);
      assert.ok(await page.evaluate((t) => document.activeElement.classList.contains('ag-item') && document.activeElement.textContent.includes(t), target));

      await page.keyboard.press('Space');
      await page.locator('#detail-list').waitFor({ state: 'visible' });
      // Tab real (sem .focus()) até "Cancelar agendamento" dentro do diálogo.
      let onCancel = false;
      for (let i = 0; i < 20 && !onCancel; i++) {
        await page.keyboard.press('Tab');
        onCancel = await page.evaluate(() => document.activeElement.id === 'detail-cancel');
      }
      assert.ok(onCancel, '#detail-cancel alcançado pelo Tab');
      await page.keyboard.press('Enter');
      await page.locator('#cancel-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'cancel-back');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('cancel-dialog').open);
      assert.equal(await page.locator('#detail-dialog').evaluate((d) => d.open), true);
      assert.equal(await page.locator('#page-status').getAttribute('aria-live'), 'polite');
    } finally {
      await context.close();
    }
  });
});

describe('estados, fuso, polling e acesso (critérios 2, 4, 33, 35 e 40)', () => {
  test('vazio com os dois atalhos; erro com "Tentar de novo"; truncado; carregando', async () => {
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      await openAgenda(page, '?view=day&date=2026-12-13');
      assert.equal(await page.locator('#empty-state').isVisible(), true);
      assert.equal(await page.locator('#public-link').getAttribute('href'), 'http://127.0.0.1/salao-agenda');
      assert.equal(await page.locator('#empty-state a[href="/bloqueios"]').count(), 1);

      let fail = true;
      await page.route('**/api/agenda?*', async (route) => {
        if (fail) {
          fail = false;
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AGENDA_UNAVAILABLE', message: 'Não foi possível carregar a agenda agora. Tente novamente em instantes.' } }) });
        } else await route.continue();
      });
      await afterReload(page, () => page.click('#refresh'));
      assert.equal(await page.locator('#agenda-error').isVisible(), true);
      assert.equal(await page.locator('#agenda-error-text').textContent(), 'Não foi possível carregar a agenda agora. Tente novamente em instantes.');
      await afterReload(page, () => page.click('#retry'));
      assert.equal(await page.locator('#agenda-error').isVisible(), false);
      await page.unroute('**/api/agenda?*');

      await openAgenda(page, '?view=week&date=2027-01-13');
      assert.equal(await page.locator('#truncated').isVisible(), true);
      assert.equal(await page.locator('.ag-item').count(), 1000);

      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/api/agenda?*', async (route) => {
        await gate;
        await route.continue();
      });
      await page.click('#refresh');
      await page.waitForFunction(() => document.getElementById('page-status').textContent === 'Carregando agenda…');
      release();
      await page.waitForFunction(() => document.getElementById('page-status').textContent === 'Agenda atualizada.');
    } finally {
      await context.close();
    }
  });

  test('navegador em Asia/Tokyo: "Hoje" = 26/11, os mesmos horários e o fuso do negócio', async () => {
    await bookReal(server.app, ctxOf(), { start: '2026-11-26T16:00', customer: { name: 'Fuso Tokyo', phone: '11967000001', email: 'tokyo@example.com' } });
    const context = await ownerContext({ timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
    const page = await context.newPage();
    try {
      await openAgenda(page);
      assert.equal(await page.locator('#agenda-title').textContent(), 'quinta-feira, 26/11/2026');
      assert.equal(await page.locator('#agenda-timezone').textContent(), 'Horários no fuso America/Sao_Paulo');
      assert.match(await itemButton(page, 'Fuso Tokyo').innerText(), /16:00 às 17:00/);
      assert.match(page.url(), /date=2026-11-26/);
      await afterReload(page, () => page.click('#view-week'));
      assert.equal(await page.locator('#agenda-title').textContent(), 'Semana de 23/11 a 29/11');
      await afterReload(page, () => page.click('#next'));
      await afterReload(page, () => page.click('#today'));
      assert.match(page.url(), /date=2026-11-26/);
    } finally {
      await context.close();
    }
  });

  test('sem polling: nenhuma leitura em 3 s parado; "Atualizar" faz uma', async () => {
    const context = await ownerContext();
    const page = await context.newPage();
    try {
      await openAgenda(page, '?view=day&date=2026-11-27');
      const calls = [];
      page.on('request', (r) => {
        if (new URL(r.url()).pathname === '/api/agenda') calls.push(r.url());
      });
      await page.waitForTimeout(3000);
      assert.equal(calls.length, 0);
      await afterReload(page, () => page.click('#refresh'));
      assert.equal(calls.length, 1);
    } finally {
      await context.close();
    }
  });

  test('/agenda sem sessão: HTML estático sem o nome do negócio e redireciona para /login', async () => {
    const res = await fetch(`${server.baseUrl}/agenda`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('Salão Agenda'));
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const requests = [];
      page.on('request', (r) => requests.push(new URL(r.url()).pathname));
      await page.goto(`${server.baseUrl}/agenda`, { waitUntil: 'load' });
      await page.waitForURL('**/login');
      assert.ok(!requests.includes('/api/agenda'), 'nenhuma leitura da agenda sem sessão');
    } finally {
      await context.close();
    }
  });
});
