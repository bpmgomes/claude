// E2E do gerenciar o agendamento pelo link (AF-12, design 6.2) no Chromium: link na tela de sucesso,
// resumo em 360 e 414 px, cancelar, remarcar, 409 com sugestões, prazo vencido, link inválido, tela
// do dono e XSS. Fora do `npm test`: `npm run test:e2e`. Relógio do servidor fixo: quinta
// 2026-11-26, 09:00 em São Paulo.
// Globais de navegador usados só nas funções executadas no Chromium (page.evaluate etc.; AF-20, lint).
/* global document, window */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, getAvailability, WEEK_9_TO_18 } from '../helpers/session.js';
import { bookingBody } from '../helpers/appointments.js';
import { bookWithLink, tokenOfUrl } from '../helpers/manage.js';

const NOW = '2026-11-26T12:00:00.000Z';
const FRIDAY = '2026-11-27';
const XSS = '<img src=x onerror=window.__x=1>';

let server;
let browser;
let seq = 0;

async function seedBusiness(app, { email, name, slug, serviceName = 'Corte', professionalNames = ['Ana Souza', 'Bia Lima'] }) {
  const cookies = await signupAndLogin(app, { email });
  await createBusinessFor(app, cookies, { name, slug });
  const service = await createService(app, cookies, { name: serviceName, durationMinutes: 60, price: '50' });
  const professionals = [];
  for (const pname of professionalNames) {
    const p = await createProfessional(app, cookies, { name: pname, serviceIds: [service.id] });
    const res = await putHours(app, cookies, p.id, WEEK_9_TO_18);
    if (res.statusCode !== 200) throw new Error(`grade: ${res.body}`);
    professionals.push(p);
  }
  return { slug, cookies, service, professionals };
}

