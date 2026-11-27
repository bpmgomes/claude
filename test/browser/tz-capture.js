// Helpers do E2E de fusos do AF-23 (design 6.2): negócios idênticos, um por fuso do navegador, e
// capturas só dos textos que carregam horário ou fuso, para comparar byte a byte com a referência
// (America/Sao_Paulo). O relógio do navegador fica fixo no instante do servidor (Clock API do
// Playwright): o fuso do navegador é a única variável.
/* global document */
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, setBusinessTimezone, WEEK_9_TO_18 } from '../helpers/session.js';

/**
 * Cria `n` negócios idênticos (mesmo nome, serviço, profissional e grade); só o slug e o dono mudam,
 * e eles não aparecem nos textos capturados.
 * @returns {Promise<Array<{ cookies: { af_session: string }, business: object, slug: string, service: object, professional: object }>>}
 */
export async function seedIdenticalBusinesses(app, n, { timezone = 'America/Sao_Paulo', hours = WEEK_9_TO_18, prefix = 'fuso', name = 'Salão Fuso', durationMinutes = 60 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const slug = `${prefix}-${i + 1}`;
    const cookies = await signupAndLogin(app, { email: `dono-${slug}@x.com` });
    const business = await createBusinessFor(app, cookies, { name, slug });
    if (timezone !== 'America/Sao_Paulo') await setBusinessTimezone(app, business.id, timezone);
    const service = await createService(app, cookies, { name: 'Corte', durationMinutes, price: '50' });
    const professional = await createProfessional(app, cookies, { name: 'Bia Lima', serviceIds: [service.id] });
    const res = await putHours(app, cookies, professional.id, hours);
    if (res.statusCode !== 200) throw new Error(`grade: ${res.body}`);
    out.push({ cookies, business, slug, service, professional });
  }
  return out;
}

/**
 * Contexto do navegador num fuso, com `locale` e o relógio fixo em `nowIso`. Com `cookies`, a sessão
 * do dono entra no contexto.
 * @returns {Promise<{ context: import('playwright').BrowserContext, page: import('playwright').Page }>}
 */
export async function tzContext(browser, timezoneId, { locale = 'pt-BR', nowIso, width = 1280, height = 900, cookies, baseUrl } = {}) {
  const context = await browser.newContext({ timezoneId, locale, viewport: { width, height } });
  if (cookies) await context.addCookies([{ name: 'af_session', value: cookies.af_session, url: baseUrl }]);
  if (nowIso) await context.clock.setFixedTime(new Date(nowIso));
  const page = await context.newPage();
  return { context, page };
}

/** Texto de cada `[data-tz-notice]` da página, por `id` (vazio antes do AF-23). */
function noticesIn(page) {
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-tz-notice]')].map((el) => [el.id, el.textContent])));
}

/** Página pública: aviso, campo de data, status, botões, resumo e sugestões. */
export async function captureBooking(page) {
  return {
    notices: await noticesIn(page),
    ...(await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const date = q('#bk-date');
      return {
        timezone: q('.pp-booking .pp-timezone')?.textContent ?? null,
        date: date ? { value: date.value, min: date.min, max: date.max } : null,
        status: q('.pp-status')?.textContent ?? null,
        slots: [...document.querySelectorAll('.pp-slots .pp-slot')].map((b) => b.textContent),
        selected: q('.pp-selected')?.textContent ?? null,
        suggestions: [...document.querySelectorAll('.pp-suggestions-list .pp-suggestion')].map((b) => b.textContent),
      };
    })),
  };
}

/** Tela de sucesso: pares dt/dd. */
export function captureSuccess(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.pp-success .pp-success-details dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? '']),
  );
}

/** Gerenciar: resumo, prazo, aviso do painel, data, botões e resumo da remarcação. */
export async function captureManage(page) {
  return {
    notices: await noticesIn(page),
    ...(await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const date = q('#mg-date');
      return {
        details: [...document.querySelectorAll('.mg-details dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? '']),
        deadline: q('.mg-deadline')?.textContent ?? null,
        timezone: q('.mg-timezone')?.textContent ?? null,
        date: date ? { value: date.value, min: date.min, max: date.max } : null,
        status: q('.mg-slots-status')?.textContent ?? null,
        slots: [...document.querySelectorAll('.mg-slots .pp-slot')].map((b) => b.textContent),
        selected: q('.mg-selected')?.textContent ?? null,
      };
    })),
  };
}

/** Agenda: título, aviso, campo de data, cabeçalhos de dia e itens (sem o e-mail do cliente). */
export async function captureAgenda(page) {
  return {
    notices: await noticesIn(page),
    ...(await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const date = q('#agenda-date');
      return {
        title: q('#agenda-title')?.textContent ?? null,
        timezone: q('#agenda-timezone')?.textContent ?? null,
        date: date ? { value: date.value, min: date.min, max: date.max } : null,
        days: [...document.querySelectorAll('.ag-day-title')].map((h) => h.textContent),
        items: [...document.querySelectorAll('.ag-item .ag-line')].map((l) => l.textContent),
      };
    })),
  };
}

/** Diálogo de detalhe da agenda (os campos que carregam horário). */
export async function captureAgendaDetail(page) {
  return {
    notices: await noticesIn(page),
    ...(await page.evaluate(() => {
      const t = (id) => document.getElementById(id)?.textContent ?? null;
      return { when: t('detail-when'), situation: t('detail-situation'), service: t('detail-service'), chain: [...document.querySelectorAll('#detail-chain li')].map((li) => li.textContent) };
    })),
  };
}

/** Bloqueios: avisos, datas e horas do formulário, lista e painel de conflitos. */
export async function captureTimeBlocks(page) {
  return {
    notices: await noticesIn(page),
    ...(await page.evaluate(() => {
      const v = (id) => document.getElementById(id)?.value ?? null;
      const lines = (el) => [...el.querySelectorAll('p')].map((p) => p.textContent).join('\n');
      return {
        form: { startDate: v('start-date'), startTime: v('start-time'), endDate: v('end-date'), endTime: v('end-time') },
        list: [...document.querySelectorAll('#time-block-list .service-info')].map(lines),
        conflicts: [...document.querySelectorAll('#conflicts-list .service-info')].map(lines),
      };
    })),
  };
}

/** Horários: aviso e valores dos `<select>` da grade. */
export async function captureHours(page) {
  return {
    notices: await noticesIn(page),
    selects: await page.evaluate(() => [...document.querySelectorAll('#days select')].map((s) => s.value)),
  };
}
