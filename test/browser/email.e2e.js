// E2E do e-mail de confirmação (AF-18, design 6.2) no Chromium: frase na tela de sucesso, link do
// e-mail abre o gerenciar, cancelamento com METHOD:CANCEL e o mesmo UID, remarcação com "Antes" e
// "Agora" e SEQUENCE:1, clique duplo com a mesma Idempotency-Key dá um e-mail só, e o laço do worker
// entrega sozinho. Transporte de memória (nenhuma rede real). Fora do `npm test`: `npm run test:e2e`.
/* global document */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } from '../helpers/session.js';
import { icsOf, parseIcs, linkFrom } from '../helpers/email.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';

const NOW = '2026-11-26T12:00:00.000Z';
const PHRASE = 'Enviamos os detalhes para o seu e-mail.';

let server;
let browser;
let seq = 0;
const transport = createMemoryMailTransport();

async function seedBusiness(app) {
  const cookies = await signupAndLogin(app, { email: 'dono-email@x.com' });
  await createBusinessFor(app, cookies, { name: 'Salão E-mail', slug: 'salao-email' });
  const service = await createService(app, cookies, { name: 'Corte', durationMinutes: 60, price: '50' });
  const professionals = [];
  for (const name of ['Ana Souza', 'Bia Lima']) {
    const p = await createProfessional(app, cookies, { name, serviceIds: [service.id] });
    const res = await putHours(app, cookies, p.id, WEEK_9_TO_18);
    if (res.statusCode !== 200) throw new Error(`grade: ${res.body}`);
    professionals.push(p);
  }
  return { slug: 'salao-email', service, professionals };
}

