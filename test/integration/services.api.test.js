import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from '../helpers/test-app.js';
import { signupAndLogin, createBusinessFor, createService } from '../helpers/session.js';
import { SERVICE_MESSAGES as M, serviceNameKey } from '../../src/shared/services.js';

let app;
let logs;
let ana;
let anaBusiness;

beforeEach(async () => {
  ({ app, logs } = await buildTestApp());
  ana = await signupAndLogin(app, { email: 'ana@x.com' });
  anaBusiness = await createBusinessFor(app, ana);
});

afterEach(async () => {
  await app.close();
});

function api(method, url, cookies, payload, headers = {}) {
  return app.inject({ method, url, cookies, payload, headers });
}

const post = (cookies, payload) => api('POST', '/api/services', cookies, payload);
const patch = (cookies, id, payload) => api('PATCH', `/api/services/${id}`, cookies, payload);
const list = (cookies, query = '') => api('GET', `/api/services${query}`, cookies);
const action = (cookies, id, name) => api('POST', `/api/services/${id}/${name}`, cookies);

async function count() {
  return (await app.db.get('SELECT COUNT(*) AS n FROM services')).n;
}

async function otherOwner(email = 'bia@x.com', name = 'Salão da Bia') {
  const cookies = await signupAndLogin(app, { email });
  const business = await createBusinessFor(app, cookies, { name });
  return { cookies, business };
}

/** Insere `n` serviços direto pelo repositório (metade desativados). */
async function fill(businessId, n) {
  const repo = app.services.servicesRepository;
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    const name = `Serviço ${i}`;
    await repo.insert({
      id: randomUUID(),
      businessId,
      name,
      nameKey: serviceNameKey(name),
      durationMinutes: 30,
      priceCents: 100,
      priceOnRequest: false,
      active: i % 2 === 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}

describe('criação (critérios 1, 5, 6)', () => {
  test('201 com service e linha no negócio do dono', async () => {
    const res = await post(ana, { name: 'Corte masculino', durationMinutes: 30, price: '50,50' });
    assert.equal(res.statusCode, 201);
    const { service } = res.json();
    assert.equal(service.name, 'Corte masculino');
    assert.equal(service.durationMinutes, 30);
    assert.equal(service.priceCents, 5050);
    assert.ok(Number.isInteger(service.priceCents));
    assert.equal(service.priceOnRequest, false);
    assert.equal(service.active, true);
    assert.equal('businessId' in service, false);
    assert.equal('nameKey' in service, false);
    const row = await app.db.get('SELECT business_id FROM services WHERE id = ?', [service.id]);
    assert.equal(row.business_id, anaBusiness.id);
    const read = await api('GET', `/api/services/${service.id}`, ana);
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), { service });
  });

  test('businessId de outro negócio, active false, priceCents e id no corpo são ignorados', async () => {
    const bia = await otherOwner();
    const res = await post(ana, {
      name: 'Corte',
      durationMinutes: 30,
      price: '50',
      businessId: bia.business.id,
      business_id: bia.business.id,
      active: false,
      priceCents: 1,
      id: 'fixo',
    });
    assert.equal(res.statusCode, 201);
    const row = await app.db.get('SELECT * FROM services');
    assert.equal(row.business_id, anaBusiness.id);
    assert.equal(row.active, 1);
    assert.equal(row.price_cents, 5000);
    assert.notEqual(row.id, 'fixo');
    assert.deepEqual((await list(bia.cookies)).json(), { services: [] });
  });

  test('sob consulta sem preço -> 201 priceCents null; com preço -> 400 fields.price', async () => {
    const ok = await post(ana, { name: 'Coloração', durationMinutes: 120, priceOnRequest: true });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().service.priceCents, null);
    assert.equal(ok.json().service.priceOnRequest, true);
    const bad = await post(ana, { name: 'Luzes', durationMinutes: 120, priceOnRequest: true, price: '50' });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json().error.fields, { price: M.priceWithOnRequest });
  });

  test('gratuito: price "0" -> 201 priceCents 0', async () => {
    const res = await post(ana, { name: 'Avaliação', durationMinutes: 15, price: '0' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().service.priceCents, 0);
    assert.equal(res.json().service.priceOnRequest, false);
  });

  test('preço como número JSON 50.5 -> 5050', async () => {
    const res = await post(ana, { name: 'Barba', durationMinutes: 30, price: 50.5 });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().service.priceCents, 5050);
  });
});

