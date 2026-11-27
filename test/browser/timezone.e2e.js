// E2E de fusos do AF-23 (design 5.1 e 6.2) no Chromium: reprodução do relato (cliente em Manaus,
// salão em São Paulo), mantida como regressão. Cada fuso do navegador tem o seu negócio idêntico e o
// relógio do navegador fica fixo no instante do servidor, então o fuso é a única variável. Também:
// a matriz de fusos (critério 2), "hoje" do servidor (3), bloqueio em Manaus (10), horários (11),
// horário de verão na tela (6) e acessibilidade do aviso (16).
// Transporte de memória (nenhuma rede real). Fora do `npm test`: `npm run test:e2e`.
/* global document */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import {
  seedIdenticalBusinesses,
  tzContext,
  captureBooking,
  captureSuccess,
  captureManage,
  captureAgenda,
  captureAgendaDetail,
  captureTimeBlocks,
  captureHours,
} from './tz-capture.js';
import { contrastFailures } from './a11y.js';
import { icsOf, parseIcs, linkFrom } from '../helpers/email.js';
import { getAvailability } from '../helpers/session.js';
import { postAppointment, bookingBody } from '../helpers/appointments.js';
import { bookWithLink } from '../helpers/manage.js';
import { seedDstBusiness } from '../helpers/dst-fixtures.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';
import { instantToLocal, addLocalDays } from '../../src/shared/zoned-time.js';
import { AGENDA_PAST_DAYS, AGENDA_FUTURE_DAYS } from '../../src/shared/agenda.js';
import { BOOKING_HORIZON_DAYS } from '../../src/shared/availability.js';

const NOW = '2026-11-26T12:00:00.000Z'; // quinta, 09:00 em São Paulo e 08:00 em Manaus
const FRIDAY = '2026-11-27';
const RATE_LIMIT = Object.freeze({
  enabled: true,
  publicPage: { perIp: 5000 },
  publicAvailability: { perIp: 5000 },
  publicBooking: { perIp: 5000 },
  publicManage: { perIp: 5000 },
  agendaRead: { perUser: 5000, perIp: 5000 },
  agendaCancel: { perUser: 5000, perIp: 5000 },
});

let browser;

before(async () => {
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
});

/** Servidor com o relógio em `now`, transporte de memória e o laço do worker desligado. */
async function serverWith({ now = NOW, seed }) {
  const transport = createMemoryMailTransport();
  const server = await startServer({
    now,
    overrides: { mailTransport: transport, email: { worker: { enabled: false, intervalMs: 15_000 } }, rateLimit: RATE_LIMIT },
    seed,
  });
  return { server, transport };
}

const URL_RE = /https?:\/\/\S+/g;

/** Escolhe serviço, profissional e data na página pública e espera a lista. */
async function pickDay(page, b, date) {
  await page.selectOption('#bk-service', b.service.id);
  await page.selectOption('#bk-professional', b.professional.id);
  await page.fill('#bk-date', date);
  await page.locator('#bk-date').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('.pp-booking').dataset.state === 'ready');
}

/**
 * O fluxo inteiro do relato num fuso: página pública, sucesso, e-mail e .ics, gerenciar e agenda do
 * dono (no mesmo fuso). Devolve só os textos que carregam horário ou fuso.
 */