before(async () => {
  const { chromium } = loadPlaywright();
  server = await startServer({
    now: NOW,
    overrides: {
      mailTransport: transport,
      email: { worker: { enabled: true, intervalMs: 100 } }, // 100 ms: o mínimo da config (o design dizia 50)
      rateLimit: {
        enabled: true,
        publicPage: { perIp: 5000 },
        publicAvailability: { perIp: 5000 },
        publicBooking: { perIp: 5000 },
        publicManage: { perIp: 5000 },
      },
    },
    seed: async (app) => ({ main: await seedBusiness(app) }),
  });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

function customer() {
  seq += 1;
  return { name: `Cliente ${seq}`, phone: `1196${String(1000000 + seq * 41).padStart(7, '0')}`, email: `em${seq}@example.com` };
}

const runOnce = () => server.app.services.emailWorker.runOnce();
const mailsTo = (email) => transport.messages.filter((m) => m.to === email);
const subjectOf = (m) => m.subject.split(':')[0];
const confirmButton = (page) => page.locator('#bk-customer .pp-confirm-button');

/** Reserva pela página pública, no horário `time` do dia `date`, com o profissional `professional`. */
async function bookOnPage(page, { date, time, professional = 0, c, beforeConfirm }) {
  const b = server.data.main;
  await page.goto(`${server.baseUrl}/${b.slug}`, { waitUntil: 'load' });
  await page.selectOption('#bk-service', b.service.id);
  await page.selectOption('#bk-professional', b.professionals[professional].id);
  await page.fill('#bk-date', date);
  await page.locator('#bk-date').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('.pp-booking').dataset.state === 'ready');
  const slot = page.locator('.pp-slot').filter({ hasText: new RegExp(`^\\s*${time}`) });
  assert.equal(await slot.count(), 1, `horário ${time} em ${date}`);
  await slot.click();
  await page.locator('#bk-customer').waitFor({ state: 'visible' });
  await page.fill('#bk-name', c.name);
  await page.fill('#bk-phone', c.phone);
  await page.fill('#bk-email', c.email);
  if (beforeConfirm) await beforeConfirm(page);
  else await confirmButton(page).click();
  await page.locator('.pp-success').waitFor({ state: 'visible' });
}

/** Abre o CAMINHO do link (o publicBaseUrl do E2E não tem porta) e espera o resumo. */
async function openLinkPath(page, link) {
  const { pathname } = new URL(link);
  await page.goto(`${server.baseUrl}${pathname}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('main.mg').dataset.state !== 'loading');
}

describe('e-mail de confirmação (AF-18)', () => {
  test('sucesso promete o e-mail; a confirmação tem o link; o caminho do link abre o gerenciar (critérios 30 e 31)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    try {
      const c = customer();
      await bookOnPage(page, { date: '2026-11-30', time: '09:00', c });
      assert.equal((await page.locator('.pp-success-email').textContent()).trim(), PHRASE);
      await runOnce();
      const mails = mailsTo(c.email);
      assert.equal(mails.length, 1);
      assert.equal(subjectOf(mails[0]), 'Agendamento confirmado');
      const link = linkFrom(mails[0]);
      assert.ok(link, mails[0].text);
      await openLinkPath(page, link);
      assert.equal(await page.evaluate(() => document.querySelector('main.mg').dataset.state), 'summary');
      assert.equal(await page.locator('#mg-summary-titulo').textContent(), 'Agendamento confirmado');
      assert.match(await page.locator('.mg-details').innerText(), /09:00/);
    } finally {
      await context.close();
    }
  });

  test('cancelar pela página: e-mail de cancelamento com METHOD:CANCEL e o mesmo UID (critérios 21 e 31)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    try {
      const c = customer();
      await bookOnPage(page, { date: '2026-11-30', time: '10:00', c });
      await runOnce();
      const [confirmed] = mailsTo(c.email);
      await openLinkPath(page, linkFrom(confirmed));
      await page.locator('.mg-cancel-button').click();
      await page.locator('.mg-cancel-yes').click();
      await page.locator('.mg-status').waitFor({ state: 'visible' });
      await runOnce();
      const mails = mailsTo(c.email);
      assert.deepEqual(mails.map(subjectOf), ['Agendamento confirmado', 'Agendamento cancelado']);
      const a = parseIcs(icsOf(mails[0]));
      const b = parseIcs(icsOf(mails[1]));
      assert.equal(a.get('METHOD'), 'PUBLISH');
      assert.equal(b.get('METHOD'), 'CANCEL');
      assert.equal(b.get('UID'), a.get('UID'));
      assert.equal(b.get('STATUS'), 'CANCELLED');
      assert.equal(linkFrom(mails[1]), null, 'cancelamento sem link de gerenciar');
    } finally {
      await context.close();
    }
  });

  test('remarcar pela página: "Antes" e "Agora", o mesmo UID e SEQUENCE:1 (critérios 17, 21 e 31)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    try {
      const c = customer();
      const date = '2026-12-01';
      await bookOnPage(page, { date, time: '10:00', c });
      await runOnce();
      const [confirmed] = mailsTo(c.email);
      await openLinkPath(page, linkFrom(confirmed));
      await page.locator('.mg-reschedule-button').click();
      await page.waitForFunction(() => document.querySelector('main.mg').dataset.slots === 'ready');
      await page.locator('.mg-slots .pp-slot').filter({ hasText: /^\s*15:00/ }).click();
      await page.locator('.mg-reschedule-confirm').click();
      await page.locator('.mg-done').waitFor({ state: 'visible' });
      await runOnce();
      const mails = mailsTo(c.email);
      assert.deepEqual(mails.map(subjectOf), ['Agendamento confirmado', 'Agendamento remarcado']);
      const text = mails[1].text;
      assert.match(text, /Antes:[\s\S]*10:00/);
      assert.match(text, /Agora:[\s\S]*15:00/);
      assert.ok(text.indexOf('Antes:') < text.indexOf('Agora:'));
      const a = parseIcs(icsOf(mails[0]));
      const b = parseIcs(icsOf(mails[1]));
      assert.equal(b.get('UID'), a.get('UID'));
      assert.equal(a.get('SEQUENCE'), '0');
      assert.equal(b.get('SEQUENCE'), '1');
      assert.equal(b.get('METHOD'), 'PUBLISH');
      assert.ok(linkFrom(mails[1]), 'remarcação traz o link novo');
    } finally {
      await context.close();
    }
  });

  test('clique duplo e nova tentativa com a mesma Idempotency-Key: um e-mail só (critérios 4 e 31)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    try {
      const c = customer();
      const keys = [];
      await page.route('**/appointments', async (route) => {
        keys.push(route.request().headers()['idempotency-key']);
        if (keys.length === 1) {
          // O servidor grava a reserva, mas a resposta se perde: o navegador tenta de novo.
          await route.fetch();
          await route.abort('failed');
        } else await route.continue();
      });
      await bookOnPage(page, {
        date: '2026-12-02',
        time: '11:00',
        c,
        beforeConfirm: async (p) => {
          await confirmButton(p).dblclick();
          await p.locator('.pp-alert').waitFor({ state: 'visible' });
          await confirmButton(p).click();
        },
      });
      assert.equal(keys.length, 2);
      assert.equal(keys[1], keys[0]);
      await runOnce();
      await runOnce();
      assert.equal(mailsTo(c.email).length, 1);
    } finally {
      await context.close();
    }
  });

  test('o laço do worker, sem runOnce, entrega a confirmação em até 2 s (critério 7)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    try {
      assert.equal(server.app.services.emailWorker.started, true);
      const c = customer();
      await bookOnPage(page, { date: '2026-12-03', time: '09:00', c });
      const t0 = Date.now();
      while (mailsTo(c.email).length === 0 && Date.now() - t0 < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(mailsTo(c.email).length, 1, `nada em ${Date.now() - t0} ms`);
    } finally {
      await context.close();
    }
  });
});
