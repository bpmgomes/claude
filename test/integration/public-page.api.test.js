import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import { seedPublicBusiness } from '../helpers/public-fixture.js';
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } from '../helpers/session.js';
import { pngOf } from '../helpers/images.js';
import { tagsOf, tagNamesOf, textOf } from '../helpers/html.js';
import {
  PUBLIC_PAGE_CSP,
  NOT_FOUND_HTML,
  ERROR_HTML,
  PUBLIC_BOOKING_MODULES,
  PUBLIC_BOOKING_ENTRY,
} from '../../src/modules/public-page/public-page.render.js';

const get = (app, url, options = {}) => app.inject({ method: 'GET', url, ...options });

/** Instrumenta o banco do app: registra todo SQL executado até `stop()`. */
function recordSql(app) {
  const calls = [];
  const db = app.db;
  const originals = {};
  for (const method of ['get', 'all', 'run']) {
    originals[method] = db[method];
    db[method] = function recorded(sql, params) {
      calls.push(sql);
      return originals[method].call(this, sql, params);
    };
  }
  return {
    calls,
    stop() {
      for (const [method, fn] of Object.entries(originals)) db[method] = fn;
    },
  };
}

function assertUniform404(res, reference, label) {
  assert.equal(res.statusCode, 404, label);
  assert.ok(res.rawPayload.equals(NOT_FOUND_HTML), `${label}: corpo diferente`);
  for (const header of ['content-type', 'cache-control', 'content-security-policy', 'x-robots-tag', 'x-frame-options', 'referrer-policy', 'x-content-type-options']) {
    assert.equal(res.headers[header], reference.headers[header], `${label}: ${header}`);
  }
}