async function journey({ server, transport }, b, timezoneId, { locale = 'pt-BR', email }) {
  const out = {};
  const client = await tzContext(browser, timezoneId, { locale, nowIso: NOW, width: 360, height: 800 });
  try {
    const { page } = client;
    await page.goto(`${server.baseUrl}/${b.slug}`, { waitUntil: 'load' });
    out.initial = await captureBooking(page);
    await pickDay(page, b, FRIDAY);
    out.list = await captureBooking(page);
    await page.locator('.pp-slot').filter({ hasText: /^\s*10:00/ }).click();
    out.chosen = await captureBooking(page);
    await page.fill('#bk-name', 'Cliente Manaus');
    await page.fill('#bk-phone', '11961234567');
    await page.fill('#bk-email', email);
    await page.locator('#bk-customer .pp-confirm-button').click();
    await page.locator('.pp-success').waitFor({ state: 'visible' });
    out.success = await captureSuccess(page);

    await server.app.services.emailWorker.runOnce();
    const mail = transport.messages.find((m) => m.to === email);
    assert.ok(mail, 'e-mail de confirmação');
    out.mail = { subject: mail.subject, text: mail.text.replace(URL_RE, '<url>') };
    const ics = parseIcs(icsOf(mail));
    out.ics = { DTSTART: ics.get('DTSTART'), DTEND: ics.get('DTEND'), DESCRIPTION: ics.get('DESCRIPTION') };

    await page.goto(`${server.baseUrl}${new URL(linkFrom(mail)).pathname}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('main.mg').dataset.state !== 'loading');
    out.manage = await captureManage(page);
    await page.locator('.mg-reschedule-button').click();
    await page.waitForFunction(() => document.querySelector('main.mg').dataset.slots === 'ready');
    await page.locator('.mg-slots .pp-slot').filter({ hasText: /^\s*15:00/ }).click();
    out.reschedule = await captureManage(page);
  } finally {
    await client.context.close();
  }

  const owner = await tzContext(browser, timezoneId, { locale, nowIso: NOW, cookies: b.cookies, baseUrl: server.baseUrl });
  try {
    const { page } = owner;
    await page.goto(`${server.baseUrl}/agenda?view=day&date=${FRIDAY}`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const s = document.getElementById('agenda-section');
      return s && Number(s.dataset.loads || 0) > 0 && s.dataset.state === 'ready';
    });
    out.agenda = await captureAgenda(page);
    await page.locator('button.ag-item').first().click();
    await page.waitForFunction(() => !document.getElementById('detail-list').hidden);
    out.detail = await captureAgendaDetail(page);
  } finally {
    await owner.context.close();
  }
  return out;
}

describe('reprodução AF-23 (critério 1): cliente em Manaus, salão em São Paulo', () => {
  let env;

  before(async () => {
    env = await serverWith({ seed: (app) => seedIdenticalBusinesses(app, 2, { prefix: 'repro' }) });
  });

  after(async () => {
    if (env) await env.server.close();
  });

  test('Manaus vê exatamente o que São Paulo vê, em todas as telas, no e-mail e no .ics', async (t) => {
    const [spBusiness, manausBusiness] = env.server.data;
    const sp = await journey(env, spBusiness, 'America/Sao_Paulo', { email: 'repro-sp@example.com' });
    const manaus = await journey(env, manausBusiness, 'America/Manaus', { email: 'repro-manaus@example.com' });
    assert.deepEqual(manaus, sp);
    assert.ok(sp.list.slots.includes('10:00'), JSON.stringify(sp.list.slots));
    assert.equal(sp.initial.date.value, '2026-11-26');
    assert.equal(sp.ics.DTSTART, '20261127T130000Z');
    assert.equal(sp.ics.DTEND, '20261127T140000Z');
    assert.match(sp.agenda.items.join('\n'), /10:00 às 11:00/);
    // H2 (design 5.1): registro, sem asserção que falhe. O instante está certo; o calendário do
    // aparelho em Manaus mostraria a hora convertida.
    const ms = Date.UTC(2026, 10, 27, 13, 0);
    t.diagnostic(`H2: DTSTART ${sp.ics.DTSTART} = ${instantToLocal(ms, 'America/Sao_Paulo')} em São Paulo; o calendário em Manaus mostraria ${instantToLocal(ms, 'America/Manaus')}`);
    t.diagnostic(`captura de referência: ${JSON.stringify(sp)}`);
  });
});

// ---------------------------------------------------------------------------------------------
// Matriz (critério 2): referência America/Sao_Paulo; locales variados para acusar toLocale*.

const REFERENCE = Object.freeze({ timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });
const MATRIX = Object.freeze([
  REFERENCE,
  Object.freeze({ timezoneId: 'America/Manaus', locale: 'pt-BR' }),
  Object.freeze({ timezoneId: 'Asia/Tokyo', locale: 'ja-JP' }),
  Object.freeze({ timezoneId: 'America/New_York', locale: 'en-US' }),
  Object.freeze({ timezoneId: 'Pacific/Kiritimati', locale: 'pt-BR' }),
]);
const NOTICE_SP = 'Horários no fuso do estabelecimento: Horário de Brasília (America/Sao_Paulo).';

async function waitAgenda(page) {
  await page.waitForFunction(() => {
    const s = document.getElementById('agenda-section');
    return s && Number(s.dataset.loads || 0) > 0 && s.dataset.state === 'ready';
  });
}

async function afterAgendaReload(page, action) {
  const before = await page.evaluate(() => Number(document.getElementById('agenda-section').dataset.loads || 0));
  await action();
  await page.waitForFunction((n) => {
    const s = document.getElementById('agenda-section');
    return Number(s.dataset.loads || 0) > n && s.dataset.state === 'ready';
  }, before);
}

/**
 * Acessibilidade do aviso `noticeId` (critério 16): texto real, sem `title`, cada elemento de
 * `describedSelectors` aponta para ele, contraste AA e nada transborda a largura. Devolve problemas.
 */
async function noticeProblems(page, noticeId, describedSelectors) {
  const problems = await page.evaluate(
    ({ id, selectors }) => {
      const out = [];
      const el = document.getElementById(id);
      if (!el) return [`#${id} ausente`];
      if (!el.textContent.trim()) out.push(`#${id} vazio`);
      if (el.hasAttribute('title')) out.push(`#${id} com title`);
      for (const selector of selectors) {
        const targets = [...document.querySelectorAll(selector)];
        if (targets.length === 0) out.push(`${selector} ausente`);
        for (const t of targets) {
          const ids = (t.getAttribute('aria-describedby') || '').split(/\s+/);
          if (!ids.includes(id)) out.push(`${selector} sem aria-describedby=${id}`);
        }
      }
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth) out.push(`rolagem horizontal ${doc.scrollWidth} > ${doc.clientWidth}`);
      return out;
    },
    { id: noticeId, selectors: describedSelectors },
  );
  problems.push(...(await contrastFailures(page, { root: `#${noticeId}` })));
  return problems;
}

