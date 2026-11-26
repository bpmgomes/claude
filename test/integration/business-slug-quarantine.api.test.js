import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import { signupAndLogin, createBusinessFor } from '../helpers/session.js';
import { NOT_FOUND_HTML } from '../../src/modules/public-page/public-page.render.js';
import { SLUG_QUARANTINE_DAYS, SLUG_QUARANTINE_PER_BUSINESS_MAX } from '../../src/modules/businesses/businesses.service.js';

const DAY = 24 * 60 * 60 * 1000;
const BUSINESS = { name: 'Salão', address: 'Rua A, 10', phone: '(11) 91234-5678' };

let app;
let clock;
let ana;
let anaBusiness;

beforeEach(async () => {
  clock = createClock('2026-03-01T12:00:00.000Z');
  ({ app } = await buildTestApp({ now: clock.now }));
  ana = await signupAndLogin(app, { email: 'ana@x.com' });
  anaBusiness = await createBusinessFor(app, ana, { slug: 'salao-da-ana' });
});

afterEach(async () => {
  await app.close();
});

const post = (cookies, slug) => app.inject({ method: 'POST', url: '/api/business', cookies, payload: { ...BUSINESS, slug } });
const patch = (cookies, payload) => app.inject({ method: 'PATCH', url: '/api/business', cookies, payload });
const availability = (cookies, slug) =>
  app.inject({ method: 'GET', url: `/api/business/slug-availability?slug=${encodeURIComponent(slug)}`, cookies });
const quarantine = () => app.db.all('SELECT slug, business_id, released_at FROM slug_quarantine ORDER BY slug');

/** O corpo do 409 sem a sugestão (que depende do slug pedido). */
function withoutSuggestion(res) {
  const { error } = res.json();
  const { suggestion, ...rest } = error;
  return { rest, suggestion };
}

test('constantes da decisão 6', () => {
  assert.equal(SLUG_QUARANTINE_DAYS, 30);
  assert.equal(SLUG_QUARANTINE_PER_BUSINESS_MAX, 3);
});