describe('página de referência (critérios 1, 2, 10, 16, 17, 22, 23)', () => {
  let app;
  let seed;
  let reference404;

  before(async () => {
    ({ app } = await buildTestApp());
    seed = await seedPublicBusiness(app, { services: 20, professionals: 10, logo: 'realistic' });
    reference404 = await get(app, '/nao-existe-esse-negocio');
  });

  after(async () => {
    await app.close();
  });

  test('sem cookie: 200 text/html com os 20 serviços e os 10 profissionais no HTML inicial, só o módulo como script', async () => {
    const res = await get(app, `/${seed.slug}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(tagsOf(res.body, 'li').filter((li) => li.class === 'pp-service').length, 20);
    assert.equal(tagsOf(res.body, 'li').filter((li) => li.class === 'pp-professional').length, 10);
    // AF-10: um único <script type="module" src>, sem script inline, e um modulepreload por módulo.
    assert.deepEqual(tagsOf(res.body, 'script'), [{ type: 'module', src: PUBLIC_BOOKING_ENTRY }]);
    assert.match(res.body, /<script type="module" src="\/js\/public-booking-page\.js"><\/script>/);
    assert.deepEqual(
      tagsOf(res.body, 'link').filter((l) => l.rel === 'modulepreload').map((l) => l.href),
      [...PUBLIC_BOOKING_MODULES],
    );
    assert.doesNotMatch(res.body, /fetch\(|\/api\//);
    const text = textOf(res.body);
    for (const s of seed.services) assert.ok(text.includes(s.name), s.name);
    for (const p of seed.professionals) assert.ok(text.includes(p.name), p.name);
    assert.ok(text.includes('Sob consulta'));
    assert.ok(text.includes('Rua A, 10'));
    assert.ok(text.includes('(11) 91234-5678'));
  });

  test('logo e fotos usam as URLs de /media com width e height', async () => {
    const res = await get(app, `/${seed.slug}`);
    const imgs = tagsOf(res.body, 'img');
    assert.equal(imgs[0].src, seed.business.logoUrl);
    assert.deepEqual(
      imgs.slice(1).map((i) => i.src),
      seed.professionals.map((p) => p.photoUrl),
    );
    for (const img of imgs) assert.ok(img.width && img.height && img.alt);
    for (const img of imgs) assert.equal((await get(app, img.src)).statusCode, 200, img.src);
  });

  test('cabeçalhos de segurança (critério 22)', async () => {
    const res = await get(app, `/${seed.slug}`);
    assert.equal(res.headers['content-security-policy'], PUBLIC_PAGE_CSP);
    assert.doesNotMatch(res.headers['content-security-policy'], /unsafe-inline/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['referrer-policy']);
    assert.ok(res.headers['x-frame-options']);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('cache: public, max-age=60, ETag e 304 com If-None-Match (critério 23)', async () => {
    const res = await get(app, `/${seed.slug}`);
    assert.equal(res.headers['cache-control'], 'public, max-age=60');
    assert.match(res.headers.etag, /^W\/"[A-Za-z0-9_-]{27}"$/);
    const again = await get(app, `/${seed.slug}`, { headers: { 'if-none-match': res.headers.etag } });
    assert.equal(again.statusCode, 304);
    assert.equal(again.body, '');
    assert.equal(again.headers.etag, res.headers.etag);
    assert.equal(again.headers['cache-control'], 'public, max-age=60');
    const other = await get(app, `/${seed.slug}`, { headers: { 'if-none-match': 'W/"outro"' } });
    assert.equal(other.statusCode, 200);
  });

  test('/media continua com 1 dia de cache (AF-05 item 4, AF-07)', async () => {
    const logo = await get(app, seed.business.logoUrl);
    assert.equal(logo.headers['cache-control'], 'public, max-age=86400');
    const photo = await get(app, seed.professionals[0].photoUrl);
    assert.equal(photo.headers['cache-control'], 'public, max-age=86400');
  });

  test('nenhum dado interno no HTML (critério 17)', async () => {
    const res = await get(app, `/${seed.slug}`);
    const me = (await get(app, '/api/me', { cookies: seed.cookies })).json().user;
    const forbidden = [me.email, me.id, seed.business.id, seed.business.createdAt, seed.business.updatedAt];
    for (const s of seed.services) forbidden.push(s.createdAt);
    for (const p of seed.professionals) forbidden.push(p.createdAt, p.updatedAt);
    for (const value of forbidden) assert.equal(res.body.includes(value), false, value);
    for (const word of ['created_at', 'updated_at', 'name_key', 'nameKey', 'removed', 'owner']) {
      assert.equal(res.body.includes(word), false, word);
    }
    // Chave de storage só aparece como parte de /media/.
    assert.equal(/(?<!\/media\/)(logos|professionals)\/[0-9a-f-]{36}/.test(res.body), false);
    // AF-10: os UUIDs de serviço e profissional aparecem só nos atributos da escolha de horário.
    const allowed = new Set([...seed.services.map((s) => s.id), ...seed.professionals.map((p) => p.id)]);
    for (const uuid of res.body.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) || []) {
      assert.ok(allowed.has(uuid) || res.body.includes(`/media/logos/${uuid}`) || res.body.includes(`/media/professionals/${uuid}`), uuid);
    }
  });

  test('seção #agendar com os UUIDs de serviço e profissional nas opções (AF-10, critério 28)', async () => {
    const res = await get(app, `/${seed.slug}`);
    const options = tagsOf(res.body, 'option');
    const serviceValues = options.filter((o) => o['data-duration']).map((o) => o.value);
    assert.deepEqual(new Set(serviceValues), new Set(seed.services.map((s) => s.id)));
    const professionalOptions = options.filter((o) => 'data-services' in o);
    assert.deepEqual(new Set(professionalOptions.map((o) => o.value)), new Set(seed.professionals.map((p) => p.id)));
    for (const o of professionalOptions) {
      const professional = seed.professionals.find((p) => p.id === o.value);
      assert.deepEqual(new Set(o['data-services'].split(' ')), new Set(professional.services.map((x) => x.id)));
    }
    assert.ok(options.some((o) => o.value === 'any'));
    const [section] = tagsOf(res.body, 'section').filter((x) => x.class === 'pp-booking');
    assert.equal(section['data-slug'], seed.slug);
    assert.equal(section['data-timezone'], 'America/Sao_Paulo');
  });

  test('os módulos do grafo são servidos como JavaScript (modulepreload)', async () => {
    for (const url of PUBLIC_BOOKING_MODULES) {
      const res = await get(app, url);
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /javascript/, url);
    }
  });

  test('com cookie de sessão válido: corpo idêntico, sem set-cookie (critério 22)', async () => {
    const anonymous = await get(app, `/${seed.slug}`);
    const withCookie = await get(app, `/${seed.slug}`, { cookies: seed.cookies });
    assert.equal(withCookie.statusCode, 200);
    assert.equal(withCookie.body, anonymous.body);
    assert.equal(withCookie.headers['set-cookie'], undefined);
  });

  test('canonicalização: maiúsculas e barra final dão 301 sem query (critério 6)', async () => {
    const upper = seed.slug.toUpperCase();
    for (const url of [`/${upper}`, `/${seed.slug}/`, `/${upper}/`, `/${seed.slug}/?x=<script>`]) {
      const res = await get(app, url);
      assert.equal(res.statusCode, 301, url);
      assert.equal(res.headers.location, `/${seed.slug}`, url);
      assert.equal(res.headers['cache-control'], 'public, max-age=60');
    }
    const q = await get(app, `/${upper}?x=1`);
    assert.equal(q.headers.location, `/${seed.slug}`);
  });

  test('/Inexistente dá 301 sem nenhuma consulta ao banco', async () => {
    const recorder = recordSql(app);
    try {
      const res = await get(app, '/Inexistente');
      assert.equal(res.statusCode, 301);
      assert.equal(res.headers.location, '/inexistente');
      const slash = await get(app, '/inexistente/');
      assert.equal(slash.statusCode, 301);
      const invalid = await get(app, '/a--b');
      assert.equal(invalid.statusCode, 404);
    } finally {
      recorder.stop();
    }
    assert.deepEqual(recorder.calls, []);
  });

  test('404 uniforme: mesmos bytes e cabeçalhos para todo caso, sem eco (critérios 6, 20, 21)', async () => {
    assert.equal(reference404.statusCode, 404);
    assert.equal(reference404.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(reference404.headers['cache-control'], 'public, max-age=60');
    assert.equal(reference404.headers['content-security-policy'], PUBLIC_PAGE_CSP);
    assert.equal(reference404.headers['x-robots-tag'], 'noindex');
    const cases = [
      '/inexistente',
      '/ab',
      '/admin',
      '/admin/',
      `/${encodeURIComponent('salão')}`,
      '/abc%00',
      '/abc%0A',
      '/%E2%80%AE',
      `/${encodeURIComponent('İstanbul')}`,
      '/a.html',
      '/login.html',
      '/favicon.ico',
      `/${'a'.repeat(60)}`,
      `/${'b'.repeat(101)}`,
      `/${'c'.repeat(10_000)}`,
      '/%E0%A4%A',
      '/%E0%A4%A/',
      '/css/nao-existe.css',
    ];
    for (const url of cases) {
      const res = await get(app, url);
      assertUniform404(res, reference404, url.slice(0, 40));
      const needle = decodeURIComponentSafe(url.slice(1)).slice(0, 20);
      if (needle.length >= 3) assert.equal(res.body.includes(needle), false, `${url.slice(0, 40)}: ecoou a entrada`);
    }
    const head = await app.inject({ method: 'HEAD', url: '/inexistente' });
    assert.equal(head.statusCode, 404);
    assert.equal(head.headers['content-security-policy'], PUBLIC_PAGE_CSP);
  });

  test('a API continua com o 404 JSON', async () => {
    const res = await get(app, '/api/nao-existe');
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });

  test('AF-09 item 1: erros de framework trazem o mesmo conjunto de cabeçalhos do helmet de um 404 normal', async () => {
    const TRANSPORT = new Set(['connection', 'content-length', 'date', 'keep-alive']);
    const names = (res) => Object.keys(res.headers).filter((h) => !TRANSPORT.has(h)).sort();
    const helmetOnly = ['strict-transport-security', 'cross-origin-resource-policy', 'cross-origin-opener-policy', 'referrer-policy',
      'origin-agent-cluster', 'x-dns-prefetch-control', 'x-download-options', 'x-permitted-cross-domain-policies', 'x-xss-protection'];

    const jsonReference = await get(app, '/api/nada');
    const htmlReference = await get(app, '/nada', { headers: { accept: 'text/html' } });
    for (const name of helmetOnly) assert.ok(jsonReference.headers[name], `referência sem ${name}`);

    // JSON 400: o conjunto do 404 da API mais o no-store.
    for (const url of ['/api/public/%E0%A4%A/availability', '/api/%E0%A4%A']) {
      const res = await get(app, url);
      assert.equal(res.statusCode, 400, url);
      assert.deepEqual(names(res), [...names(jsonReference), 'cache-control'].sort(), url);
      for (const name of helmetOnly) assert.equal(res.headers[name], jsonReference.headers[name], `${url}: ${name}`);
    }
    // 404 HTML: exatamente o conjunto (e os valores) de um 404 HTML normal.
    for (const url of ['/%E0%A4%A', '/%E0%A4%A/']) {
      const res = await get(app, url, { headers: { accept: 'text/html' } });
      assert.equal(res.statusCode, 404, url);
      assert.deepEqual(names(res), names(htmlReference), url);
      for (const name of names(htmlReference)) assert.equal(res.headers[name], htmlReference.headers[name], `${url}: ${name}`);
    }
    // Fonte única: o que foi capturado do helmet no boot é o que o 404 normal traz.
    const captured = app.securityHeaders.get();
    for (const [name, value] of Object.entries(captured)) assert.equal(jsonReference.headers[name], value, name);
    assert.ok(Object.isFrozen(captured));
  });

  test('AF-09 item 1: URL malformada na API dá JSON 400 com nosniff, no-store, CSP e X-Frame-Options', async () => {
    for (const url of ['/api/%E0%A4%A', '/media/%E0%A4%A']) {
      const res = await get(app, url);
      assert.equal(res.statusCode, 400, url);
      assert.deepEqual(res.json(), { error: { code: 'VALIDATION_ERROR', message: 'Requisição inválida.' } });
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.body.includes('%E0'), false);
    }
  });
});

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

describe('visibilidade e mudanças do dono (critérios 3 a 5, 7, 23, 24)', () => {
  let app;
  let clock;
  let ana;

  beforeEach(async () => {
    clock = createClock('2026-03-01T12:00:00.000Z');
    ({ app } = await buildTestApp({ now: clock.now }));
    ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
  });

  afterEach(async () => {
    await app.close();
  });

  const page = () => get(app, '/salao-da-ana');
  const names = (res, cls) => {
    const re = new RegExp(`<h3 class="${cls}">([^<]*)</h3>`, 'g');
    return [...res.body.matchAll(re)].map((m) => m[1]);
  };

  async function bookable(name, serviceIds) {
    const p = await createProfessional(app, ana, { name, serviceIds });
    assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
    return p;
  }

  test('AF-16 (critério 23): bloqueios não mudam a página nem expõem o motivo', async () => {
    const corte = await createService(app, ana, { name: 'Corte' });
    const p = await bookable('Bia Lima', [corte.id]);
    const before = await page();
    for (const professionalId of [null, p.id]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/time-blocks',
        cookies: ana,
        payload: { professionalId, start: '2026-03-01T00:00', end: '2026-03-31T00:00', reasonKind: 'vacation', reasonNote: 'Férias da Ana' },
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    const after = await page();
    assert.equal(after.statusCode, 200);
    assert.deepEqual(names(after, 'pp-professional-name'), names(before, 'pp-professional-name'));
    assert.ok(!after.body.includes('Férias da Ana'));
    assert.ok(!/bloque/i.test(after.body));
  });

  test('negócio sem serviços: 200 com estado vazio explicativo (critério 7)', async () => {
    const res = await page();
    assert.equal(res.statusCode, 200);
    const text = textOf(res.body);
    assert.ok(text.includes('Agendamento online indisponível'));
    assert.ok(text.includes('Este negócio ainda não tem serviços disponíveis para agendar pela internet.'));
    assert.ok(tagsOf(res.body, 'a').some((a) => a.href === 'tel:+5511912345678'));
    assert.equal(tagsOf(res.body, 'img').length, 0);
    assert.ok(tagsOf(res.body, 'div').some((d) => d.class === 'pp-logo pp-logo-placeholder'));
  });

  test('com serviço mas sem profissional apto: estado vazio', async () => {
    const corte = await createService(app, ana, { name: 'Corte' });
    await createProfessional(app, ana, { name: 'Sem grade', serviceIds: [corte.id] });
    const res = await page();
    assert.equal(res.statusCode, 200);
    assert.ok(textOf(res.body).includes('Agendamento online indisponível'));
    assert.deepEqual(names(res, 'pp-service-name'), []);
  });

  test('serviço desativado some; serviço sem profissional some; profissional sem grade reaparece com a grade', async () => {
    const corte = await createService(app, ana, { name: 'Corte' });
    const barba = await createService(app, ana, { name: 'Barba' });
    await createService(app, ana, { name: 'Sozinho' });
    await bookable('Ana', [corte.id, barba.id]);
    const semGrade = await createProfessional(app, ana, { name: 'Bia', serviceIds: [corte.id] });

    let res = await page();
    assert.deepEqual(names(res, 'pp-service-name'), ['Barba', 'Corte']);
    assert.deepEqual(names(res, 'pp-professional-name'), ['Ana']);
    const etag = res.headers.etag;

    assert.equal((await putHours(app, ana, semGrade.id, WEEK_9_TO_18)).statusCode, 200);
    res = await page();
    assert.deepEqual(names(res, 'pp-professional-name'), ['Ana', 'Bia']);
    assert.notEqual(res.headers.etag, etag);

    const off = await app.inject({ method: 'POST', url: `/api/services/${barba.id}/deactivate`, cookies: ana });
    assert.equal(off.statusCode, 200);
    res = await page();
    assert.deepEqual(names(res, 'pp-service-name'), ['Corte']);
    assert.equal(res.body.includes('Barba'), false);
  });

  test('desativar um serviço muda o ETag e o 304 deixa de valer (critério 23)', async () => {
    const corte = await createService(app, ana, { name: 'Corte' });
    const barba = await createService(app, ana, { name: 'Barba' });
    await bookable('Ana', [corte.id, barba.id]);
    const first = await page();
    await app.inject({ method: 'POST', url: `/api/services/${barba.id}/deactivate`, cookies: ana });
    const second = await page();
    assert.notEqual(second.headers.etag, first.headers.etag);
    const conditional = await get(app, '/salao-da-ana', { headers: { 'if-none-match': first.headers.etag } });
    assert.equal(conditional.statusCode, 200);
    assert.equal(conditional.body.includes('Barba'), false);
  });

  test('profissional só com serviço desativado e profissional removido não aparecem', async () => {
    const corte = await createService(app, ana, { name: 'Corte' });
    const luzes = await createService(app, ana, { name: 'Luzes' });
    await bookable('Ana', [corte.id]);
    await bookable('Bia', [luzes.id]);
    const cris = await bookable('Cris', [corte.id]);
    await app.inject({ method: 'POST', url: `/api/services/${luzes.id}/deactivate`, cookies: ana });
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/professionals/${cris.id}`, cookies: ana })).statusCode, 204);
    const res = await page();
    assert.deepEqual(names(res, 'pp-professional-name'), ['Ana']);
    assert.deepEqual(names(res, 'pp-service-name'), ['Corte']);
    assert.ok(res.body.includes('Com: Ana<'));
  });

  test('foto ausente dá avatar padrão; logo aparece depois do upload', async () => {
    const corte = await createService(app, ana, { name: 'Corte' });
    await bookable('Ana', [corte.id]);
    let res = await page();
    assert.equal(tagsOf(res.body, 'img').find((i) => i.class === 'pp-avatar').src, '/img/avatar-default.svg');
    assert.equal((await get(app, '/img/avatar-default.svg')).statusCode, 200);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/business/logo',
      cookies: ana,
      headers: { 'content-type': 'image/png' },
      payload: await pngOf(300, 300),
    });
    assert.equal(put.statusCode, 200);
    res = await page();
    const logo = tagsOf(res.body, 'img').find((i) => i.class === 'pp-logo');
    assert.equal(logo.src, put.json().business.logoUrl);
    assert.equal(tagsOf(res.body, 'meta').find((m) => m.property === 'og:image').content, `https://agendafacil.app${logo.src}`);
  });

  test('com cookie, a sessão do dono não é lida: last_seen_at não muda (critério 22)', async () => {
    const before = await app.db.get('SELECT last_seen_at FROM sessions');
    clock.advance(5 * 60 * 1000);
    const res = await get(app, '/salao-da-ana', { cookies: ana });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.deepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
    const logo404 = await get(app, '/media/logos/00000000-0000-4000-8000-000000000000.png', { cookies: ana });
    assert.equal(logo404.statusCode, 404);
    assert.deepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
    // Controle: uma rota do dono toca a sessão.
    await get(app, '/api/me', { cookies: ana });
    assert.notDeepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
  });

  test('AF-09 item 4: o 404 de fallback (HTML e JSON) não lê nem renova a sessão do dono', async () => {
    const before = await app.db.get('SELECT last_seen_at FROM sessions');
    clock.advance(5 * 60 * 1000);
    for (const url of ['/inexistente', `/${'a'.repeat(101)}`, '/api/nao-existe', '/css/nao-existe.css']) {
      const res = await get(app, url, { cookies: ana });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.headers['set-cookie'], undefined, url);
    }
    assert.deepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
    // Controle: uma rota do dono toca a sessão.
    await get(app, '/api/me', { cookies: ana });
    assert.notDeepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
  });

  test('data-today e data-max-date no fuso do negócio, pelo relógio do servidor (AF-10)', async () => {
    const corte = await createService(app, ana, { name: 'Corte' });
    await bookable('Ana', [corte.id]);
    let [section] = tagsOf((await page()).body, 'section').filter((x) => x.class === 'pp-booking');
    assert.equal(section['data-today'], '2026-03-01');
    assert.equal(section['data-max-date'], '2026-05-30');
    // 23:30 em São Paulo (02:30Z do dia seguinte) continua no dia local.
    clock.advance((14 * 60 + 30) * 60 * 1000);
    [section] = tagsOf((await page()).body, 'section').filter((x) => x.class === 'pp-booking');
    assert.equal(section['data-today'], '2026-03-01');
    const [date] = tagsOf((await page()).body, 'input').filter((i) => i.id === 'bk-date');
    assert.equal(date.min, '2026-03-01');
    assert.equal(date.max, '2026-05-30');
  });

  test('slug antigo depois da troca: 404 uniforme; o novo dá 200 (critério 24)', async () => {
    const reference = await get(app, '/nao-existe');
    const patch = await app.inject({ method: 'PATCH', url: '/api/business', cookies: ana, payload: { slug: 'ana-beleza' } });
    assert.equal(patch.statusCode, 200);
    assertUniform404(await page(), reference, 'slug antigo');
    assert.equal((await get(app, '/ana-beleza')).statusCode, 200);
  });
});

test('erro inesperado: 500 HTML fixo, no-store e log public_page_error sem eco', async () => {
  const { app, logs } = await buildTestApp();
  try {
    app.services.publicPageService = {
      getPage: async () => {
        throw new Error('falha simulada');
      },
    };
    const res = await get(app, '/salao-qualquer');
    assert.equal(res.statusCode, 500);
    assert.ok(res.rawPayload.equals(ERROR_HTML));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['content-security-policy'], PUBLIC_PAGE_CSP);
    assert.match(logs(), /"event":"public_page_error"/);
    assert.match(res.body, /Não foi possível carregar a página agora\. Tente novamente em instantes\./);
  } finally {
    await app.close();
  }
});
