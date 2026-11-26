// AF-04 (critério 16) e AF-16 item 5: `Cache-Control: no-store` em toda resposta de /api/* sem
// política própria, inclusive erros; as rotas fora de /api/ mantêm as políticas delas. AF-11: o POST
// público de agendamento também.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import { seedPublicBusiness } from '../helpers/public-fixture.js';
import { bookingBody, postAppointment } from '../helpers/appointments.js';

describe('no-store em /api/*', () => {
  let app;
  let seed;

  before(async () => {
    const clock = createClock('2026-11-26T12:00:00.000Z');
    ({ app } = await buildTestApp({ now: clock.now }));
    seed = await seedPublicBusiness(app, { services: 1, professionals: 1, logo: 'realistic', photos: false });
  });

  after(async () => {
    await app.close();
  });

  const cases = [
    ['GET /api/business (200, dono)', () => ({ method: 'GET', url: '/api/business', cookies: seed.cookies }), 200],
    ['GET /api/business sem sessão (401)', () => ({ method: 'GET', url: '/api/business' }), 401],
    [
      'POST /api/auth/login com senha errada (401)',
      () => ({ method: 'POST', url: '/api/auth/login', payload: { email: 'ninguem@x.com', password: 'errada123' } }),
      401,
    ],
    ['GET /api/nao-existe (404 JSON)', () => ({ method: 'GET', url: '/api/nao-existe' }), 404],
    [
      'PATCH /api/business inválido (400)',
      () => ({ method: 'PATCH', url: '/api/business', cookies: seed.cookies, payload: { phone: 'abc' } }),
      400,
    ],
    [
      'GET /api/public/<slug>/availability (200)',
      () => ({
        method: 'GET',
        url: `/api/public/${seed.slug}/availability?serviceId=${seed.services[0].id}&professionalId=any&from=2026-11-27&to=2026-11-27`,
      }),
      200,
    ],
  ];

  for (const [label, request, status] of cases) {
    test(label, async () => {
      const res = await app.inject(request());
      assert.equal(res.statusCode, status, res.body);
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  }

  test('POST /api/public/<slug>/appointments com 201, 409 e 422 (AF-11, critério 41)', async () => {
    const key = '3b241101-e2bb-4255-8caf-4136c566a962';
    const post = (start, headers = {}) =>
      postAppointment(
        app,
        seed.slug,
        bookingBody({ serviceId: seed.services[0].id, professionalId: seed.professionals[0].id, start, customer: { phone: '(11) 97654-3210' } }),
        { headers },
      );
    const created = await post('2026-11-27T10:00', { 'idempotency-key': key });
    const taken = await post('2026-11-27T10:00');
    const reused = await post('2026-11-27T14:00', { 'idempotency-key': key });
    assert.deepEqual([created.statusCode, taken.statusCode, reused.statusCode], [201, 409, 422]);
    for (const res of [created, taken, reused]) assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('as 4 rotas do gerenciar com no-store em 200, 404 e 409 (AF-12, critério 34)', async () => {
    const { bookWithLink, getManage, manageAvailability, cancelManage, rescheduleManage } = await import('../helpers/manage.js');
    const { token } = await bookWithLink(
      app,
      seed.slug,
      bookingBody({ serviceId: seed.services[0].id, professionalId: seed.professionals[0].id, start: '2026-11-27T15:00', customer: { phone: '(11) 97654-3211' } }),
    );
    const missing = 'Q'.repeat(43);
    const stale = 'w'.repeat(43);
    const responses = [
      [200, await getManage(app, token)],
      [404, await getManage(app, missing)],
      [200, await manageAvailability(app, token, { date: '2026-11-27' })],
      [404, await manageAvailability(app, missing, { date: '2026-11-27' })],
      [409, await rescheduleManage(app, token, { start: '2026-11-27T16:00', version: stale })],
      [404, await rescheduleManage(app, missing, { start: '2026-11-27T16:00', version: stale })],
      [409, await cancelManage(app, token, { version: stale })],
      [404, await cancelManage(app, missing, { version: stale })],
    ];
    const version = (await getManage(app, token)).json().change.version;
    responses.push([200, await rescheduleManage(app, token, { start: '2026-11-27T16:00', version })]);
    responses.push([200, await cancelManage(app, token, { version: (await getManage(app, token)).json().change.version })]);
    for (const [status, res] of responses) {
      assert.equal(res.statusCode, status, res.body);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  });

  // QA AF-04: o roteador decodifica o percent-encoding (`/%61pi/business` casa `GET /api/business`);
  // a política segue a rota casada ou o caminho decodificado, nunca o texto bruto.
  const encoded = [
    ['GET /%61pi/business (200, dono)', { method: 'GET', url: '/%61pi/business' }, 200, true],
    ['GET /%61pi/me (200, dono)', { method: 'GET', url: '/%61pi/me' }, 200, true],
    ['GET /%61pi/me sem sessão (401)', { method: 'GET', url: '/%61pi/me' }, 401, false],
    ['GET /a%70i/business (200, dono)', { method: 'GET', url: '/a%70i/business' }, 200, true],
    ['GET /%61%70%69/business (200, dono)', { method: 'GET', url: '/%61%70%69/business' }, 200, true],
    ['GET /%61pi/nao-existe (404 JSON)', { method: 'GET', url: '/%61pi/nao-existe' }, 404, false],
    ['HEAD /%61pi/nao-existe (404)', { method: 'HEAD', url: '/%61pi/nao-existe' }, 404, false],
    ['POST /%61pi/nao-existe (404 JSON)', { method: 'POST', url: '/%61pi/nao-existe', payload: {} }, 404, false],
    ['GET /%61pi/%E0%A4%A (400 de framework)', { method: 'GET', url: '/%61pi/%E0%A4%A' }, 400, false],
  ];
  for (const [label, request, status, logged] of encoded) {
    test(`caminho codificado: ${label}`, async () => {
      const res = await app.inject({ ...request, ...(logged ? { cookies: seed.cookies } : {}) });
      assert.equal(res.statusCode, status, res.body);
      assert.equal(res.headers['cache-control'], 'no-store');
      if (request.method !== 'HEAD') assert.match(res.headers['content-type'], /application\/json/);
    });
  }

  test('caminho codificado: o 404 da API é o mesmo JSON de /api/nao-existe', async () => {
    const plain = await app.inject({ method: 'GET', url: '/api/nao-existe' });
    const encodedRes = await app.inject({ method: 'GET', url: '/%61pi/nao-existe' });
    assert.equal(encodedRes.body, plain.body);
  });

  test('o corpo do 404 JSON não muda', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nao-existe' });
    assert.deepEqual(res.json(), { error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } });
  });

  test('fora de /api/: a mídia e a página mantêm o cache público', async () => {
    const logo = await app.inject({ method: 'GET', url: seed.business.logoUrl });
    assert.equal(logo.statusCode, 200);
    assert.equal(logo.headers['cache-control'], 'public, max-age=86400');
    const page = await app.inject({ method: 'GET', url: `/${seed.slug}` });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['cache-control'], 'public, max-age=60');
  });
});

test('429 do login também sai com no-store', async () => {
  const { app } = await buildTestApp({ rateLimit: { enabled: true, loginMax: 1 } });
  try {
    const login = () => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'abcd1234' } });
    assert.equal((await login()).statusCode, 401);
    const limited = await login();
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});