/** Descrição acessível (Chromium, CDP) da lista com o nome dado. */
async function listDescription(page, name) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const node = nodes.find((n) => n.role?.value === 'list' && n.name?.value === name && !n.ignored);
    return node?.description?.value ?? null;
  } finally {
    await cdp.detach();
  }
}

/** Descrição acessível (Chromium, CDP) de cada grupo (`fieldset`) com legenda, por nome. */
async function groupDescriptions(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    return Object.fromEntries(
      nodes.filter((n) => n.role?.value === 'group' && !n.ignored && n.name?.value).map((n) => [n.name.value, n.description?.value ?? null]),
    );
  } finally {
    await cdp.detach();
  }
}

/** Matriz num fuso: pública (com 409), sucesso, gerenciar, agenda, bloqueios e horários. */
async function matrixJourney(server, b, { timezoneId, locale }) {
  const out = {};
  const a11y = [];
  const client = await tzContext(browser, timezoneId, { locale, nowIso: NOW, width: 360, height: 800 });
  try {
    const { page } = client;
    await page.goto(`${server.baseUrl}/${b.slug}`, { waitUntil: 'load' });
    out.initial = await captureBooking(page);
    await pickDay(page, b, FRIDAY);
    out.list = await captureBooking(page);
    a11y.push(...(await noticeProblems(page, 'bk-timezone', ['ul.pp-slots'])));
    out.slotsDescription = await listDescription(page, 'Horários livres');
    await page.locator('.pp-slot').filter({ hasText: /^\s*10:00/ }).click();
    out.chosen = await captureBooking(page);
    await page.fill('#bk-name', 'Cliente Fuso');
    await page.fill('#bk-phone', '11961234567');
    await page.fill('#bk-email', `matriz-${b.slug}@example.com`);
    // 409 forçado: outra pessoa reserva o mesmo horário pela API entre a escolha e a confirmação.
    const taken = await postAppointment(server.app, b.slug, bookingBody({ serviceId: b.service.id, professionalId: b.professional.id, start: `${FRIDAY}T10:00`, customer: { name: 'Cliente API' } }));
    assert.equal(taken.statusCode, 201, taken.body);
    await page.locator('#bk-customer .pp-confirm-button').click();
    await page.locator('.pp-suggestions').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.pp-booking').dataset.state === 'ready');
    out.conflict = await captureBooking(page);
    a11y.push(...(await noticeProblems(page, 'bk-suggestions-timezone', ['ul.pp-suggestions-list'])));
    await page.locator('.pp-suggestion').first().click();
    await page.waitForFunction(() => document.querySelector('.pp-slot[aria-pressed="true"]'));
    out.suggested = await captureBooking(page);
    await page.locator('#bk-customer .pp-confirm-button').click();
    await page.locator('.pp-success').waitFor({ state: 'visible' });
    out.success = await captureSuccess(page);

    const manageUrl = await page.locator('.pp-success-manage-link').getAttribute('href');
    await page.goto(`${server.baseUrl}${new URL(manageUrl).pathname}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('main.mg').dataset.state !== 'loading');
    out.manage = await captureManage(page);
    // O aviso do painel aparece antes de a lista carregar (consulta atrasada).
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/public/manage/*/availability*', async (route) => {
      await gate;
      await route.continue();
    });
    await page.locator('.mg-reschedule-button').click();
    await page.waitForFunction(() => document.querySelector('main.mg').dataset.slots === 'loading');
    out.manageLoading = { notice: await page.locator('#mg-timezone').textContent(), visible: await page.locator('#mg-timezone').isVisible() };
    release();
    await page.waitForFunction(() => document.querySelector('main.mg').dataset.slots === 'ready');
    out.reschedule = await captureManage(page);
    a11y.push(...(await noticeProblems(page, 'mg-timezone', ['ul.mg-slots', 'ul.mg-suggestions-list'])));
    await page.locator('.mg-slots .pp-slot').filter({ hasText: /^\s*15:00/ }).click();
    out.rescheduleChosen = await captureManage(page);
  } finally {
    await client.context.close();
  }

  const owner = await tzContext(browser, timezoneId, { locale, nowIso: NOW, width: 360, height: 800, cookies: b.cookies, baseUrl: server.baseUrl });
  try {
    const { page } = owner;
    await page.goto(`${server.baseUrl}/agenda?view=day&date=${FRIDAY}`, { waitUntil: 'load' });
    await waitAgenda(page);
    out.agenda = await captureAgenda(page);
    a11y.push(...(await noticeProblems(page, 'agenda-timezone', ['ul.ag-list'])));
    await page.locator('button.ag-item').first().click();
    await page.waitForFunction(() => !document.getElementById('detail-list').hidden);
    out.detail = await captureAgendaDetail(page);
    a11y.push(...(await noticeProblems(page, 'detail-timezone', ['#detail-dialog'])));
    await page.locator('#detail-cancel').click();
    await page.locator('#cancel-dialog').waitFor({ state: 'visible' });
    out.cancel = { question: await page.locator('#cancel-question').textContent(), notice: await page.locator('#cancel-timezone').textContent() };
    a11y.push(...(await noticeProblems(page, 'cancel-timezone', ['#cancel-dialog'])));
    assert.equal(await page.locator('#cancel-dialog').getAttribute('aria-describedby'), 'cancel-question cancel-timezone');
    await page.locator('#cancel-back').click();
    await page.locator('#detail-close').click();

    await page.goto(`${server.baseUrl}/bloqueios`, { waitUntil: 'load' });
    await page.locator('#time-blocks-section').waitFor({ state: 'visible' });
    out.blocksForm = await captureTimeBlocks(page);
    a11y.push(...(await noticeProblems(page, 'tb-form-timezone', ['#start-date', '#start-time', '#end-date', '#end-time'])));
    a11y.push(...(await noticeProblems(page, 'tb-list-timezone', ['#time-block-list'])));
    const block = async (from, to) => {
      await page.fill('#start-date', FRIDAY);
      await page.selectOption('#start-time', from);
      await page.fill('#end-date', FRIDAY);
      await page.selectOption('#end-time', to);
      await page.locator('#save-button').click();
    };
    await block('16:00', '17:00');
    await page.waitForFunction(() => document.querySelectorAll('#time-block-list li').length === 1);
    await block('09:00', '12:00');
    await page.locator('#conflicts-panel').waitFor({ state: 'visible' });
    out.blocks = await captureTimeBlocks(page);
    a11y.push(...(await noticeProblems(page, 'tb-conflicts-timezone', ['#conflicts-list'])));
    await page.locator('#cancel-button').click();

    await page.goto(`${server.baseUrl}/horarios`, { waitUntil: 'load' });
    await page.locator('#hours-section').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#days select').length > 0);
    out.hours = await captureHours(page);
    a11y.push(...(await noticeProblems(page, 'hours-timezone', ['fieldset.hours-day'])));
    out.hoursGroups = await groupDescriptions(page);
  } finally {
    await owner.context.close();
  }
  return { out, a11y };
}

describe('matriz de fusos do navegador (critérios 2, 7 a 11 e 16)', () => {
  let env;

  before(async () => {
    env = await serverWith({ seed: (app) => seedIdenticalBusinesses(app, MATRIX.length, { prefix: 'matriz' }) });
  });

  after(async () => {
    if (env) await env.server.close();
  });

  test('cada fuso vê, byte a byte, o mesmo que São Paulo, com o aviso de fuso acessível em 360 px', async () => {
    const results = [];
    for (const [i, zone] of MATRIX.entries()) {
      results.push(await matrixJourney(env.server, env.server.data[i], zone));
    }
    const ref = results[0].out;
    // Referência: o aviso em cada tela, o prazo e o resumo com o fuso em linha.
    assert.equal(ref.initial.notices['bk-timezone'], NOTICE_SP);
    assert.equal(ref.initial.timezone, NOTICE_SP);
    assert.equal(ref.chosen.selected, 'Corte · sex, 27/11 · 10:00 – 11:00 (Horário de Brasília, America/Sao_Paulo)');
    assert.ok(ref.conflict.suggestions.length > 0, JSON.stringify(ref.conflict));
    assert.equal(ref.conflict.notices['bk-suggestions-timezone'], NOTICE_SP);
    assert.match(ref.success.find(([k]) => k === 'Horário')[1], /\(Horário de Brasília, America\/Sao_Paulo\)$/);
    assert.match(ref.manage.deadline, /^Você pode alterar até .* \(Horário de Brasília, America\/Sao_Paulo\)$/);
    assert.deepEqual(ref.manageLoading, { notice: NOTICE_SP, visible: true });
    assert.match(ref.rescheduleChosen.selected, /15:00 – 16:00 \(Horário de Brasília, America\/Sao_Paulo\)$/);
    assert.equal(ref.agenda.timezone, NOTICE_SP);
    assert.equal(ref.detail.notices['detail-timezone'], NOTICE_SP);
    assert.equal(ref.cancel.notice, NOTICE_SP);
    for (const id of ['tb-form-timezone', 'tb-list-timezone', 'tb-conflicts-timezone']) assert.equal(ref.blocks.notices[id], NOTICE_SP, id);
    assert.deepEqual(ref.blocks.list, ['Todos os profissionais\n27/11/2026 16:00 – 17:00']);
    assert.ok(ref.blocks.conflicts.length > 0 && ref.blocks.conflicts.every((c) => c.startsWith('27/11/2026 ')), JSON.stringify(ref.blocks.conflicts));
    assert.equal(ref.hours.notices['hours-timezone'], NOTICE_SP);
    // Critério 16: o leitor de tela anuncia o fuso em cada dia da grade (AX tree do Chromium).
    for (const day of ['Segunda', 'Domingo']) assert.equal(ref.hoursGroups[day], NOTICE_SP, JSON.stringify(ref.hoursGroups));
    assert.ok(ref.hours.selects.includes('09:00') && ref.hours.selects.includes('18:00'), ref.hours.selects.join(' '));
    assert.ok(ref.slotsDescription && ref.slotsDescription.includes('Horário de Brasília'), String(ref.slotsDescription));
    for (const [i, { out, a11y }] of results.entries()) {
      assert.deepEqual(a11y, [], MATRIX[i].timezoneId);
      assert.deepEqual(out, ref, MATRIX[i].timezoneId);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('"hoje" vem do servidor: 23:30 de 26/11 em São Paulo (critério 3)', () => {
  const LATE = '2026-11-27T02:30:00.000Z';
  let env;

  before(async () => {
    env = await serverWith({ now: LATE, seed: (app) => seedIdenticalBusinesses(app, MATRIX.length, { prefix: 'hoje' }) });
  });

  after(async () => {
    if (env) await env.server.close();
  });

  async function todayJourney(server, b, { timezoneId, locale }) {
    const out = {};
    const { token } = await bookWithLink(server.app, b.slug, bookingBody({ serviceId: b.service.id, professionalId: b.professional.id, start: `${FRIDAY}T10:00` }));
    const client = await tzContext(browser, timezoneId, { locale, nowIso: LATE, width: 360, height: 800 });
    try {
      const { page } = client;
      await page.goto(`${server.baseUrl}/${b.slug}`, { waitUntil: 'load' });
      out.initial = (await captureBooking(page)).date;
      await page.selectOption('#bk-service', b.service.id);
      await page.waitForFunction(() => document.querySelector('.pp-booking').dataset.state === 'ready');
      out.loaded = (await captureBooking(page)).date;
      await page.goto(`${server.baseUrl}/agendamento/${token}`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('main.mg').dataset.state !== 'loading');
      await page.locator('.mg-reschedule-button').click();
      await page.waitForFunction(() => document.querySelector('main.mg').dataset.slots === 'ready');
      out.manageMin = (await captureManage(page)).date.min;
    } finally {
      await client.context.close();
    }
    const owner = await tzContext(browser, timezoneId, { locale, nowIso: LATE, cookies: b.cookies, baseUrl: server.baseUrl });
    try {
      const { page } = owner;
      await page.goto(`${server.baseUrl}/agenda`, { waitUntil: 'load' });
      await waitAgenda(page);
      out.agenda = await captureAgenda(page);
      await afterAgendaReload(page, () => page.click('#next'));
      await afterAgendaReload(page, () => page.click('#today'));
      out.agendaToday = (await captureAgenda(page)).title;
      await page.goto(`${server.baseUrl}/bloqueios`, { waitUntil: 'load' });
      await page.locator('#time-blocks-section').waitFor({ state: 'visible' });
      out.blocks = (await captureTimeBlocks(page)).form;
    } finally {
      await owner.context.close();
    }
    return out;
  }

  test('seletor de data, limites, "Hoje" e padrões ficam em 26/11 nos cinco fusos', async () => {
    const results = [];
    for (const [i, zone] of MATRIX.entries()) results.push(await todayJourney(env.server, env.server.data[i], zone));
    const today = '2026-11-26';
    const ref = results[0];
    const bookingDate = { value: today, min: today, max: addLocalDays(today, BOOKING_HORIZON_DAYS) };
    assert.equal(BOOKING_HORIZON_DAYS, 90);
    assert.deepEqual(ref.initial, bookingDate);
    assert.deepEqual(ref.loaded, bookingDate);
    assert.equal(ref.manageMin, today);
    assert.equal(ref.agenda.title, 'quinta-feira, 26/11/2026');
    assert.equal(ref.agendaToday, 'quinta-feira, 26/11/2026');
    assert.deepEqual(ref.agenda.date, { value: today, min: addLocalDays(today, -AGENDA_PAST_DAYS), max: addLocalDays(today, AGENDA_FUTURE_DAYS) });
    assert.deepEqual([AGENDA_PAST_DAYS, AGENDA_FUTURE_DAYS], [366, 400]);
    assert.deepEqual(ref.blocks, { startDate: today, startTime: '23:00', endDate: today, endTime: '23:45' });
    for (const [i, out] of results.entries()) assert.deepEqual(out, ref, MATRIX[i].timezoneId);
  });
});

// ---------------------------------------------------------------------------------------------

describe('bloqueio criado com o navegador em Manaus (critério 10)', () => {
  let env;

  before(async () => {
    env = await serverWith({ seed: (app) => seedIdenticalBusinesses(app, 1, { prefix: 'bloqueio' }) });
  });

  after(async () => {
    if (env) await env.server.close();
  });

  test('14:00 a 16:00 do negócio: a lista mostra 14:00 – 16:00 e a disponibilidade some nesse intervalo', async () => {
    const [b] = env.server.data;
    const { context, page } = await tzContext(browser, 'America/Manaus', { nowIso: NOW, cookies: b.cookies, baseUrl: env.server.baseUrl });
    try {
      await page.goto(`${env.server.baseUrl}/bloqueios`, { waitUntil: 'load' });
      await page.locator('#time-blocks-section').waitFor({ state: 'visible' });
      await page.selectOption('#professionalId', b.professional.id);
      await page.fill('#start-date', FRIDAY);
      await page.selectOption('#start-time', '14:00');
      await page.fill('#end-date', FRIDAY);
      await page.selectOption('#end-time', '16:00');
      await page.locator('#save-button').click();
      await page.waitForFunction(() => document.querySelectorAll('#time-block-list li').length === 1);
      const blocks = await captureTimeBlocks(page);
      assert.deepEqual(blocks.list, ['Bia Lima\n27/11/2026 14:00 – 16:00']);
      assert.equal(blocks.notices['tb-list-timezone'], NOTICE_SP);
      assert.equal(blocks.notices['tb-form-timezone'], NOTICE_SP);
    } finally {
      await context.close();
    }
    const res = await getAvailability(env.server.app, b.slug, { serviceId: b.service.id, professionalId: b.professional.id, from: FRIDAY });
    const starts = res.json().days[0].slots.map((s) => s.start.slice(11));
    assert.deepEqual(starts.filter((t) => t >= '14:00' && t <= '15:45'), []);
    assert.ok(starts.includes('13:00') && starts.includes('16:00'), starts.join(' '));
  });
});

// ---------------------------------------------------------------------------------------------

describe('texto mais longo (America/Noronha) cabe em 360 px (critério 16)', () => {
  let env;

  before(async () => {
    env = await serverWith({ seed: (app) => seedIdenticalBusinesses(app, 1, { prefix: 'noronha', timezone: 'America/Noronha' }) });
  });

  after(async () => {
    if (env) await env.server.close();
  });

  test('página pública e horários sem rolagem horizontal', async () => {
    const [b] = env.server.data;
    const notice = 'Horários no fuso do estabelecimento: Horário de Fernando de Noronha (America/Noronha).';
    const client = await tzContext(browser, 'Asia/Tokyo', { locale: 'ja-JP', nowIso: NOW, width: 360, height: 800 });
    try {
      const { page } = client;
      await page.goto(`${env.server.baseUrl}/${b.slug}`, { waitUntil: 'load' });
      await pickDay(page, b, FRIDAY);
      assert.equal(await page.locator('#bk-timezone').textContent(), notice);
      assert.deepEqual(await noticeProblems(page, 'bk-timezone', ['ul.pp-slots']), []);
    } finally {
      await client.context.close();
    }
    const owner = await tzContext(browser, 'America/Manaus', { nowIso: NOW, width: 360, height: 800, cookies: b.cookies, baseUrl: env.server.baseUrl });
    try {
      const { page } = owner;
      await page.goto(`${env.server.baseUrl}/horarios`, { waitUntil: 'load' });
      await page.locator('#hours-section').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#hours-timezone').textContent(), notice);
      const groups = await groupDescriptions(page);
      assert.ok(Object.values(groups).filter((d) => d === notice).length >= 7, JSON.stringify(groups));
      assert.deepEqual(await noticeProblems(page, 'hours-timezone', ['fieldset.hours-day']), []);
    } finally {
      await owner.context.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('horário de verão na tela, navegador em Manaus e em Tóquio (critério 6)', () => {
  const BROWSERS = Object.freeze([
    Object.freeze({ timezoneId: 'America/Manaus', locale: 'pt-BR' }),
    Object.freeze({ timezoneId: 'Asia/Tokyo', locale: 'ja-JP' }),
  ]);
  const slotsOf = (page) => page.evaluate(() => [...document.querySelectorAll('.pp-slots .pp-slot')].map((el) => el.textContent));

  test('New York, salto em 08/03: sem 02:xx, o resto como num domingo comum; 03:00 mostra 03:00 no resumo, sucesso e agenda', async () => {
    const now = '2026-03-01T15:00:00.000Z';
    const env = await serverWith({
      now,
      seed: async (app) => [
        await seedDstBusiness(app, { timezone: 'America/New_York', slug: 'verao-ny-1' }),
        await seedDstBusiness(app, { timezone: 'America/New_York', slug: 'verao-ny-2' }),
      ],
    });
    try {
      for (const [i, zone] of BROWSERS.entries()) {
        const b = env.server.data[i];
        const client = await tzContext(browser, zone.timezoneId, { locale: zone.locale, nowIso: now, width: 360, height: 800 });
        try {
          const { page } = client;
          await page.goto(`${env.server.baseUrl}/${b.slug}`, { waitUntil: 'load' });
          await pickDay(page, b, '2026-03-15');
          const normal = await slotsOf(page);
          await pickDay(page, b, '2026-03-08');
          const jump = await slotsOf(page);
          assert.deepEqual(jump.filter((t) => t.startsWith('02:')), [], zone.timezoneId);
          assert.ok(jump.includes('01:00') && jump.includes('03:00'));
          assert.deepEqual(jump, normal.filter((t) => !t.startsWith('02:')));
          await page.locator('.pp-slot').filter({ hasText: /^\s*03:00/ }).click();
          assert.equal(await page.locator('.pp-selected').textContent(), 'Corte · dom, 08/03 · 03:00 – 04:00 (America/New_York)');
          await page.fill('#bk-name', 'Cliente Verão');
          await page.fill('#bk-phone', '11961234567');
          await page.fill('#bk-email', `verao-${i}@example.com`);
          await page.locator('#bk-customer .pp-confirm-button').click();
          await page.locator('.pp-success').waitFor({ state: 'visible' });
          assert.equal((await captureSuccess(page)).find(([k]) => k === 'Horário')[1], '03:00 – 04:00 (America/New_York)');
        } finally {
          await client.context.close();
        }
        const owner = await tzContext(browser, zone.timezoneId, { locale: zone.locale, nowIso: now, cookies: b.cookies, baseUrl: env.server.baseUrl });
        try {
          await owner.page.goto(`${env.server.baseUrl}/agenda?view=day&date=2026-03-08`, { waitUntil: 'load' });
          await waitAgenda(owner.page);
          const agenda = await captureAgenda(owner.page);
          assert.deepEqual(agenda.items, ['✓03:00 às 04:00Confirmado']);
          assert.equal(agenda.timezone, 'Horários no fuso do estabelecimento: America/New_York.');
        } finally {
          await owner.context.close();
        }
      }
    } finally {
      await env.server.close();
    }
  });

  test('New York, volta em 01/11: 10:00 mostra 10:00; Santiago, salto em 06/09: nenhum 00:xx', async () => {
    const fallNow = '2026-10-25T15:00:00.000Z';
    const fall = await serverWith({ now: fallNow, seed: (app) => seedDstBusiness(app, { timezone: 'America/New_York', slug: 'volta-ny' }) });
    const springNow = '2026-09-01T12:00:00.000Z';
    const chile = await serverWith({ now: springNow, seed: (app) => seedDstBusiness(app, { timezone: 'America/Santiago', slug: 'verao-cl' }) });
    try {
      for (const zone of BROWSERS) {
        const a = await tzContext(browser, zone.timezoneId, { locale: zone.locale, nowIso: fallNow, width: 360, height: 800 });
        try {
          await a.page.goto(`${fall.server.baseUrl}/${fall.server.data.slug}`, { waitUntil: 'load' });
          await pickDay(a.page, fall.server.data, '2026-11-01');
          await a.page.locator('.pp-slot').filter({ hasText: /^\s*10:00/ }).click();
          assert.equal(await a.page.locator('.pp-selected').textContent(), 'Corte · dom, 01/11 · 10:00 – 11:00 (America/New_York)', zone.timezoneId);
        } finally {
          await a.context.close();
        }
        const c = await tzContext(browser, zone.timezoneId, { locale: zone.locale, nowIso: springNow, width: 360, height: 800 });
        try {
          await c.page.goto(`${chile.server.baseUrl}/${chile.server.data.slug}`, { waitUntil: 'load' });
          await pickDay(c.page, chile.server.data, '2026-09-06');
          const slots = await slotsOf(c.page);
          assert.ok(slots.length > 0);
          assert.deepEqual(slots.filter((t) => t.startsWith('00:')), [], zone.timezoneId);
          assert.equal(slots[0], '01:00');
        } finally {
          await c.context.close();
        }
      }
    } finally {
      await fall.server.close();
      await chile.server.close();
    }
  });
});