describe('401 sem sessão (critério 2)', () => {
  const id = randomUUID();
  for (const [method, url] of [
    ['GET', '/api/services'],
    ['GET', `/api/services/${id}`],
    ['POST', '/api/services'],
    ['PATCH', `/api/services/${id}`],
    ['POST', `/api/services/${id}/deactivate`],
    ['POST', `/api/services/${id}/reactivate`],
  ]) {
    test(`${method} ${url}`, async () => {
      const payload = method === 'POST' && url === '/api/services' ? { name: 'X', durationMinutes: 30, price: '1' } : undefined;
      const res = await app.inject({ method, url, payload: method === 'PATCH' ? { name: 'X' } : payload });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'UNAUTHENTICATED');
      assert.equal(await count(), 0);
    });
  }
});

describe('dono sem negócio (critério 2)', () => {
  test('GET e POST -> 409 BUSINESS_REQUIRED', async () => {
    const carla = await signupAndLogin(app, { email: 'carla@x.com' });
    for (const res of [await list(carla), await post(carla, { name: 'X', durationMinutes: 30, price: '1' })]) {
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, 'BUSINESS_REQUIRED');
      assert.equal(res.json().error.message, M.businessRequired);
    }
    assert.equal(await count(), 0);
  });
});

describe('validação (critérios 3, 4, 5, 7)', () => {
  test('corpo vazio -> 400 com name, durationMinutes e price', async () => {
    const res = await post(ana, {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    assert.deepEqual(Object.keys(res.json().error.fields).sort(), ['durationMinutes', 'name', 'price']);
  });

  for (const bad of [0, 10, 20, 495, -15, 30.5, '30', 'abc', '']) {
    test(`duração ${JSON.stringify(bad)} -> 400 fields.durationMinutes`, async () => {
      const res = await post(ana, { name: 'X', durationMinutes: bad, price: '1' });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(Object.keys(res.json().error.fields), ['durationMinutes']);
    });
  }

  for (const [bad, message] of [
    ['50,555', M.priceDecimals],
    ['-1', M.priceNegative],
    ['abc', M.priceInvalid],
    ['100000', M.priceTooHigh],
    ['1.000,00', M.priceInvalid],
  ]) {
    test(`preço ${bad} -> 400 ${message}`, async () => {
      const res = await post(ana, { name: 'X', durationMinutes: 30, price: bad });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.json().error.fields, { price: message });
    });
  }

  test('nome com U+202E -> 400', async () => {
    const res = await post(ana, { name: 'Corte‮', durationMinutes: 30, price: '1' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json().error.fields, { name: M.nameInvalid });
  });

  test('sem eco: nome de 10.000 caracteres e preço de 5.000 dígitos -> resposta curta sem a entrada', async () => {
    const name = 'N'.repeat(10_000);
    const price = '7'.repeat(5_000);
    const res = await post(ana, { name, durationMinutes: 30, price });
    assert.equal(res.statusCode, 400);
    assert.ok(Buffer.byteLength(res.body) < 1024, `${res.body.length} bytes`);
    assert.ok(!res.body.includes('NNNNNNNNNN'));
    assert.ok(!res.body.includes('7777777777'));
  });

  test('status=<script> -> 400 sem o valor', async () => {
    const res = await list(ana, `?status=${encodeURIComponent('<script>')}`);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json().error.fields, { status: M.statusInvalid });
    assert.ok(!res.body.includes('script'));
  });
});

describe('XSS e injeção (critério 3)', () => {
  for (const name of ['<img src=x onerror=alert(1)>', "x'); DROP TABLE services;--"]) {
    test(`${name} gravado e devolvido literalmente`, async () => {
      const res = await post(ana, { name, durationMinutes: 30, price: '1' });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().service.name, name);
      assert.equal((await list(ana)).json().services[0].name, name);
      assert.equal(await count(), 1);
    });
  }
});

