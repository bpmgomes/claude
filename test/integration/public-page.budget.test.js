import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { seedPublicBusiness } from '../helpers/public-fixture.js';
import { tagsOf } from '../helpers/html.js';
import { PUBLIC_PAGE_BYTES_BUDGET } from '../../src/modules/public-page/public-page.routes.js';

/**
 * Peso da página (critério 12): HTML + todo stylesheet + todo script + todo <img> sem
 * loading="lazy" (primeira dobra), buscados pelo próprio app.
 */
async function measure(app, slug) {
  const items = [];
  const page = await app.inject({ method: 'GET', url: `/${slug}` });
  assert.equal(page.statusCode, 200);
  items.push({ url: `/${slug}`, bytes: page.rawPayload.length });
  const urls = [
    ...tagsOf(page.body, 'link').filter((l) => l.rel === 'stylesheet').map((l) => l.href),
    ...tagsOf(page.body, 'script').filter((s) => s.src).map((s) => s.src),
    ...tagsOf(page.body, 'img').filter((i) => i.loading !== 'lazy').map((i) => i.src),
  ];
  for (const url of urls) {
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
