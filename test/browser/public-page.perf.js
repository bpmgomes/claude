// Medição de desempenho da página pública (AF-09, critério 9 e 12; decisão 1 do gerente).
// Playwright + Chromium via CDP: 4G lento do Lighthouse móvel, CPU 4x, cache frio, 5 execuções,
// p75 (posto mais próximo) de loadEventEnd. Fora do `npm test`: `npm run perf`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import { seedPublicBusiness } from '../helpers/public-fixture.js';
import { PUBLIC_PAGE_BYTES_BUDGET } from '../../src/modules/public-page/public-page.routes.js';

const RUNS = Number.parseInt(process.env.PERF_RUNS || '5', 10);
const BUDGET_MS = Number(process.env.PERF_BUDGET_MS || 2000);

/** Perfil "4G lento" do Lighthouse móvel. */
const NETWORK = Object.freeze({
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
});
const CPU_THROTTLING = 4;
const DEVICE = Object.freeze({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true });

/** Posto mais próximo: p75 de 5 valores é o 4º ordenado. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

const median = (values) => percentile(values, 50);

let server;
let chromium;

before(async () => {
  ({ chromium } = loadPlaywright());
  server = await startServer({
    seed: (app) => seedPublicBusiness(app, { services: 20, professionals: 10, logo: 'realistic' }),
  });
});

after(async () => {
  if (server) await server.close();
});

async function measureOnce(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(DEVICE);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', NETWORK);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING });
    let bytes = 0;
    const requests = [];
    cdp.on('Network.loadingFinished', (event) => {
      bytes += event.encodedDataLength;
    });
    cdp.on('Network.requestWillBeSent', (event) => requests.push(event.request.url));

    const response = await page.goto(url, { waitUntil: 'load' });
    assert.equal(response.status(), 200);
    const timings = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const nav = performance.getEntriesByType('navigation')[0];
          const fcp = performance.getEntriesByName('first-contentful-paint')[0];
          let lcp = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) lcp = Math.max(lcp, entry.startTime);
          }).observe({ type: 'largest-contentful-paint', buffered: true });
          setTimeout(() => resolve({ load: nav.loadEventEnd, fcp: fcp ? fcp.startTime : 0, lcp }), 50);
        }),
    );
    await context.close();
    return { ...timings, bytes, requests: requests.length };
  } finally {
    await browser.close();
  }
}

test(`página de referência (20 serviços, 10 profissionais): p75 de ${RUNS} execuções em 4G lento < ${BUDGET_MS} ms`, async () => {
  const url = `${server.baseUrl}/${server.data.slug}`;
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measureOnce(url));

  const metric = (key) => runs.map((r) => r[key]);
  const report = {
    url,
    runs: RUNS,
    profile: { ...NETWORK, cpuThrottling: CPU_THROTTLING, ...DEVICE, cache: 'cold' },
    samples: runs,
    median: { load: median(metric('load')), fcp: median(metric('fcp')), lcp: median(metric('lcp')), bytes: median(metric('bytes')) },
    p75: {
      load: percentile(metric('load'), 75),
      fcp: percentile(metric('fcp'), 75),
      lcp: percentile(metric('lcp'), 75),
      bytes: percentile(metric('bytes'), 75),
    },
    budget: { loadMs: BUDGET_MS, bytes: PUBLIC_PAGE_BYTES_BUDGET },
  };

  const row = (label, values) =>
    `${label.padEnd(8)} ${values.map((v) => String(Math.round(v)).padStart(9)).join(' ')}`;
  const lines = [
    `${''.padEnd(8)} ${['load(ms)', 'FCP(ms)', 'LCP(ms)', 'bytes'].map((h) => h.padStart(9)).join(' ')}`,
    ...runs.map((r, i) => row(`run ${i + 1}`, [r.load, r.fcp, r.lcp, r.bytes])),
    row('mediana', [report.median.load, report.median.fcp, report.median.lcp, report.median.bytes]),
    row('p75', [report.p75.load, report.p75.fcp, report.p75.lcp, report.p75.bytes]),
  ];
  console.log(lines.join('\n'));
  console.log(JSON.stringify(report));
  if (process.env.PERF_REPORT) await writeFile(process.env.PERF_REPORT, JSON.stringify(report, null, 2));

  assert.ok(report.p75.load < BUDGET_MS, `p75(loadEventEnd) = ${report.p75.load} ms (meta < ${BUDGET_MS} ms)`);
  assert.ok(
    report.p75.bytes <= PUBLIC_PAGE_BYTES_BUDGET,
    `p75(bytes) = ${report.p75.bytes} (orçamento ${PUBLIC_PAGE_BYTES_BUDGET})`,
  );
});
