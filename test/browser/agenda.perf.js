// Desempenho da agenda do dono (AF-14, design 6.3): 1.000 agendamentos na semana em 20 profissionais;
// tempo da navegação até a lista com 1.000 itens renderizada e sem novas mutações por 100 ms
// (MutationObserver instalado antes dos scripts da página). Dispositivo do perf do AF-09 (viewport,
// densidade e CPU 4x, cache frio). A rede fica sem limitação na meta (< 1 s): o 4G lento do AF-09
// sozinho custa mais que isso em latência (página, módulos e três leituras da API em série); o número
// com 4G lento sai no relatório, informativo. Fora do `npm test`: `npm run perf`.
/* global document, window, MutationObserver */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import { signupAndLogin, createBusinessFor, createService } from '../helpers/session.js';
import { seedWeek } from '../helpers/agenda.js';

const RUNS = Number.parseInt(process.env.PERF_RUNS || '5', 10);
const NOW = '2026-11-26T12:00:00.000Z';
const WEEK = ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'];
const BUDGET_MS = Number(process.env.AGENDA_PERF_BUDGET_MS || 1000);
const QUIET_MS = 100;
const CPU_THROTTLING = 4;
const DEVICE = Object.freeze({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true });
const SLOW_4G = Object.freeze({ offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

let server;
let chromium;

before(async () => {
  ({ chromium } = loadPlaywright());
  server = await startServer({
    now: NOW,
    overrides: { rateLimit: { enabled: true, agendaRead: { perUser: 5000, perIp: 5000 } } },
    seed: async (app) => {
      const cookies = await signupAndLogin(app, { email: 'dono-perf@x.com' });
      const business = await createBusinessFor(app, cookies, { name: 'Salão Perf', slug: 'salao-perf' });
      const service = await createService(app, cookies, { name: 'Corte', durationMinutes: 15, price: '50' });
      await seedWeek(app.db, { businessId: business.id, serviceId: service.id, days: WEEK, perDay: 10, professionals: 20 });
      return { cookies };
    },
  });
});

after(async () => {
  if (server) await server.close();
});

async function measureOnce(url, { network } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(DEVICE);
    await context.addCookies([{ name: 'af_session', value: server.data.cookies.af_session, url: server.baseUrl }]);
    await context.addInitScript(() => {
      window.__lastMutation = 0;
      new MutationObserver(() => {
        window.__lastMutation = performance.now();
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (network) await cdp.send('Network.emulateNetworkConditions', network);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING });
    const response = await page.goto(url, { waitUntil: 'commit' });
    assert.equal(response.status(), 200);
    await page.waitForFunction(
      (quiet) => document.querySelectorAll('.ag-item').length === 1000 && performance.now() - window.__lastMutation >= quiet,
      QUIET_MS,
      { timeout: 60_000, polling: 20 },
    );
    const rendered = await page.evaluate(() => window.__lastMutation);
    const items = await page.locator('.ag-item').count();
    await context.close();
    return { rendered, items };
  } finally {
    await browser.close();
  }
}

test(`agenda da semana com 1.000 itens: p75 de ${RUNS} execuções < ${BUDGET_MS} ms (CPU ${CPU_THROTTLING}x)`, async () => {
  const url = `${server.baseUrl}/agenda?view=week&date=${WEEK[0]}`;
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measureOnce(url));
  const slow = await measureOnce(url, { network: SLOW_4G });
  const values = runs.map((r) => r.rendered);
  const report = {
    url,
    runs: RUNS,
    metric: 'navegação até 1.000 .ag-item renderizados e 100 ms sem mutações',
    profile: { cpuThrottling: CPU_THROTTLING, ...DEVICE, cache: 'cold', network: 'sem limitação' },
    samples: runs,
    median: percentile(values, 50),
    p75: percentile(values, 75),
    informative: { slow4g: slow.rendered, profile: SLOW_4G },
    budget: { renderedMs: BUDGET_MS },
  };
  console.log(runs.map((r, i) => `run ${i + 1}: ${Math.round(r.rendered)} ms (${r.items} itens)`).join('\n'));
  console.log(`mediana ${Math.round(report.median)} ms, p75 ${Math.round(report.p75)} ms; 4G lento (informativo): ${Math.round(slow.rendered)} ms`);
  console.log(JSON.stringify(report));
  if (process.env.PERF_REPORT) await writeFile(`${process.env.PERF_REPORT}.agenda.json`, JSON.stringify(report, null, 2));
  assert.ok(runs.every((r) => r.items === 1000));
  assert.ok(report.p75 < BUDGET_MS, `p75 = ${report.p75} ms (meta < ${BUDGET_MS} ms)`);
});
