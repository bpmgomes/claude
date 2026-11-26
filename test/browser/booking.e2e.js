// E2E da confirmação do agendamento (AF-11, design 6.1) no Chromium: fluxo completo em 360 e
// 414 px, clique duplo, falha de rede com a mesma chave, 409 com sugestões mantendo os dados, dois
// navegadores, erro por campo do servidor, XSS no painel de conflitos do dono e recarga limpa.
// Fora do `npm test`: `npm run test:e2e`. Relógio do servidor fixo: quinta 2026-11-26, 09:00 em São Paulo.
// Datas reservadas ao cenário literal do AF-22 (10 rodadas, 10:00 com a mesma profissional), fora das
// usadas pelos outros casos: 2026-12-10, 11, 14, 15, 16, 17, 18, 21, 22 e 23.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import { seedPublicBusiness } from '../helpers/public-fixture.js';
import { TEST_BUSINESS } from '../helpers/session.js';

const NOW = '2026-11-26T12:00:00.000Z';
const SCRIPT_PAYLOAD = '<script>window.__x=1</script>';
const IMG_PAYLOAD = '"><img src=x onerror="window.__x=1">';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let server;
let browser;
let seq = 0;

before(async () => {
  const { chromium } = loadPlaywright();
  server = await startServer({
    now: NOW,
    // Rate limit ligado, com tetos altos: os testes reservam muitas vezes do mesmo IP.
    overrides: { rateLimit: { enabled: true, publicPage: { perIp: 5000 }, publicAvailability: { perIp: 5000 }, publicBooking: { perIp: 5000 } } },
    seed: async (app) => ({
      main: await seedPublicBusiness(app, { services: 2, professionals: 2, logo: null, photos: false, slug: 'reserva' }),
    }),
  });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

async function open(path = '/reserva', { width = 360, height = 800, context: existing } = {}) {
  const context = existing || (await browser.newContext({ viewport: { width, height } }));
  const page = await context.newPage();
  const requests = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/appointments')) requests.push(req);
  });
  await page.goto(`${server.baseUrl}${path}`, { waitUntil: 'load' });
  return { context, page, requests };
}

async function waitReady(page) {
  await page.waitForFunction(() => {
    const section = document.querySelector('.pp-booking');
    return section && section.dataset.state === 'ready';
  });
}

/** Escolhe o serviço, o profissional e a data; espera a lista; clica no horário `index`. */
async function chooseSlot(page, { date, professionalId = 'any', index = 0 }) {
  const { services } = server.data.main;
  await page.selectOption('#bk-service', services[0].id);
  await page.selectOption('#bk-professional', professionalId);
  await page.fill('#bk-date', date);
  await page.locator('#bk-date').dispatchEvent('change');
  await waitReady(page);
  const slot = page.locator('.pp-slot').nth(index);
  const label = await slot.textContent();
  await slot.click();
  await page.locator('#bk-customer').waitFor({ state: 'visible' });
  return label;
}

/**
 * Como `chooseSlot`, mas escolhe o horário pelo rótulo (`time`, ex.: "10:00"), e não pelo índice.
 * @returns {Promise<string>} rótulo do horário clicado
 */
async function chooseSlotAt(page, { date, professionalId, time }) {
  const { services } = server.data.main;
  await page.selectOption('#bk-service', services[0].id);
  await page.selectOption('#bk-professional', professionalId);
  await page.fill('#bk-date', date);
  await page.locator('#bk-date').dispatchEvent('change');
  await waitReady(page);
  const slot = page.locator('.pp-slot').filter({ hasText: new RegExp(`^\\s*${time}`) });
  assert.equal(await slot.count(), 1, `um horário ${time} em ${date}`);
  const label = await slot.textContent();
  await slot.click();
  await page.locator('#bk-customer').waitFor({ state: 'visible' });
  return label;
}

function customer(name) {
  seq += 1;
  return { name: name || `Cliente ${seq}`, phone: `(11) 9765${String(seq % 10)}-${String(1000 + seq).slice(-4)}`, email: `e2e${seq}@example.com` };
}

async function fillCustomer(page, c) {
  await page.fill('#bk-name', c.name);
  await page.fill('#bk-phone', c.phone);
  await page.fill('#bk-email', c.email);
}

const confirmButton = (page) => page.locator('#bk-customer .pp-confirm-button');

async function waitSuccess(page) {
  await page.locator('.pp-success').waitFor({ state: 'visible' });
}