describe('troca X -> Y (critério 24, AF-05 item 5)', () => {
  test('outro dono recebe 409 SLUG_TAKEN com sugestão em POST e em PATCH, com corpo igual ao de slug em uso', async () => {
    assert.equal((await patch(ana, { slug: 'ana-beleza' })).statusCode, 200);
    assert.deepEqual(await quarantine(), [
      { slug: 'salao-da-ana', business_id: anaBusiness.id, released_at: '2026-03-01T12:00:00.000Z' },
    ]);

    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const quarantined = await post(bia, 'salao-da-ana');
    const inUse = await post(bia, 'ana-beleza');
    assert.equal(quarantined.statusCode, 409);
    assert.equal(inUse.statusCode, 409);
    assert.deepEqual(withoutSuggestion(quarantined).rest, withoutSuggestion(inUse).rest);
    assert.equal(withoutSuggestion(quarantined).suggestion, 'salao-da-ana-2');
    assert.equal(withoutSuggestion(inUse).suggestion, 'ana-beleza-2');
    assert.equal(quarantined.json().error.code, 'SLUG_TAKEN');
    // O rollback desfaz o insert.
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM businesses')).n, 1);

    assert.equal((await post(bia, 'salao-da-bia')).statusCode, 201);
    const patched = await patch(bia, { slug: 'salao-da-ana' });
    assert.equal(patched.statusCode, 409);
    assert.deepEqual(withoutSuggestion(patched).rest, withoutSuggestion(inUse).rest);
    assert.equal(withoutSuggestion(patched).suggestion, 'salao-da-ana-2');
    assert.equal((await app.db.get("SELECT slug FROM businesses WHERE slug = 'salao-da-bia'")).slug, 'salao-da-bia');
  });

  test('slug-availability: TAKEN para outro dono, livre para o próprio', async () => {
    await patch(ana, { slug: 'ana-beleza' });
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    assert.deepEqual((await availability(bia, 'salao-da-ana')).json(), {
      slug: 'salao-da-ana',
      available: false,
      reason: 'TAKEN',
      message: 'Este link já está em uso.',
      suggestion: 'salao-da-ana-2',
    });
    assert.deepEqual((await availability(ana, 'salao-da-ana')).json(), { slug: 'salao-da-ana', available: true });
  });

  test('o dono volta ao próprio slug antigo: 200 e a linha sai da quarentena', async () => {
    await patch(ana, { slug: 'ana-beleza' });
    const back = await patch(ana, { slug: 'salao-da-ana' });
    assert.equal(back.statusCode, 200);
    assert.equal(back.json().business.slug, 'salao-da-ana');
    assert.deepEqual(
      (await quarantine()).map((r) => r.slug),
      ['ana-beleza'],
    );
  });

  test('com o relógio em +30 dias + 1 ms, outro dono consegue X', async () => {
    await patch(ana, { slug: 'ana-beleza' });
    clock.advance(SLUG_QUARANTINE_DAYS * DAY - 1);
    // Sessão nova: a de antes expirou por inatividade (7 dias).
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    assert.equal((await post(bia, 'salao-da-ana')).statusCode, 409);
    clock.advance(2);
    const res = await post(bia, 'salao-da-ana');
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().business.slug, 'salao-da-ana');
  });

  test('suggestSlug não sugere slug em quarentena', async () => {
    const cris = await signupAndLogin(app, { email: 'cris@x.com' });
    assert.equal((await post(cris, 'salao-da-ana-2')).statusCode, 201);
    assert.equal((await patch(cris, { slug: 'cris' })).statusCode, 200);
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const res = await post(bia, 'salao-da-ana');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.suggestion, 'salao-da-ana-3');
    assert.equal(await app.services.businessesService.suggestSlug('salao-da-ana'), 'salao-da-ana-3');
    // Para o próprio dono, o slug dele em quarentena é uma sugestão válida.
    assert.equal(
      await app.services.businessesService.suggestSlug('salao-da-ana', {
        exceptBusinessId: (await app.db.get("SELECT id FROM businesses WHERE slug = 'cris'")).id,
      }),
      'salao-da-ana-2',
    );
  });

  test('quatro trocas seguidas deixam só os 3 últimos em quarentena', async () => {
    for (const slug of ['slug-b', 'slug-c', 'slug-d', 'slug-e']) {
      clock.advance(1000);
      assert.equal((await patch(ana, { slug })).statusCode, 200);
    }
    assert.deepEqual(
      (await quarantine()).map((r) => r.slug),
      ['slug-b', 'slug-c', 'slug-d'],
    );
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    assert.equal((await post(bia, 'salao-da-ana')).statusCode, 201);
  });

  test('editar sem trocar o slug não toca a quarentena', async () => {
    assert.equal((await patch(ana, { name: 'Novo nome', slug: 'salao-da-ana' })).statusCode, 200);
    assert.deepEqual(await quarantine(), []);
  });

  test('GET /X dá o 404 uniforme durante a quarentena', async () => {
    await patch(ana, { slug: 'ana-beleza' });
    const res = await app.inject({ method: 'GET', url: '/salao-da-ana' });
    assert.equal(res.statusCode, 404);
    assert.ok(res.rawPayload.equals(NOT_FOUND_HTML));
  });
});

test('corrida: PATCH A X->Y contra POST B com X nunca deixa B com X depois da troca, nem 500', async () => {
  for (let round = 0; round < 20; round++) {
    // O relógio anda entre as trocas (released_at distintos), como em produção.
    clock.advance(1000);
    const x = `corrida-x-${round}`;
    const y = `corrida-y-${round}`;
    assert.equal((await patch(ana, { slug: x })).statusCode, 200);
    const b = await signupAndLogin(app, { email: `b${round}@x.com` });
    const [a, bRes] = await Promise.all([patch(ana, { slug: y }), post(b, x)]);
    assert.ok([200, 409].includes(a.statusCode), `A ${a.statusCode}`);
    assert.ok([201, 409].includes(bRes.statusCode), `B ${bRes.statusCode}`);
    if (bRes.statusCode === 201) assert.equal(a.statusCode, 409, 'B criou X e a troca de A também passou');
    const owner = await app.db.get('SELECT id FROM businesses WHERE slug = ?', [x]);
    if (a.statusCode === 200) assert.equal(owner, undefined);
    if (bRes.statusCode === 409) assert.equal(bRes.json().error.code, 'SLUG_TAKEN');
  }
});