describe('duplicidade (critério 20)', () => {
  test('mesmo nome com outra caixa ou acento -> 409 SERVICE_NAME_TAKEN', async () => {
    await createService(app, ana, { name: 'Corte Masculino' });
    for (const name of ['corte masculino', 'CÓRTE MASCULINO', '  Corte   Masculino ']) {
      const res = await post(ana, { name, durationMinutes: 30, price: '1' });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, 'SERVICE_NAME_TAKEN');
      assert.deepEqual(res.json().error.fields, { name: M.nameTaken });
    }
    assert.equal(await count(), 1);
  });

  test('nome de um desativado -> mensagem para reativar', async () => {
    const s = await createService(app, ana, { name: 'Barba' });
    await action(ana, s.id, 'deactivate');
    const res = await post(ana, { name: 'barba', durationMinutes: 30, price: '1' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.message, M.nameTakenInactive);
    assert.deepEqual(res.json().error.fields, { name: M.nameTakenInactive });
  });

  test('mesmo nome em outro negócio -> 201', async () => {
    await createService(app, ana, { name: 'Corte' });
    const bia = await otherOwner();
    assert.equal((await post(bia.cookies, { name: 'Corte', durationMinutes: 30, price: '1' })).statusCode, 201);
  });

  test('dois POST simultâneos com o mesmo nome -> um 201, um 409, nenhum 500', async () => {
    const body = { name: 'Corte', durationMinutes: 30, price: '1' };
    const statuses = (await Promise.all([post(ana, body), post(ana, { ...body, name: 'CORTE' })])).map((r) => r.statusCode);
    assert.deepEqual(statuses.sort(), [201, 409]);
    assert.equal(await count(), 1);
  });
});