describe('confirmação do agendamento (AF-11)', () => {
  for (const [width, date] of [
    [360, '2026-11-27'],
    [414, '2026-11-30'],
  ]) {
    test(`${width} px: escolher, preencher e confirmar mostra o sucesso com foco no título, sem rolagem e sem nada na URL (critérios 27 e 28)`, async () => {
      const { context, page, requests } = await open('/reserva', { width });
      try {
        const label = await chooseSlot(page, { date });
        await fillCustomer(page, customer('Maria Clara'));
        await confirmButton(page).click();
        await waitSuccess(page);
        assert.equal(requests.length, 1);
        assert.equal(await page.locator('#sucesso-titulo').textContent(), 'Agendamento confirmado');
        assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'sucesso-titulo');
        assert.equal(await page.locator('.pp-booking').isVisible(), false);
        const details = await page.locator('.pp-success-details').innerText();
        const { services } = server.data.main;
        assert.ok(details.includes(services[0].name), details);
        assert.ok(details.includes(`${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`), details);
        assert.ok(details.includes(label.trim()), details);
        assert.match(details, /Profissional \d\d/);
        assert.equal(details.includes('Maria'), false, 'nenhum dado do cliente na tela de sucesso');
        const phoneLink = page.locator('.pp-success-phone-link');
        assert.match(await phoneLink.getAttribute('href'), /^tel:\+55\d{10,11}$/);
        assert.equal(await phoneLink.textContent(), TEST_BUSINESS.phone);
        const successText = (await page.locator('.pp-success').innerText()).toLowerCase();
        assert.equal(successText.includes('e-mail'), false);
        assert.equal(successText.includes('cancelar online'), false);
        const layout = await page.evaluate(() => ({
          vw: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          search: location.search,
          hash: location.hash,
          stored: localStorage.length + sessionStorage.length,
          cookie: document.cookie,
        }));
        assert.ok(layout.scrollWidth <= layout.vw, `scrollWidth ${layout.scrollWidth} > ${layout.vw}`);
        assert.equal(layout.search, '');
        assert.equal(layout.hash, '');
        assert.equal(layout.stored, 0);
        assert.equal(layout.cookie, '');
      } finally {
        await context.close();
      }
    });
  }

  test('clique duplo envia uma requisição; o botão fica ocupado durante o envio (critério 25)', async () => {
    const { context, page, requests } = await open();
    try {
      await chooseSlot(page, { date: '2026-12-01' });
      await fillCustomer(page, customer());
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      await page.route('**/appointments', async (route) => {
        await held;
        await route.continue();
      });
      await confirmButton(page).dblclick();
      await page.waitForFunction(() => document.querySelector('#bk-customer .pp-confirm-button').getAttribute('aria-busy') === 'true');
      assert.equal(await confirmButton(page).isDisabled(), true);
      assert.equal(await confirmButton(page).textContent(), 'Confirmando…');
      await confirmButton(page).click({ force: true }).catch(() => {});
      release();
      await waitSuccess(page);
      assert.equal(requests.length, 1);
    } finally {
      await context.close();
    }
  });

  test('falha de rede: mensagem, os dados ficam, e a nova tentativa usa a mesma Idempotency-Key (critério 25)', async () => {
    const { context, page } = await open();
    try {
      await chooseSlot(page, { date: '2026-12-02' });
      const c = customer();
      await fillCustomer(page, c);
      const keys = [];
      let calls = 0;
      await page.route('**/appointments', async (route) => {
        calls += 1;
        keys.push(route.request().headers()['idempotency-key']);
        if (calls === 1) await route.abort('failed');
        else await route.continue();
      });
      await confirmButton(page).click();
      const alert = page.locator('.pp-alert');
      await alert.waitFor({ state: 'visible' });
      assert.match(await alert.textContent(), /Não foi possível confirmar agora\. Seus dados continuam aqui/);
      assert.equal(await page.inputValue('#bk-name'), c.name);
      assert.equal(await page.inputValue('#bk-email'), c.email);
      await confirmButton(page).click();
      await waitSuccess(page);
      assert.equal(keys.length, 2);
      assert.match(keys[0], UUID_V4_RE);
      assert.equal(keys[1], keys[0]);
    } finally {
      await context.close();
    }
  });

  test('dois navegadores confirmam o mesmo horário ao mesmo tempo: um vê o sucesso, o outro o 409 com sugestões e mantém os dados; 1 agendamento no banco (critérios 16 a 18; AF-22)', async () => {
    const date = '2026-12-03';
    const professionalId = server.data.main.professionals[0].id;
    // Dia local inteiro em São Paulo (UTC-3), para contar no banco.
    const dayRange = [`${date}T03:00:00.000Z`, '2026-12-04T03:00:00.000Z'];
    const countDay = async () =>
      Number(
        (
          await server.app.db.get(
            "SELECT COUNT(*) AS n FROM appointments WHERE professional_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?",
            [professionalId, ...dayRange],
          )
        ).n,
      );
    assert.equal(await countDay(), 0);
    const first = await open('/reserva', { width: 360 });
    const second = await open('/reserva', { width: 414 });
    try {
      const sessions = [first, second];
      for (const { page } of sessions) await chooseSlot(page, { date, professionalId, index: 1 });
      const customers = [customer('Joana Prado'), customer('Lia Ramos')];
      for (const [i, { page }] of sessions.entries()) await fillCustomer(page, customers[i]);

      await Promise.all(sessions.map(({ page }) => confirmButton(page).click()));
      const outcomes = await Promise.all(
        sessions.map(async ({ page }) => {
          await page.waitForFunction(() => !document.querySelector('.pp-success').hidden || !document.querySelector('.pp-alert').hidden);
          return (await page.locator('.pp-success').isVisible()) ? 'success' : 'conflict';
        }),
      );
      assert.deepEqual([...outcomes].sort(), ['conflict', 'success'], 'exatamente um sucesso e um 409');
      for (const { requests } of sessions) assert.equal(requests.length, 1);
      assert.equal(await countDay(), 1);

      const loserIndex = outcomes.indexOf('conflict');
      const loser = sessions[loserIndex].page;
      const alert = loser.locator('.pp-alert');
      assert.equal(await alert.getAttribute('role'), 'alert');
      assert.equal(await alert.textContent(), 'Este horário acabou de ser ocupado. Escolha outro.');
      assert.equal(await sessions[1 - loserIndex].page.locator('.pp-alert').isVisible(), false);
      const suggestions = loser.locator('.pp-suggestion');
      await suggestions.first().waitFor({ state: 'visible' });
      assert.ok((await suggestions.count()) >= 1 && (await suggestions.count()) <= 3);
      const c = customers[loserIndex];
      assert.equal(await loser.inputValue('#bk-name'), c.name);
      assert.equal(await loser.inputValue('#bk-email'), c.email);
      assert.notEqual(await loser.inputValue('#bk-phone'), '');
      const suggestionText = await suggestions.first().textContent();
      await suggestions.first().click();
      await waitReady(loser);
      await loser.waitForFunction(() => document.querySelector('.pp-slot[aria-pressed="true"]'));
      assert.equal((await loser.locator('.pp-slot[aria-pressed="true"]').textContent()).trim().slice(0, 5), suggestionText.trim().slice(-5));
      assert.equal(await loser.locator('.pp-alert').isVisible(), false);
      await confirmButton(loser).click();
      await waitSuccess(loser);
      assert.equal(await countDay(), 2);
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test('cenário literal do backlog, 10 rodadas: dois navegadores, mesma profissional às 10:00, Confirmar ao mesmo tempo; 1 vence e o outro vê o aviso (AF-22, critérios 1 a 4)', { timeout: 30_000 }, async () => {
    const professional = server.data.main.professionals[0];
    const dates = ['2026-12-10', '2026-12-11', '2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2026-12-21', '2026-12-22', '2026-12-23'];
    const contexts = [];
    try {
      const sessions = [];
      // Barreira de rede (sem sleep): o POST de cada página só segue quando os dois chegaram.
      let round;
      for (const width of [360, 414]) {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        contexts.push(context);
        const page = await context.newPage();
        const session = { page, sent: [] };
        page.on('request', (req) => {
          if (req.url().endsWith('/appointments') && round) session.sent.push(req);
        });
        await page.route('**/appointments', async (route) => {
          const current = round;
          current.arrived += 1;
          if (current.arrived === 2) current.release();
          await current.gate;
          await route.continue();
        });
        sessions.push(session);
      }
      for (const date of dates) {
        let release;
        round = { arrived: 0, gate: new Promise((r) => (release = r)) };
        round.release = release;
        for (const session of sessions) session.sent = [];
        for (const { page } of sessions) {
          await page.goto(`${server.baseUrl}/reserva`, { waitUntil: 'load' });
          await chooseSlotAt(page, { date, professionalId: professional.id, time: '10:00' });
        }
        for (const { page } of sessions) {
          const pressed = await page.locator('.pp-slot[aria-pressed="true"]').textContent();
          assert.ok(pressed.trim().startsWith('10:00'), `${date}: ${pressed}`);
          assert.equal(await page.inputValue('#bk-professional'), professional.id);
          assert.equal((await page.locator('#bk-professional option:checked').textContent()).trim(), professional.name);
        }
        const customers = [customer(), customer()];
        for (const [i, { page }] of sessions.entries()) await fillCustomer(page, customers[i]);

        await Promise.all(sessions.map(({ page }) => confirmButton(page).click()));
        const outcomes = await Promise.all(
          sessions.map(async ({ page }) => {
            await page.waitForFunction(() => !document.querySelector('.pp-success').hidden || !document.querySelector('.pp-alert').hidden);
            return (await page.locator('.pp-success').isVisible()) ? 'success' : 'conflict';
          }),
        );
        assert.deepEqual([...outcomes].sort(), ['conflict', 'success'], date);
        for (const { sent } of sessions) assert.equal(sent.length, 1, `${date}: uma requisição por página`);
        const statuses = await Promise.all(sessions.map(async ({ sent }) => (await sent[0].response()).status()));
        assert.deepEqual([...statuses].sort(), [201, 409], date);

        const winnerIndex = outcomes.indexOf('success');
        const winner = sessions[winnerIndex].page;
        const loser = sessions[1 - winnerIndex].page;
        const details = await winner.locator('.pp-success-details').innerText();
        assert.ok(details.includes('10:00'), details);
        assert.ok(details.includes(professional.name), details);
        const alert = loser.locator('.pp-alert');
        assert.equal(await alert.getAttribute('role'), 'alert');
        assert.equal(await alert.textContent(), 'Este horário acabou de ser ocupado. Escolha outro.');
        const suggestions = loser.locator('.pp-suggestion');
        await suggestions.first().waitFor({ state: 'visible' });
        const shown = await suggestions.count();
        assert.ok(shown >= 1 && shown <= 3, `${date}: ${shown} sugestões`);
        const lost = customers[1 - winnerIndex];
        assert.equal(await loser.inputValue('#bk-name'), lost.name);
        assert.equal(await loser.inputValue('#bk-email'), lost.email);
        assert.notEqual(await loser.inputValue('#bk-phone'), '');

        const active = await server.app.db.get(
          "SELECT COUNT(*) AS n FROM appointments WHERE professional_id = ? AND starts_at = ? AND status <> 'cancelled'",
          [professional.id, `${date}T13:00:00.000Z`],
        );
        assert.equal(Number(active.n), 1, date);
        const byEmail = async (email) => Number((await server.app.db.get('SELECT COUNT(*) AS n FROM customers WHERE email = ?', [email])).n);
        assert.equal(await byEmail(customers[winnerIndex].email), 1, date);
        assert.equal(await byEmail(lost.email), 0, `${date}: sem cliente órfão`);
      }
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  for (const [label, who] of [
    ['nome <img onerror> e e-mail =HYPERLINK(...)', { name: '<img src=x onerror=window.__x=1>', email: '=HYPERLINK("http://x")@x.com' }],
    ['nome =HYPERLINK(...)', { name: '=HYPERLINK("http://x")' }],
  ]) {
    test(`XSS e fórmula: ${label} é aceito pela validação, a reserva chega ao sucesso e nada é injetado (critério 39)`, async () => {
      const { context, page, requests } = await open();
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      try {
        const imgsBefore = await page.evaluate(() => document.querySelectorAll('img').length);
        await chooseSlot(page, { date: '2026-12-09', index: label.startsWith('nome <img') ? 0 : 1 });
        await fillCustomer(page, { ...customer(), ...who });
        await confirmButton(page).click();
        await waitSuccess(page);
        assert.equal(requests.length, 1);
        assert.equal((await requests[0].response()).status(), 201);
        const state = await page.evaluate(() => ({
          x: window.__x,
          imgs: document.querySelectorAll('img').length,
          srcX: [...document.querySelectorAll('img')].filter((img) => img.getAttribute('src') === 'x').length,
          injected: document.querySelectorAll('.pp-success img, .pp-success script, .pp-booking img').length,
          success: document.querySelector('.pp-success').innerText,
        }));
        assert.equal(state.x, undefined);
        assert.equal(state.injected, 0);
        assert.equal(state.imgs, imgsBefore, 'nenhum <img> novo');
        assert.equal(state.srcX, 0);
        assert.equal(state.success.includes('HYPERLINK'), false, 'o sucesso não mostra dados do cliente');
        assert.deepEqual(dialogs, []);
      } finally {
        await context.close();
      }
    });
  }

  test('erro por campo vindo do servidor aparece no campo, com foco nele, e os valores ficam (critério 2)', async () => {
    const { context, page } = await open();
    try {
      await chooseSlot(page, { date: '2026-12-04' });
      const c = customer();
      await fillCustomer(page, c);
      await page.route('**/appointments', (route) =>
        route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Verifique os campos destacados.', fields: { email: 'Informe um e-mail válido.' } } }),
        }),
      );
      await confirmButton(page).click();
      const error = page.locator('#bk-email-erro');
      await page.waitForFunction(() => document.querySelector('#bk-email-erro').textContent !== '');
      assert.equal(await error.textContent(), 'Informe um e-mail válido.');
      assert.equal(await page.locator('#bk-email').getAttribute('aria-invalid'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'bk-email');
      assert.equal(await page.inputValue('#bk-name'), c.name);
      assert.equal(await page.inputValue('#bk-email'), c.email);
      assert.equal(await page.locator('.pp-success').isVisible(), false);
    } finally {
      await context.close();
    }
  });

  test('com o cookie do dono no navegador, o POST sai sem Cookie (credentials omit); recarregar depois do sucesso limpa tudo (critérios 28 e 30)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    await context.addCookies([{ name: 'af_session', value: server.data.main.cookies.af_session, url: server.baseUrl }]);
    const { page, requests } = await open('/reserva', { context });
    try {
      await chooseSlot(page, { date: '2026-12-07' });
      await fillCustomer(page, customer());
      await confirmButton(page).click();
      await waitSuccess(page);
      assert.equal(requests.length, 1);
      const headers = await requests[0].allHeaders();
      assert.equal(headers.cookie, undefined, 'POST sem Cookie');
      assert.match(headers['idempotency-key'], UUID_V4_RE);
      const response = await requests[0].response();
      assert.equal(response.status(), 201);
      assert.equal((await response.allHeaders())['set-cookie'], undefined);

      await page.reload({ waitUntil: 'load' });
      assert.equal(await page.locator('.pp-success').isVisible(), false);
      assert.equal(await page.locator('.pp-booking').isVisible(), true);
      assert.equal(await page.inputValue('#bk-service'), '');
      assert.equal(await page.locator('#bk-customer').isVisible(), false);
      const state = await page.evaluate(() => ({
        search: location.search,
        stored: localStorage.length + sessionStorage.length,
        values: ['bk-name', 'bk-phone', 'bk-email'].map((id) => document.getElementById(id).value),
      }));
      assert.equal(state.search, '');
      assert.equal(state.stored, 0);
      assert.deepEqual(state.values, ['', '', '']);
    } finally {
      await context.close();
    }
  });

  test('XSS: nome malicioso do cliente aparece literal no painel de conflitos de /bloqueios (critério 39)', async () => {
    const date = '2026-12-08';
    const professional = server.data.main.professionals[1];
    const { context, page } = await open();
    try {
      await chooseSlot(page, { date, professionalId: professional.id });
      await fillCustomer(page, { ...customer(), name: SCRIPT_PAYLOAD });
      await confirmButton(page).click();
      await waitSuccess(page);
    } finally {
      await context.close();
    }

    const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await owner.addCookies([{ name: 'af_session', value: server.data.main.cookies.af_session, url: server.baseUrl }]);
    const ownerPage = await owner.newPage();
    const dialogs = [];
    ownerPage.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    try {
      await ownerPage.goto(`${server.baseUrl}/bloqueios`, { waitUntil: 'load' });
      await ownerPage.locator('#time-blocks-section').waitFor({ state: 'visible' });
      await ownerPage.waitForFunction((id) => document.querySelector(`#professionalId option[value="${id}"]`), professional.id);
      await ownerPage.selectOption('#professionalId', professional.id);
      await ownerPage.check('#all-day');
      await ownerPage.fill('#start-date', date);
      await ownerPage.fill('#end-date', date);
      await ownerPage.fill('#reasonNote', IMG_PAYLOAD.slice(0, 60));
      await ownerPage.click('#save-button');
      await ownerPage.locator('#conflicts-panel').waitFor({ state: 'visible' });
      const listText = await ownerPage.locator('#conflicts-list').textContent();
      assert.ok(listText.includes(SCRIPT_PAYLOAD), listText);
      const injected = await ownerPage.evaluate(() => ({
        x: window.__x,
        scripts: document.querySelectorAll('#conflicts-panel script').length,
        imgs: document.querySelectorAll('#conflicts-panel img').length,
      }));
      assert.deepEqual(injected, { x: undefined, scripts: 0, imgs: 0 });
      assert.deepEqual(dialogs, []);
    } finally {
      await owner.close();
    }
  });
});