before(async () => {
  const { chromium } = loadPlaywright();
  server = await startServer({
    now: NOW,
    overrides: {
      rateLimit: {
        enabled: true,
        publicPage: { perIp: 5000 },
        publicAvailability: { perIp: 5000 },
        publicBooking: { perIp: 5000 },
        publicManage: { perIp: 5000 },
      },
    },
    seed: async (app) => ({
      main: await seedBusiness(app, { email: 'dono-main@x.com', name: 'Salão Gerenciar', slug: 'gerenciar' }),
      xss: await seedBusiness(app, { email: 'dono-xss@x.com', name: 'Salão XSS', slug: 'salao-xss', serviceName: `Corte ${XSS}`, professionalNames: [`Ana ${XSS}`] }),
      deadline: await seedBusiness(app, { email: 'dono-prazo@x.com', name: 'Salão Prazo', slug: 'salao-prazo' }),
      owner: await seedBusiness(app, { email: 'dono-tela@x.com', name: 'Salão Dono', slug: 'salao-dono' }),
    }),
  });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

function customer() {
  seq += 1;
  return { name: `Cliente ${seq}`, phone: `1197${String(1000000 + seq * 37).padStart(7, '0')}`, email: `mg${seq}@example.com` };
}

/** Reserva por inject e devolve o token do link. */
async function reserve(key, start, { professional = 0 } = {}) {
  const b = server.data[key];
  const { token } = await bookWithLink(
    server.app,
    b.slug,
    bookingBody({ serviceId: b.service.id, professionalId: b.professionals[professional].id, start, customer: customer() }),
  );
  return token;
}

async function openManage(token, { width = 360, height = 800 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (req) => requests.push(req));
  await page.goto(`${server.baseUrl}/agendamento/${token}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('main.mg').dataset.state !== 'loading');
  return { context, page, requests };
}

/** Alvos visíveis com pelo menos 44 px de altura e sem rolagem horizontal (critério 13; QA L3). */
async function assertLayout(page, selectors, label) {
  for (const selector of selectors) {
    const items = page.locator(selector);
    const n = await items.count();
    assert.ok(n > 0, `${label}: ${selector}`);
    for (let i = 0; i < n; i++) {
      if (!(await items.nth(i).isVisible())) continue;
      const box = await items.nth(i).boundingBox();
      assert.ok(box && box.height >= 44, `${label}: ${selector}[${i}] ${box && box.height}`);
    }
  }
  const layout = await page.evaluate(() => ({ vw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  assert.ok(layout.sw <= layout.vw, `${label}: ${layout.sw} > ${layout.vw}`);
}

const state = (page) => page.evaluate(() => document.querySelector('main.mg').dataset.state);

async function waitSlots(page) {
  await page.waitForFunction(() => document.querySelector('main.mg').dataset.slots === 'ready');
}

async function freeAt(key, date, professional = 0) {
  const b = server.data[key];
  const res = await getAvailability(server.app, b.slug, { serviceId: b.service.id, professionalId: b.professionals[professional].id, from: date, to: date });
  return (res.json().days.find((d) => d.date === date)?.slots ?? []).map((s) => s.start.slice(11));
}

describe('gerenciar o agendamento (AF-12)', () => {
  test('reservar pela página pública mostra "Gerenciar agendamento" e a política; nada guardado; recarregar perde o link (critérios 8 e 9)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    try {
      const b = server.data.main;
      await page.goto(`${server.baseUrl}/${b.slug}`, { waitUntil: 'load' });
      await page.selectOption('#bk-service', b.service.id);
      await page.selectOption('#bk-professional', b.professionals[1].id);
      await page.fill('#bk-date', '2026-12-01');
      await page.locator('#bk-date').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('.pp-booking').dataset.state === 'ready');
      await page.locator('.pp-slot').first().click();
      await page.locator('#bk-customer').waitFor({ state: 'visible' });
      const c = customer();
      await page.fill('#bk-name', c.name);
      await page.fill('#bk-phone', c.phone);
      await page.fill('#bk-email', c.email);
      await page.locator('#bk-customer .pp-confirm-button').click();
      await page.locator('.pp-success').waitFor({ state: 'visible' });
      const block = page.locator('.pp-success-manage');
      assert.equal(await block.isVisible(), true);
      const link = page.locator('.pp-success-manage-link');
      assert.match(await link.textContent(), /Gerenciar agendamento/);
      const href = await link.getAttribute('href');
      assert.ok(tokenOfUrl(href), href);
      assert.equal(await link.getAttribute('rel'), 'noreferrer');
      assert.match(await page.locator('.pp-success-policy').textContent(), /até 2 h antes do horário/);
      assert.equal(await page.locator('.pp-success-manage-url').textContent(), href);
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      await page.reload({ waitUntil: 'load' });
      assert.equal(await page.locator('.pp-success-manage').isVisible(), false);
      assert.equal((await page.content()).includes(tokenOfUrl(href)), false);
    } finally {
      await context.close();
    }
  });

  for (const width of [360, 414]) {
    test(`${width} px: resumo, prazo, Cancelar e Remarcar; sem rolagem horizontal; alvos de 44 px; sem Referer (critérios 10, 13 e 14)`, async () => {
      const token = await reserve('main', `${FRIDAY}T${width === 360 ? '09:00' : '11:00'}`);
      const { context, page, requests } = await openManage(token, { width });
      try {
        assert.equal(await state(page), 'summary');
        assert.equal(await page.locator('#mg-summary-titulo').textContent(), 'Agendamento confirmado');
        assert.match(await page.locator('.mg-deadline').textContent(), /^Você pode alterar até .*27\/11 às 0[79]:00 \(Horário de Brasília, America\/Sao_Paulo\)$/);
        assert.match(await page.locator('.mg-policy').textContent(), /até 2 h antes/);
        const details = await page.locator('.mg-details').innerText();
        assert.ok(details.includes('Corte'), details);
        for (const selector of ['.mg-cancel-button', '.mg-reschedule-button']) {
          const box = await page.locator(selector).boundingBox();
          assert.ok(box && box.height >= 44, `${selector}: ${box && box.height}`);
        }
        const layout = await page.evaluate(() => ({ vw: window.innerWidth, sw: document.documentElement.scrollWidth, referrer: document.referrer }));
        assert.ok(layout.sw <= layout.vw, `${layout.sw} > ${layout.vw}`);
        const sub = requests.filter((r) => /\/(js|api|css)\//.test(new URL(r.url()).pathname));
        assert.ok(sub.length >= 2);
        for (const r of sub) assert.equal((await r.allHeaders()).referer, undefined, r.url());
      } finally {
        await context.close();
      }
    });
  }

  test('cancelar com confirmação: "Este agendamento foi cancelado.", foco no título e atalho para a página; o horário volta (critérios 15, 17 e 40)', async () => {
    const token = await reserve('main', `${FRIDAY}T10:00`);
    assert.equal((await freeAt('main', FRIDAY)).includes('10:00'), false);
    const { context, page } = await openManage(token);
    try {
      await page.locator('.mg-cancel-button').click();
      assert.equal(await state(page), 'cancel');
      await assertLayout(page, ['.mg-cancel-yes', '.mg-cancel-back'], 'confirmação do cancelamento');
      await page.locator('.mg-cancel-yes').click();
      await page.locator('.mg-status').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.mg-status').textContent(), 'Este agendamento foi cancelado.');
      assert.equal(await page.locator('#mg-summary-titulo').textContent(), 'Agendamento cancelado');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'mg-summary-titulo');
      assert.equal(await page.locator('.mg-actions').first().isVisible(), false);
      const pageLink = page.locator('.mg-page-link');
      assert.equal(await pageLink.isVisible(), true);
      assert.match(await pageLink.getAttribute('href'), /\/gerenciar$/);
      assert.ok((await freeAt('main', FRIDAY)).includes('10:00'));
    } finally {
      await context.close();
    }
  });

  test('remarcar: mesmo profissional, 10:30 sobre o próprio horário; o mesmo link mostra o novo; 10:00 livre e 10:30 ocupado (critérios 24, 28, 29 e 40)', async () => {
    const date = '2026-11-30';
    const token = await reserve('main', `${date}T10:00`);
    const { context, page } = await openManage(token);
    try {
      await page.locator('.mg-reschedule-button').click();
      assert.equal(await state(page), 'reschedule');
      assert.equal(await page.locator('#mg-professional').inputValue(), 'same');
      assert.match(await page.locator('#mg-professional option').first().textContent(), /Mesmo profissional \(Ana Souza\)/);
      assert.equal(await page.locator('#mg-professional option').count(), 2);
      assert.equal(await page.locator('#mg-date').inputValue(), date);
      await waitSlots(page);
      const slot = page.locator('.mg-slots .pp-slot').filter({ hasText: /^\s*10:30/ });
      assert.equal(await slot.count(), 1, 'o próprio horário não ocupa');
      await slot.click();
      await assertLayout(page, ['.mg-slots .pp-slot', '.mg-reschedule-confirm', '.mg-reschedule-back'], 'remarcar');
      await page.locator('.mg-reschedule-confirm').click();
      await page.locator('.mg-done').waitFor({ state: 'visible' });
      await assertLayout(page, ['.mg-cancel-button', '.mg-reschedule-button'], 'remarcado');
      assert.equal(await page.locator('.mg-done').textContent(), 'Agendamento remarcado. O mesmo link continua valendo.');
      assert.match(await page.locator('.mg-details').innerText(), /10:30/);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('main.mg').dataset.state === 'summary');
      assert.match(await page.locator('.mg-details').innerText(), /10:30/);
      const free = await freeAt('main', date);
      assert.equal(free.includes('10:30'), false);
      assert.ok(free.includes('09:00'));
      assert.equal(free.includes('10:00'), false, '10:00 (60 min) sobrepõe o novo 10:30');
      assert.ok(free.includes('13:00'));
    } finally {
      await context.close();
    }
  });

  test('409 na remarcação: alerta com sugestões em botões, profissional e data mantidos (critério 30)', async () => {
    const date = '2026-12-01';
    const token = await reserve('main', `${date}T09:00`);
    const { context, page } = await openManage(token);
    try {
      await page.locator('.mg-reschedule-button').click();
      await waitSlots(page);
      await page.locator('.mg-slots .pp-slot').filter({ hasText: /^\s*14:00/ }).click();
      // Outro cliente ocupa 14:00 entre a escolha e o clique.
      await reserve('main', `${date}T14:00`);
      await page.locator('.mg-reschedule-confirm').click();
      const alert = page.locator('.mg-alert');
      await alert.waitFor({ state: 'visible' });
      assert.equal(await alert.getAttribute('role'), 'alert');
      assert.match(await alert.textContent(), /ocupado/);
      const suggestions = page.locator('.mg-suggestions .pp-suggestion');
      await page.locator('.mg-suggestions').waitFor({ state: 'visible' });
      assert.ok((await suggestions.count()) >= 1 && (await suggestions.count()) <= 3);
      assert.equal(await page.locator('#mg-professional').inputValue(), 'same');
      assert.equal(await page.locator('#mg-date').inputValue(), date);
      assert.equal(await state(page), 'reschedule');
    } finally {
      await context.close();
    }
  });

  test('prazo vencido (dono muda para 4320): sem botões, mensagem e link tel: (critérios 14 e 40)', async () => {
    const token = await reserve('deadline', `${FRIDAY}T10:00`);
    const owner = server.data.deadline.cookies;
    const patch = await server.app.inject({ method: 'PATCH', url: '/api/business', cookies: owner, payload: { cancellationLeadMinutes: 4320 } });
    assert.equal(patch.statusCode, 200, patch.body);
    const { context, page } = await openManage(token);
    try {
      assert.equal(await state(page), 'summary');
      assert.equal(await page.locator('.mg-cancel-button').isVisible(), false);
      assert.equal(await page.locator('.mg-reschedule-button').isVisible(), false);
      assert.equal(await page.locator('.mg-closed').textContent(), 'O prazo para alterar online terminou. Ligue para o estabelecimento.');
      assert.equal(await page.locator('.mg-closed').isVisible(), true);
      assert.match(await page.locator('.mg-phone-link').getAttribute('href'), /^tel:\+55\d{10,11}$/);
    } finally {
      await context.close();
    }
  });

  test('link inválido: /agendamento/xxxx mostra "Link inválido ou expirado." (critério 6)', async () => {
    const { context, page } = await openManage('xxxx');
    try {
      assert.equal(await state(page), 'invalid');
      assert.match(await page.locator('.mg-invalid').innerText(), /Link inválido ou expirado\./);
      assert.equal(await page.locator('.mg-summary').isVisible(), false);
    } finally {
      await context.close();
    }
  });

  test('tela do dono: /negocio mostra 120; 10 dá erro no campo com aria-invalid e foco; 60 salva com "Dados salvos." e "Equivale a 1 h" (critério 2)', async () => {
    const context = await browser.newContext({ viewport: { width: 414, height: 900 } });
    await context.addCookies([{ name: 'af_session', value: server.data.owner.cookies.af_session, url: server.baseUrl }]);
    const page = await context.newPage();
    try {
      await page.goto(`${server.baseUrl}/negocio`, { waitUntil: 'load' });
      const input = page.locator('#cancellationLeadMinutes');
      await page.waitForFunction(() => document.getElementById('cancellationLeadMinutes').value === '120');
      assert.equal(await page.locator('#cancellationLeadMinutes-equivalent').textContent(), 'Equivale a 2 h');
      await input.fill('10');
      await page.locator('#submit-button').click();
      await page.waitForFunction(() => document.getElementById('cancellationLeadMinutes').getAttribute('aria-invalid') === 'true');
      assert.match(await page.locator('#cancellationLeadMinutes-error').textContent(), /múltiplos de 15/);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'cancellationLeadMinutes');
      await input.fill('60');
      await page.locator('#submit-button').click();
      await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Dados salvos.');
      assert.equal(await page.locator('#cancellationLeadMinutes-equivalent').textContent(), 'Equivale a 1 h');
      assert.equal(await input.getAttribute('aria-invalid'), null);
      const res = await server.app.inject({ method: 'GET', url: '/api/business', cookies: server.data.owner.cookies });
      assert.equal(res.json().business.cancellationLeadMinutes, 60);
    } finally {
      await context.close();
    }
  });

  test('XSS: serviço e profissional com <img onerror> no nome aparecem como texto e nada executa (critério 13)', async () => {
    const token = await reserve('xss', `${FRIDAY}T10:00`);
    const { context, page } = await openManage(token);
    try {
      const details = await page.locator('.mg-details').innerText();
      assert.ok(details.includes(`Corte ${XSS}`), details);
      assert.ok(details.includes(`Ana ${XSS}`), details);
      assert.equal(await page.locator('main.mg img').count(), 0);
      await page.locator('.mg-reschedule-button').click();
      await waitSlots(page);
      assert.equal(await page.evaluate(() => window.__x), undefined);
    } finally {
      await context.close();
    }
  });
});
