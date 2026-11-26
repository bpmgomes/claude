import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { seedPublicBusiness } from '../helpers/public-fixture.js';
import { tagsOf } from '../helpers/html.js';
import { PUBLIC_PAGE_BYTES_BUDGET } from '../../src/modules/public-page/public-page.routes.js';
import { PUBLIC_BOOKING_ENTRY } from '../../src/modules/public-page/public-page.render.js';

/**
 * Peso da página (critério 12): HTML + todo stylesheet + todo script + todo modulepreload (AF-10) +
 * todo <img> sem loading="lazy" (primeira dobra), buscados pelo próprio app. URLs repetidas contam
 * uma vez (o navegador busca o módulo uma vez).
 */
async function measure(app, slug) {
  const items = [];
  const page = await app.inject({ method: 'GET', url: `/${slug}` });
  assert.equal(page.statusCode, 200);
  items.push({ url: `/${slug}`, bytes: page.rawPayload.length });
  const urls = [
    ...tagsOf(page.body, 'link').filter((l) => l.rel === 'stylesheet').map((l) => l.href),
    ...tagsOf(page.body, 'script').filter((s) => s.src).map((s) => s.src),
    ...tagsOf(page.body, 'link').filter((l) => l.rel === 'modulepreload').map((l) => l.href),
    ...tagsOf(page.body, 'img').filter((i) => i.loading !== 'lazy').map((i) => i.src),
  ];
  for (const url of new Set(urls)) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    items.push({ url, bytes: res.rawPayload.length });
  }
  const total = items.reduce((sum, i) => sum + i.bytes, 0);
  return { total, items, report: items.map((i) => `${i.url}: ${i.bytes} B`).join('\n') };
}

test(`pior caso (logo de ruído 1024x1024 reprocessado): total <= ${PUBLIC_PAGE_BYTES_BUDGET} bytes (critério 12)`, async () => {
  const { app } = await buildTestApp();
  try {
    const seed = await seedPublicBusiness(app, { services: 20, professionals: 10, logo: 'worst' });
    const { total, items, report } = await measure(app, seed.slug);
    assert.ok(items.some((i) => i.url === seed.business.logoUrl), 'o logo entra na conta');
    assert.ok(items.some((i) => i.url === '/css/public.css'), 'o CSS entra na conta');
    assert.equal(items.filter((i) => i.url.startsWith('/media/professionals/')).length, 0, 'fotos são lazy');
    assert.ok(total <= PUBLIC_PAGE_BYTES_BUDGET, `total ${total} B acima do orçamento:\n${report}`);
  } finally {
    await app.close();
  }
});

test('nomes de 100 caracteres em todos os 30 itens e no endereço cabem no orçamento', async () => {
  const { app } = await buildTestApp();
  try {
    const seed = await seedPublicBusiness(app, {
      services: 20,
      professionals: 10,
      logo: 'worst',
      names: { business: 'N'.repeat(100), address: 'E'.repeat(200) },
    });
    // Renomeia todos os serviços e profissionais para 100 caracteres (únicos).
    for (const [i, s] of seed.services.entries()) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/services/${s.id}`,
        cookies: seed.cookies,
        payload: { name: `${String(i).padStart(2, '0')}${'S'.repeat(98)}` },
      });
      assert.equal(res.statusCode, 200);
    }
    for (const [i, p] of seed.professionals.entries()) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/professionals/${p.id}`,
        cookies: seed.cookies,
        payload: { name: `${String(i).padStart(2, '0')}${'P'.repeat(98)}` },
      });
      assert.equal(res.statusCode, 200);
    }
    const { total, report } = await measure(app, seed.slug);
    assert.ok(total <= PUBLIC_PAGE_BYTES_BUDGET, `total ${total} B acima do orçamento:\n${report}`);
  } finally {
    await app.close();
  }
});

/** Imports estáticos de um módulo ES (`from '...'` e `import '...'`), resolvidos a partir da URL. */
function staticImportsOf(source, url) {
  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  return specifiers.map((spec) => new URL(spec, `http://x${url}`).pathname);
}

test('AF-10: todo o grafo de imports do módulo de horários tem modulepreload e cabe no orçamento (critério 29)', async () => {
  const { app } = await buildTestApp();
  try {
    const seed = await seedPublicBusiness(app, { services: 20, professionals: 10, logo: 'worst' });
    const page = await app.inject({ method: 'GET', url: `/${seed.slug}` });
    const preloaded = new Set(tagsOf(page.body, 'link').filter((l) => l.rel === 'modulepreload').map((l) => l.href));

    const graph = new Map();
    const queue = [PUBLIC_BOOKING_ENTRY];
    while (queue.length > 0) {
      const url = queue.shift();
      if (graph.has(url)) continue;
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /javascript/, url);
      graph.set(url, res.rawPayload.length);
      queue.push(...staticImportsOf(res.body, url));
    }
    assert.ok(graph.size >= 5, [...graph.keys()].join(', '));
    for (const url of graph.keys()) assert.ok(preloaded.has(url), `${url} sem modulepreload`);
    for (const url of preloaded) assert.ok(graph.has(url), `${url} pré-carregado sem estar no grafo`);

    const jsBytes = [...graph.values()].reduce((a, b) => a + b, 0);
    assert.ok(jsBytes < 60 * 1024, `JS do grafo: ${jsBytes} B`);
    const { total, report } = await measure(app, seed.slug);
    assert.ok(total <= PUBLIC_PAGE_BYTES_BUDGET, `total ${total} B acima do orçamento:\n${report}`);
  } finally {
    await app.close();
  }
});