describe('limite de 100 por negócio (critério 18)', () => {
  test('com 100 (metade desativados) -> 409 SERVICE_LIMIT_REACHED', async () => {
    await fill(anaBusiness.id, 100);
    const res = await post(ana, { name: 'Novo', durationMinutes: 30, price: '1' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'SERVICE_LIMIT_REACHED');
    assert.equal(res.json().error.message, M.limitReached);
    assert.equal(await count(), 100);
  });

  test('com 99, dois POST simultâneos com nomes diferentes -> um 201, um 409, total 100', async () => {
    await fill(anaBusiness.id, 99);
    const responses = await Promise.all([
      post(ana, { name: 'Novo A', durationMinutes: 30, price: '1' }),
      post(ana, { name: 'Novo B', durationMinutes: 30, price: '1' }),
    ]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal(responses.find((r) => r.statusCode === 409).json().error.code, 'SERVICE_LIMIT_REACHED');
    assert.equal(await count(), 100);
  });

  test('o limite é por negócio', async () => {
    await fill(anaBusiness.id, 100);
    const bia = await otherOwner();
    assert.equal((await post(bia.cookies, { name: 'Corte', durationMinutes: 30, price: '1' })).statusCode, 201);
  });
});

describe('edição (critérios 8, 19)', () => {
  test('PATCH de nome, duração e preço', async () => {
    const s = await createService(app, ana);
    const res = await patch(ana, s.id, { name: 'Corte degradê', durationMinutes: 45, price: '65,90' });
    assert.equal(res.statusCode, 200);
    const { service } = res.json();
    assert.equal(service.name, 'Corte degradê');
    assert.equal(service.durationMinutes, 45);
    assert.equal(service.priceCents, 6590);
    assert.equal(service.createdAt, s.createdAt);
  });

  test('{} -> 400 Nada para atualizar; campos inválidos -> 400', async () => {
    const s = await createService(app, ana);
    const empty = await patch(ana, s.id, {});
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error.message, 'Nada para atualizar.');
    const bad = await patch(ana, s.id, { durationMinutes: 20 });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(Object.keys(bad.json().error.fields), ['durationMinutes']);
  });

  test('par preço/sob consulta no PATCH', async () => {
    const s = await createService(app, ana, { name: 'Coloração', price: undefined, priceOnRequest: true });
    assert.equal(s.priceOnRequest, true);
    const priced = await patch(ana, s.id, { price: '120' });
    assert.equal(priced.statusCode, 200);
    assert.equal(priced.json().service.priceOnRequest, false);
    assert.equal(priced.json().service.priceCents, 12000);
    const onRequest = await patch(ana, s.id, { priceOnRequest: true });
    assert.equal(onRequest.json().service.priceCents, null);
    assert.equal(onRequest.json().service.priceOnRequest, true);
    const missing = await patch(ana, s.id, { priceOnRequest: false });
    assert.equal(missing.statusCode, 400);
    assert.deepEqual(missing.json().error.fields, { price: M.priceRequired });
    const both = await patch(ana, s.id, { priceOnRequest: true, price: '1' });
    assert.equal(both.statusCode, 400);
  });

  test('renomear para a própria grafia com outra caixa -> 200; para nome de outro -> 409', async () => {
    const corte = await createService(app, ana, { name: 'Corte' });
    await createService(app, ana, { name: 'Barba' });
    const same = await patch(ana, corte.id, { name: 'CÓRTE' });
    assert.equal(same.statusCode, 200);
    assert.equal(same.json().service.name, 'CÓRTE');
    const clash = await patch(ana, corte.id, { name: 'barba' });
    assert.equal(clash.statusCode, 409);
    assert.equal(clash.json().error.code, 'SERVICE_NAME_TAKEN');
    assert.deepEqual(clash.json().error.fields, { name: M.nameTaken });
  });

  test('dois PATCH simultâneos (preço x sob consulta) -> dois 200, estado consistente e igual a um deles', async () => {
    for (let round = 0; round < 5; round++) {
      const s = await createService(app, ana, { name: `Serviço ${round}` });
      const [a, b] = await Promise.all([
        patch(ana, s.id, { price: '77' }),
        patch(ana, s.id, { priceOnRequest: true }),
      ]);
      assert.equal(a.statusCode, 200);
      assert.equal(b.statusCode, 200);
      const row = await app.db.get('SELECT price_cents, price_on_request FROM services WHERE id = ?', [s.id]);
      const options = [
        { price_cents: 7700, price_on_request: 0 },
        { price_cents: null, price_on_request: 1 },
      ];
      assert.ok(options.some((o) => o.price_cents === row.price_cents && o.price_on_request === row.price_on_request));
    }
  });
});

describe('ciclo de vida (critérios 9, 10, 13)', () => {
  test('deactivate, repetir, editar desativado e reactivate', async () => {
    const s = await createService(app, ana);
    const off = await action(ana, s.id, 'deactivate');
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().service.active, false);
    assert.equal(off.json().futureAppointmentsCount, 0);
    assert.equal((await app.db.get('SELECT active FROM services WHERE id = ?', [s.id])).active, 0);
    assert.equal(await count(), 1);

    const again = await action(ana, s.id, 'deactivate');
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().service.active, false);

    const edited = await patch(ana, s.id, { price: '10' });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().service.active, false);

    const on = await action(ana, s.id, 'reactivate');
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().service.active, true);
    assert.equal('futureAppointmentsCount' in on.json(), false);
    assert.equal((await action(ana, s.id, 'reactivate')).statusCode, 200);
  });

  test('DELETE -> 404 e a linha continua no banco', async () => {
    const s = await createService(app, ana);
    const res = await api('DELETE', `/api/services/${s.id}`, ana);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
    assert.equal(await count(), 1);
    assert.equal((await app.db.get('SELECT active FROM services WHERE id = ?', [s.id])).active, 1);
  });
});

describe('listagem (critério 12)', () => {
  test('ativos primeiro, depois nome; filtros', async () => {
    const barba = await createService(app, ana, { name: 'Barba' });
    await createService(app, ana, { name: 'Ácido' });
    await createService(app, ana, { name: 'Corte' });
    await action(ana, barba.id, 'deactivate');
    const names = (q) => list(ana, q).then((r) => r.json().services.map((s) => s.name));
    assert.deepEqual(await names(''), ['Ácido', 'Corte', 'Barba']);
    assert.deepEqual(await names('?status=all'), ['Ácido', 'Corte', 'Barba']);
    assert.deepEqual(await names('?status=active'), ['Ácido', 'Corte']);
    assert.deepEqual(await names('?status=inactive'), ['Barba']);
    const inactive = (await list(ana, '?status=inactive')).json().services[0];
    assert.equal(inactive.active, false);
    assert.equal((await list(ana, '?status=foo')).statusCode, 400);
  });
});

describe('isolamento (critério 15)', () => {
  test('dono B recebe 404 idêntico ao de um UUID inexistente', async () => {
    const s = await createService(app, ana);
    const bia = await otherOwner();
    const missing = randomUUID();
    const pairs = [
      [api('GET', `/api/services/${s.id}`, bia.cookies), api('GET', `/api/services/${missing}`, bia.cookies)],
      [patch(bia.cookies, s.id, { name: 'Hack' }), patch(bia.cookies, missing, { name: 'Hack' })],
      [action(bia.cookies, s.id, 'deactivate'), action(bia.cookies, missing, 'deactivate')],
      [action(bia.cookies, s.id, 'reactivate'), action(bia.cookies, missing, 'reactivate')],
    ];
    for (const [theirs, none] of pairs) {
      const [a, b] = await Promise.all([theirs, none]);
      assert.equal(a.statusCode, 404);
      assert.equal(a.body, b.body);
      assert.equal(a.json().error.code, 'SERVICE_NOT_FOUND');
      assert.equal(a.json().error.message, M.notFound);
    }
    const row = await app.db.get('SELECT name, active FROM services WHERE id = ?', [s.id]);
    assert.deepEqual(row, { name: 'Corte', active: 1 });
    assert.deepEqual((await list(bia.cookies)).json(), { services: [] });
  });

  test(':id inválido -> 404 SERVICE_NOT_FOUND', async () => {
    for (const id of ['abc', encodeURIComponent('../x'), randomUUID().toUpperCase()]) {
      const res = await api('GET', `/api/services/${id}`, ana);
      assert.equal(res.statusCode, 404, id);
      assert.equal(res.json().error.code, 'SERVICE_NOT_FOUND');
      assert.equal((await patch(ana, id, { name: 'X' })).statusCode, 404);
    }
  });
});

describe('CSRF (critério 16)', () => {
  test('Origin de outro site -> 403 em todas as mutações e nada é gravado', async () => {
    const s = await createService(app, ana);
    const evil = { origin: 'https://evil.example' };
    const responses = [
      await api('POST', '/api/services', ana, { name: 'Outro', durationMinutes: 30, price: '1' }, evil),
      await api('PATCH', `/api/services/${s.id}`, ana, { name: 'Hack' }, evil),
      await api('POST', `/api/services/${s.id}/deactivate`, ana, undefined, evil),
      await api('POST', `/api/services/${s.id}/reactivate`, ana, undefined, evil),
      await api('DELETE', `/api/services/${s.id}`, ana, undefined, evil),
    ];
    for (const res of responses) {
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'FORBIDDEN_ORIGIN');
    }
    assert.equal(await count(), 1);
    assert.deepEqual(await app.db.get('SELECT name, active FROM services'), { name: 'Corte', active: 1 });
  });
});

describe('logs', () => {
  test('eventos registrados sem nome nem preço do serviço', async () => {
    const s = await createService(app, ana, { name: 'Nome Secreto do Log', price: '4321,09' });
    await patch(ana, s.id, { durationMinutes: 60 });
    await action(ana, s.id, 'deactivate');
    await action(ana, s.id, 'reactivate');
    const text = logs();
    for (const event of ['service_created', 'service_updated', 'service_deactivated', 'service_reactivated']) {
      assert.ok(text.includes(event), event);
    }
    assert.ok(!text.includes('Nome Secreto do Log'));
    // Compara valores dos logs, e não o texto: '4321' aparece por acaso em `time`, `responseTime`
    // ou UUIDs e deixava o teste intermitente (AF-20).
    const values = [];
    const collect = (v) => (v && typeof v === 'object' ? Object.values(v).forEach(collect) : values.push(v));
    for (const line of text.split('\n').filter(Boolean)) collect(JSON.parse(line));
    const leaked = values.filter((v) => v === 432109 || v === 4321.09 || /4[.]?321,09|432109/.test(String(v)));
    assert.deepEqual(leaked, []);
  });
});

describe('página e onboarding (critério 23)', () => {
  test('GET /servicos serve a tela de serviços', async () => {
    const res = await app.inject({ method: 'GET', url: '/servicos' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /service-form/);
    assert.match(res.body, /\/js\/servicos-page\.js/);
  });

  test('/shared/services.js é servido para o browser', async () => {
    const res = await app.inject({ method: 'GET', url: '/shared/services.js' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /parsePriceToCents/);
  });
});
