import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';

test('com rate limit ativo e signupMax 2, a 3ª requisição dá 429 RATE_LIMITED', async () => {
  const { app } = await buildTestApp({ rateLimit: { enabled: true, signupMax: 2 } });
  try {
    const statuses = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Ana', email: `ana${i}@x.com`, password: 'abcd1234' },
      });
      statuses.push(last.statusCode);
    }
    assert.deepEqual(statuses, [201, 201, 429]);
    assert.equal(last.json().error.code, 'RATE_LIMITED');
    assert.equal(typeof last.json().error.message, 'string');

    // Rate limit é só no cadastro
    const me = await app.inject({ method: 'GET', url: '/api/me' });
    assert.equal(me.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('com rate limit ativo e loginMax 2, a 3ª requisição de login do mesmo IP dá 429 RATE_LIMITED', async () => {
  const { app } = await buildTestApp({ rateLimit: { enabled: true, loginMax: 2 } });
  try {
    const statuses = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `ana${i}@x.com`, password: 'abcd1234' },
      });
      statuses.push(last.statusCode);
    }
    assert.deepEqual(statuses, [401, 401, 429]);
    assert.equal(last.json().error.code, 'RATE_LIMITED');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-05 (critério 22): limite por usuário autenticado além do limite por IP.
// ---------------------------------------------------------------------------

const { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } = await import(
  '../helpers/session.js'
);
const { pngOf } = await import('../helpers/images.js');

function businessLimits({
  businessWrite,
  logoUpload,
  serviceWrite,
  professionalWrite,
  professionalPhoto,
  hoursWrite,
  timeBlockWrite,
  timeBlockRead,
  publicPage,
  publicAvailability,
  malformedUrl,
  publicMedia,
  publicBooking,
} = {}) {
  return {
    enabled: true,
    signupMax: 100,
    businessWrite: businessWrite || { perUser: 100, perIp: 100 },
    logoUpload: logoUpload || { perUser: 100, perIp: 100 },
    serviceWrite: serviceWrite || { perUser: 100, perIp: 100 },
    professionalWrite: professionalWrite || { perUser: 100, perIp: 100 },
    professionalPhoto: professionalPhoto || { perUser: 100, perIp: 100 },
    hoursWrite: hoursWrite || { perUser: 100, perIp: 100 },
    timeBlockWrite: timeBlockWrite || { perUser: 100, perIp: 100 },
    timeBlockRead: timeBlockRead || { perUser: 100, perIp: 100 },
    publicPage: publicPage || { perIp: 100 },
    publicAvailability: publicAvailability || { perIp: 100 },
    malformedUrl: malformedUrl || { perIp: 100 },
    publicMedia: publicMedia || { perIp: 100 },
    publicBooking: publicBooking || { perIp: 100 },
  };
}

function checkSlug(app, cookies, remoteAddress = '127.0.0.1') {
  return app.inject({ method: 'GET', url: '/api/business/slug-availability?slug=salao', cookies, remoteAddress });
}

test('businessWrite.perUser 2: a 3ª checagem do mesmo usuário dá 429, outro usuário do mesmo IP passa', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ businessWrite: { perUser: 2, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app, { email: 'ana@x.com' });
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await checkSlug(app, ana)).statusCode);
    assert.deepEqual(statuses, [200, 200, 429]);
    const last = await checkSlug(app, ana);
    assert.equal(last.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(last.headers['retry-after']) >= 1);
    assert.equal((await checkSlug(app, bia)).statusCode, 200);

    // Guards próprios por rota (AF-06, decisão 12): esgotar a checagem de slug não consome
    // o limite do POST do mesmo usuário.
    const post = await app.inject({
      method: 'POST',
      url: '/api/business',
      cookies: ana,
      payload: { name: 'Salão', address: 'Rua A', phone: '11912345678' },
    });
    assert.equal(post.statusCode, 201);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM businesses')).n, 1);
  } finally {
    await app.close();
  }
});

test('businessWrite.perIp 2: a 3ª checagem do mesmo IP com usuários diferentes dá 429', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ businessWrite: { perUser: 100, perIp: 2 } }) });
  try {
    const users = [];
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) users.push(await signupAndLogin(app, { email }));
    const statuses = [];
    for (const cookies of users) statuses.push((await checkSlug(app, cookies, '10.0.0.1')).statusCode);
    assert.deepEqual(statuses, [200, 200, 429]);
    // Outro IP não é afetado
    assert.equal((await checkSlug(app, users[0], '10.0.0.2')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('logoUpload.perUser 1: o 2º PUT dá 429 sem ler o corpo', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ logoUpload: { perUser: 1, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app);
    await app.inject({
      method: 'POST',
      url: '/api/business',
      cookies: ana,
      payload: { name: 'Salão', address: 'Rua A', phone: '11912345678' },
    });
    const put = (payload) =>
      app.inject({
        method: 'PUT',
        url: '/api/business/logo',
        cookies: ana,
        headers: { 'content-type': 'application/octet-stream' },
        payload,
      });
    assert.equal((await put(await pngOf(10, 10))).statusCode, 200);
    // Corpo acima de 2 MiB: se fosse lido daria 413; o limite responde antes.
    const second = await put(Buffer.alloc(3 * 1024 * 1024));
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, 'RATE_LIMITED');
  } finally {
    await app.close();
  }
});

test('sem sessão, as rotas do negócio respondem 401 e não consomem o limite do usuário', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ businessWrite: { perUser: 1, perIp: 100 } }) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await checkSlug(app, {})).statusCode, 401);
    const ana = await signupAndLogin(app);
    assert.equal((await checkSlug(app, ana)).statusCode, 200);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-06 (design seção 2 e critério 17): guards e contadores próprios por rota.
// ---------------------------------------------------------------------------

const BUSINESS = { name: 'Salão', address: 'Rua A', phone: '11912345678' };

test('businessWrite.perIp 2: esgotar a checagem de slug do IP não barra POST nem PATCH do mesmo IP', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ businessWrite: { perUser: 100, perIp: 2 } }) });
  try {
    const users = [];
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) users.push(await signupAndLogin(app, { email }));
    const statuses = [];
    for (const cookies of users) statuses.push((await checkSlug(app, cookies, '10.0.0.1')).statusCode);
    assert.deepEqual(statuses, [200, 200, 429]);

    const post = await app.inject({
      method: 'POST',
      url: '/api/business',
      cookies: users[0],
      payload: BUSINESS,
      remoteAddress: '10.0.0.1',
    });
    assert.equal(post.statusCode, 201);
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/business',
      cookies: users[0],
      payload: { name: 'Salão Novo' },
      remoteAddress: '10.0.0.1',
    });
    assert.equal(patch.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('logoUpload.perUser 1: um DELETE do logo não impede o PUT seguinte', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ logoUpload: { perUser: 1, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    const del = await app.inject({ method: 'DELETE', url: '/api/business/logo', cookies: ana });
    assert.equal(del.statusCode, 204);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/business/logo',
      cookies: ana,
      headers: { 'content-type': 'application/octet-stream' },
      payload: await pngOf(10, 10),
    });
    assert.equal(put.statusCode, 200);
    // O próprio DELETE continua limitado no seu contador.
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/business/logo', cookies: ana })).statusCode, 429);
  } finally {
    await app.close();
  }
});

function postService(app, cookies, name, remoteAddress = '127.0.0.1') {
  return app.inject({
    method: 'POST',
    url: '/api/services',
    cookies,
    payload: { name, durationMinutes: 30, price: '50' },
    remoteAddress,
  });
}

test('serviceWrite.perUser 2: o 3º POST dá 429, outro usuário passa, PATCH e deactivate do mesmo usuário passam', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ serviceWrite: { perUser: 2, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app, { email: 'ana@x.com' });
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    await createBusinessFor(app, ana);
    await createBusinessFor(app, bia, { name: 'Salão da Bia' });

    const statuses = [];
    const created = [];
    for (const name of ['A1', 'A2', 'A3']) {
      const res = await postService(app, ana, name);
      statuses.push(res.statusCode);
      if (res.statusCode === 201) created.push(res.json().service);
    }
    assert.deepEqual(statuses, [201, 201, 429]);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM services')).n, 2);
    assert.equal((await postService(app, bia, 'B1')).statusCode, 201);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/services/${created[0].id}`,
      cookies: ana,
      payload: { price: '60' },
    });
    assert.equal(patch.statusCode, 200);
    const deactivate = await app.inject({
      method: 'POST',
      url: `/api/services/${created[0].id}/deactivate`,
      cookies: ana,
    });
    assert.equal(deactivate.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('serviceWrite.perIp 2: o 3º POST do mesmo IP com usuários diferentes dá 429 e o PATCH do mesmo IP passa', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ serviceWrite: { perUser: 100, perIp: 2 } }) });
  try {
    const users = [];
    for (const [i, email] of ['a@x.com', 'b@x.com', 'c@x.com'].entries()) {
      const cookies = await signupAndLogin(app, { email });
      await createBusinessFor(app, cookies, { name: `Salão ${i + 1}` });
      users.push(cookies);
    }
    const responses = [];
    for (const cookies of users) responses.push(await postService(app, cookies, 'Corte', '10.0.0.1'));
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [201, 201, 429],
    );
    assert.equal(responses[2].json().error.code, 'RATE_LIMITED');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/services/${responses[0].json().service.id}`,
      cookies: users[0],
      payload: { name: 'Corte novo' },
      remoteAddress: '10.0.0.1',
    });
    assert.equal(patch.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('5 GET /api/services seguidos não consomem o limite do POST (critério 17)', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ serviceWrite: { perUser: 1, perIp: 1 } }) });
  try {
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.inject({ method: 'GET', url: '/api/services', cookies: ana })).statusCode, 200);
    }
    assert.equal((await postService(app, ana, 'Corte')).statusCode, 201);
    assert.equal((await postService(app, ana, 'Barba')).statusCode, 429);
  } finally {
    await app.close();
  }
});

test('sem sessão, POST /api/services responde 401 e não consome o limite do usuário', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ serviceWrite: { perUser: 1, perIp: 100 } }) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await postService(app, {}, 'Corte')).statusCode, 401);
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    const service = await createService(app, ana);
    assert.equal(service.name, 'Corte');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-07 (critério 26): guards próprios por rota para profissionais.
// ---------------------------------------------------------------------------

function postProfessional(app, cookies, name, remoteAddress = '127.0.0.1') {
  return app.inject({ method: 'POST', url: '/api/professionals', cookies, payload: { name }, remoteAddress });
}

function putProfessionalPhoto(app, cookies, id, payload) {
  return app.inject({
    method: 'PUT',
    url: `/api/professionals/${id}/photo`,
    cookies,
    headers: { 'content-type': 'application/octet-stream' },
    payload,
  });
}

test('professionalWrite.perUser 2: o 3º POST dá 429 e, logo depois, PATCH e DELETE do mesmo usuário passam', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ professionalWrite: { perUser: 2, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    const responses = [];
    for (const name of ['P1', 'P2', 'P3']) responses.push(await postProfessional(app, ana, name));
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [201, 201, 429],
    );
    assert.equal(responses[2].json().error.code, 'RATE_LIMITED');
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM professionals')).n, 2);
    const id = responses[0].json().professional.id;
    const patch = await app.inject({ method: 'PATCH', url: `/api/professionals/${id}`, cookies: ana, payload: { name: 'X' } });
    assert.equal(patch.statusCode, 200);
    const del = await app.inject({ method: 'DELETE', url: `/api/professionals/${id}`, cookies: ana });
    assert.equal(del.statusCode, 204);
  } finally {
    await app.close();
  }
});

test('5 GET /api/professionals não consomem o limite do POST (critério 26)', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ professionalWrite: { perUser: 1, perIp: 1 } }) });
  try {
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.inject({ method: 'GET', url: '/api/professionals', cookies: ana })).statusCode, 200);
    }
    assert.equal((await postProfessional(app, ana, 'Ana')).statusCode, 201);
    assert.equal((await postProfessional(app, ana, 'Bia')).statusCode, 429);
  } finally {
    await app.close();
  }
});

test('professionalPhoto.perUser 1: o upload não consome o limite de edição; 2º PUT dá 429 (critério 26)', async () => {
  const { app } = await buildTestApp({
    rateLimit: businessLimits({
      professionalWrite: { perUser: 2, perIp: 100 },
      professionalPhoto: { perUser: 1, perIp: 100 },
    }),
  });
  try {
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    const professional = await createProfessional(app, ana);
    assert.equal((await putProfessionalPhoto(app, ana, professional.id, await pngOf(10, 10))).statusCode, 200);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/professionals/${professional.id}`,
      cookies: ana,
      payload: { name: 'Ana Lima' },
    });
    assert.equal(patch.statusCode, 200);
    // Corpo acima de 2 MiB: se fosse lido daria 413; o limite responde antes.
    const second = await putProfessionalPhoto(app, ana, professional.id, Buffer.alloc(3 * 1024 * 1024));
    assert.equal(second.statusCode, 429);
    // DELETE da foto tem contador próprio.
    const delPhoto = await app.inject({ method: 'DELETE', url: `/api/professionals/${professional.id}/photo`, cookies: ana });
    assert.equal(delPhoto.statusCode, 204);
  } finally {
    await app.close();
  }
});

test('professionalWrite.perIp 2: o 3º POST do mesmo IP por usuários diferentes dá 429 e o PATCH passa', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ professionalWrite: { perUser: 100, perIp: 2 } }) });
  try {
    const users = [];
    for (const [i, email] of ['a@x.com', 'b@x.com', 'c@x.com'].entries()) {
      const cookies = await signupAndLogin(app, { email });
      await createBusinessFor(app, cookies, { name: `Salão ${i + 1}` });
      users.push(cookies);
    }
    const responses = [];
    for (const cookies of users) responses.push(await postProfessional(app, cookies, 'Ana', '10.0.0.1'));
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [201, 201, 429],
    );
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/professionals/${responses[0].json().professional.id}`,
      cookies: users[0],
      payload: { name: 'Ana Lima' },
      remoteAddress: '10.0.0.1',
    });
    assert.equal(patch.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('sem sessão, POST /api/professionals responde 401 e não consome o limite do usuário', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ professionalWrite: { perUser: 1, perIp: 100 } }) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await postProfessional(app, {}, 'Ana')).statusCode, 401);
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    assert.equal((await postProfessional(app, ana, 'Ana')).statusCode, 201);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-08 (critério 18): bucket próprio `hoursWrite`; a leitura da grade não tem limite.
// ---------------------------------------------------------------------------

const getHours = (app, cookies, id) => app.inject({ method: 'GET', url: `/api/professionals/${id}/hours`, cookies });

test('hoursWrite.perUser 2: o 3º PUT /hours dá 429 e o PATCH do profissional continua passando', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ hoursWrite: { perUser: 2, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    const professional = await createProfessional(app, ana);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await putHours(app, ana, professional.id, WEEK_9_TO_18)).statusCode);
    assert.deepEqual(statuses, [200, 200, 429]);
    const last = await putHours(app, ana, professional.id, WEEK_9_TO_18);
    assert.equal(last.json().error.code, 'RATE_LIMITED');
    // Rotas com contadores próprios.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/professionals/${professional.id}`,
      cookies: ana,
      payload: { name: 'Ana Lima' },
    });
    assert.equal(patch.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('5 GET /hours não consomem o limite do PUT (critério 18)', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ hoursWrite: { perUser: 1, perIp: 1 } }) });
  try {
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    const professional = await createProfessional(app, ana);
    for (let i = 0; i < 5; i++) assert.equal((await getHours(app, ana, professional.id)).statusCode, 200);
    assert.equal((await putHours(app, ana, professional.id, WEEK_9_TO_18)).statusCode, 200);
    assert.equal((await putHours(app, ana, professional.id, WEEK_9_TO_18)).statusCode, 429);
    assert.equal((await getHours(app, ana, professional.id)).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('hoursWrite.perIp 2: o 3º PUT do mesmo IP por usuários diferentes dá 429', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ hoursWrite: { perUser: 100, perIp: 2 } }) });
  try {
    const users = [];
    for (const [i, email] of ['a@x.com', 'b@x.com', 'c@x.com'].entries()) {
      const cookies = await signupAndLogin(app, { email });
      await createBusinessFor(app, cookies, { name: `Salão ${i + 1}` });
      users.push({ cookies, professional: await createProfessional(app, cookies) });
    }
    const statuses = [];
    for (const { cookies, professional } of users) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/professionals/${professional.id}/hours`,
        cookies,
        payload: { days: WEEK_9_TO_18 },
        remoteAddress: '10.0.0.1',
      });
      statuses.push(res.statusCode);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await app.close();
  }
});

test('sem sessão, PUT /hours responde 401 e não consome o limite do usuário', async () => {
  const { app } = await buildTestApp({ rateLimit: businessLimits({ hoursWrite: { perUser: 1, perIp: 100 } }) });
  try {
    const ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    const professional = await createProfessional(app, ana);
    for (let i = 0; i < 3; i++) assert.equal((await putHours(app, {}, professional.id, WEEK_9_TO_18)).statusCode, 401);
    assert.equal((await putHours(app, ana, professional.id, WEEK_9_TO_18)).statusCode, 200);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-09 (critérios 19 e 20): rotas públicas com limite por IP e guards próprios.
// ---------------------------------------------------------------------------

const { seedPublicBusiness } = await import('../helpers/public-fixture.js');
const { RATE_LIMITED_HTML, NOT_FOUND_HTML, PUBLIC_MESSAGE_CSP } = await import('../../src/modules/public-page/public-page.render.js');

const visit = (app, url, remoteAddress = '10.1.1.1', extra = {}) =>
  app.inject({ method: 'GET', url, remoteAddress, ...extra });

async function publicApp(limits) {
  const { app } = await buildTestApp({ rateLimit: businessLimits(limits) });
  const seed = await seedPublicBusiness(app, { services: 1, professionals: 1, logo: 'realistic' });
  return { app, seed };
}

function assertRateLimitedHtml(res) {
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(Number(res.headers['retry-after']) >= 1);
  assert.ok(res.rawPayload.equals(RATE_LIMITED_HTML));
  assert.match(res.body, /Muitos acessos em pouco tempo\. Aguarde um instante e recarregue a página\./);
  // AF-10 item 2 (AF-04): CSP sem script-src e sem connect-src.
  assert.equal(res.headers['content-security-policy'], PUBLIC_MESSAGE_CSP);
}

test('publicPage.perIp 2: o 3º GET /<slug> do mesmo IP dá 429 HTML com Retry-After; outro IP passa', async () => {
  const { app, seed } = await publicApp({ publicPage: { perIp: 2 } });
  try {
    const statuses = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await visit(app, `/${seed.slug}`);
      statuses.push(last.statusCode);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    assertRateLimitedHtml(last);
    assert.equal((await visit(app, `/${seed.slug}`, '10.1.1.2')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('404 também consome o limite: 2 slugs inexistentes e o 3º GET do slug válido dão 429 (critério 20)', async () => {
  const { app, seed } = await publicApp({ publicPage: { perIp: 2 } });
  try {
    assert.equal((await visit(app, '/nao-existe-1')).statusCode, 404);
    assert.equal((await visit(app, '/nao-existe-2')).statusCode, 404);
    assertRateLimitedHtml(await visit(app, `/${seed.slug}`));
  } finally {
    await app.close();
  }
});

test('/:slug no limite não barra /media (contador próprio por rota de mídia)', async () => {
  const { app, seed } = await publicApp({ publicPage: { perIp: 2 } });
  try {
    for (let i = 0; i < 3; i++) await visit(app, `/${seed.slug}`);
    assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 429);
    assert.equal((await visit(app, seed.business.logoUrl)).statusCode, 200);
    assert.equal((await visit(app, seed.professionals[0].photoUrl)).statusCode, 200);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-10 (critério 25) e AF-09 itens 2 e 3: um contador por IP compartilhado entre /:slug, /:slug/,
// o 404 HTML de fallback e o endpoint de horários, mais o teto de custo `publicAvailability`.
// ---------------------------------------------------------------------------

const { getAvailability } = await import('../helpers/session.js');

function availabilityQuery(seed) {
  return { serviceId: seed.services[0].id, professionalId: 'any', from: '2026-11-27' };
}

async function availabilityApp(limits) {
  const clock = createClockForAvailability();
  const { app } = await buildTestApp({ now: clock.now, rateLimit: businessLimits(limits) });
  const seed = await seedPublicBusiness(app, { services: 1, professionals: 1, logo: null, photos: false });
  return { app, seed };
}

function createClockForAvailability() {
  const at = Date.parse('2026-11-26T12:00:00.000Z');
  return { now: () => new Date(at) };
}

function assertRateLimitedJson(res) {
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error.code, 'RATE_LIMITED');
  assert.ok(Number(res.headers['retry-after']) >= 1);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
  assert.ok(res.headers['x-frame-options']);
  assert.equal(res.headers['set-cookie'], undefined);
}

for (const [label, last] of [
  ['GET /<slug>', (app, seed) => visit(app, `/${seed.slug}`)],
  ['GET /<slug>/', (app, seed) => visit(app, `/${seed.slug}/`)],
  ['GET /api/public/<slug>/availability', (app, seed) => getAvailability(app, seed.slug, availabilityQuery(seed), { remoteAddress: '10.1.1.1' })],
  ['404 HTML de fallback', (app) => visit(app, `/${'a'.repeat(101)}`)],
]) {
  test(`publicPage.perIp 3 compartilhado: página, barra final e horários consomem o mesmo contador; a 4ª (${label}) dá 429`, async () => {
    const { app, seed } = await availabilityApp({ publicPage: { perIp: 3 } });
    try {
      assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);
      assert.equal((await visit(app, `/${seed.slug}/`)).statusCode, 301);
      const ok = await getAvailability(app, seed.slug, availabilityQuery(seed), { remoteAddress: '10.1.1.1' });
      assert.equal(ok.statusCode, 200, ok.body);
      const res = await last(app, seed);
      if (label.startsWith('GET /api')) assertRateLimitedJson(res);
      else assertRateLimitedHtml(res);
      // Outro IP passa em todas.
      assert.equal((await visit(app, `/${seed.slug}`, '10.1.1.2')).statusCode, 200);
      assert.equal(
        (await getAvailability(app, seed.slug, availabilityQuery(seed), { remoteAddress: '10.1.1.2' })).statusCode,
        200,
      );
    } finally {
      await app.close();
    }
  });
}

test('404 HTML conta no contador compartilhado e /api/* não (AF-09 item 2)', async () => {
  const { app, seed } = await availabilityApp({ publicPage: { perIp: 3 } });
  try {
    for (let i = 0; i < 10; i++) {
      const res = await visit(app, '/api/nao-existe');
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error.code, 'NOT_FOUND');
    }
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.inject({ method: 'POST', url: '/nao-existe', remoteAddress: '10.1.1.1', payload: {} })).statusCode, 404);
      assert.equal((await visit(app, '/media/logos/00000000-0000-4000-8000-000000000000.png')).statusCode, 404);
      assert.equal((await visit(app, '/shared/nao-existe.js')).statusCode, 404);
    }
    assert.equal((await visit(app, '/nao-existe-1')).statusCode, 404);
    assert.equal((await visit(app, `/${'b'.repeat(101)}`)).statusCode, 404);
    assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);
    assertRateLimitedHtml(await visit(app, '/nao-existe-2'));
  } finally {
    await app.close();
  }
});

test('publicAvailability.perIp 2: a 3ª consulta dá 429 JSON e a página continua 200 (teto de custo)', async () => {
  const { app, seed } = await availabilityApp({ publicPage: { perIp: 100 }, publicAvailability: { perIp: 2 } });
  try {
    const query = availabilityQuery(seed);
    const first = await getAvailability(app, seed.slug, query, { remoteAddress: '10.1.1.1' });
    assert.equal(first.statusCode, 200);
    // O teto não sobrescreve os cabeçalhos do contador compartilhado.
    assert.equal(first.headers['x-ratelimit-limit'], '100');
    assert.equal(first.headers['x-ratelimit-remaining'], '99');
    assert.equal((await getAvailability(app, seed.slug, query, { remoteAddress: '10.1.1.1' })).statusCode, 200);
    assertRateLimitedJson(await getAvailability(app, seed.slug, query, { remoteAddress: '10.1.1.1' }));
    assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);
    assert.equal((await getAvailability(app, seed.slug, query, { remoteAddress: '10.1.1.2' })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('consulta inválida (400 e 404) também consome os dois contadores', async () => {
  const { app, seed } = await availabilityApp({ publicPage: { perIp: 100 }, publicAvailability: { perIp: 2 } });
  try {
    assert.equal((await getAvailability(app, seed.slug, {}, { remoteAddress: '10.1.1.1' })).statusCode, 400);
    assert.equal((await getAvailability(app, 'nao-existe', availabilityQuery(seed), { remoteAddress: '10.1.1.1' })).statusCode, 404);
    assertRateLimitedJson(await getAvailability(app, seed.slug, availabilityQuery(seed), { remoteAddress: '10.1.1.1' }));
  } finally {
    await app.close();
  }
});

test('URL malformada (AF-09 item 1): JSON 400 com contador malformedUrl; 404 HTML no contador compartilhado', async () => {
  const { app, seed } = await availabilityApp({ publicPage: { perIp: 3 }, malformedUrl: { perIp: 2 } });
  try {
    const bad = (url, remoteAddress = '10.1.1.1') => app.inject({ method: 'GET', url, remoteAddress });
    assert.equal((await bad('/api/%E0%A4%A')).statusCode, 400);
    assert.equal((await bad('/api/public/%E0%A4%A/availability')).statusCode, 400);
    const limited = await bad('/api/%E0%A4%A');
    assertRateLimitedJson(limited);
    assert.equal(limited.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
    assert.ok(limited.headers['strict-transport-security']);
    assert.ok(limited.headers['cross-origin-resource-policy']);
    assert.equal((await bad('/api/%E0%A4%A', '10.1.1.2')).statusCode, 400);
    // O JSON malformado não consome o contador compartilhado da página.
    assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);

    // O 404 HTML de URL malformada conta junto com a página (é o 404 de fallback).
    assert.equal((await bad('/%E0%A4%A')).statusCode, 404);
    assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);
    const html = await bad('/%E0%A4%A');
    assertRateLimitedHtml(html);
    assert.ok(html.headers['strict-transport-security']);
  } finally {
    await app.close();
  }
});

test('IPv6: o mesmo /64 divide o contador compartilhado entre página e horários', async () => {
  const { app, seed } = await availabilityApp({ publicPage: { perIp: 2 } });
  try {
    assert.equal((await visit(app, `/${seed.slug}`, '2001:db8::1')).statusCode, 200);
    assert.equal((await getAvailability(app, seed.slug, availabilityQuery(seed), { remoteAddress: '2001:db8::2' })).statusCode, 200);
    assertRateLimitedJson(await getAvailability(app, seed.slug, availabilityQuery(seed), { remoteAddress: '2001:db8::ffff:3' }));
    assert.equal((await visit(app, `/${seed.slug}`, '2001:db8:0:1::1')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('publicMedia.perIp 1: o 2º logo dá 429 JSON com Retry-After; a foto e a página ainda passam', async () => {
  const { app, seed } = await publicApp({ publicMedia: { perIp: 1 } });
  try {
    assert.equal((await visit(app, seed.business.logoUrl)).statusCode, 200);
    const second = await visit(app, seed.business.logoUrl);
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(second.headers['retry-after']) >= 1);
    assert.equal((await visit(app, seed.professionals[0].photoUrl)).statusCode, 200);
    assert.equal((await visit(app, seed.professionals[0].photoUrl)).statusCode, 429);
    assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);
    assert.equal((await visit(app, seed.business.logoUrl, '10.1.1.2')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('IPv6: o mesmo /64 divide o contador e outro /64 não (AF-02 item 1)', async () => {
  const { app, seed } = await publicApp({ publicPage: { perIp: 2 } });
  try {
    assert.equal((await visit(app, `/${seed.slug}`, '2001:db8::1')).statusCode, 200);
    assert.equal((await visit(app, `/${seed.slug}`, '2001:db8::2')).statusCode, 200);
    assert.equal((await visit(app, `/${seed.slug}`, '2001:db8::ffff:3')).statusCode, 429);
    assert.equal((await visit(app, `/${seed.slug}`, '2001:db8:0:1::1')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('com cookie, a página não consome limite de usuário nem resolve a sessão', async () => {
  const { app, seed } = await publicApp({ businessWrite: { perUser: 1, perIp: 100 } });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await visit(app, `/${seed.slug}`, '127.0.0.1', { cookies: seed.cookies });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['set-cookie'], undefined);
    }
    assert.equal((await checkSlug(app, seed.cookies)).statusCode, 200);
    assert.equal((await checkSlug(app, seed.cookies)).statusCode, 429);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-16 (critério 22): buckets próprios `timeBlockWrite` (POST e DELETE, contadores separados)
// e `timeBlockRead` (listagem com limite por usuário).
// ---------------------------------------------------------------------------

const { postTimeBlock, listTimeBlocks, deleteTimeBlock } = await import('../helpers/session.js');
const { createClock } = await import('../helpers/clock.js');

const TIME_BLOCK = Object.freeze({ professionalId: null, start: '2026-12-24T14:00', end: '2026-12-24T18:00' });

async function timeBlockApp(limits) {
  const clock = createClock('2026-12-01T12:00:00.000Z');
  const { app } = await buildTestApp({ now: clock.now, rateLimit: businessLimits(limits) });
  const ana = await signupAndLogin(app);
  await createBusinessFor(app, ana);
  return { app, ana };
}

test('timeBlockWrite.perUser 2: o 3º POST /api/time-blocks dá 429', async () => {
  const { app, ana } = await timeBlockApp({ timeBlockWrite: { perUser: 2, perIp: 100 } });
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await postTimeBlock(app, ana, TIME_BLOCK)).statusCode);
    assert.deepEqual(statuses, [201, 201, 429]);
    const last = await postTimeBlock(app, ana, TIME_BLOCK);
    assert.equal(last.json().error.code, 'RATE_LIMITED');
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM time_blocks')).n), 2);
  } finally {
    await app.close();
  }
});

test('5 GET /api/time-blocks não consomem o limite do POST (critério 22)', async () => {
  const { app, ana } = await timeBlockApp({ timeBlockWrite: { perUser: 1, perIp: 1 } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await listTimeBlocks(app, ana)).statusCode, 200);
    assert.equal((await postTimeBlock(app, ana, TIME_BLOCK)).statusCode, 201);
    assert.equal((await postTimeBlock(app, ana, TIME_BLOCK)).statusCode, 429);
  } finally {
    await app.close();
  }
});

test('timeBlockRead.perUser 2: o 3º GET dá 429 e o POST seguinte passa', async () => {
  const { app, ana } = await timeBlockApp({ timeBlockRead: { perUser: 2, perIp: 100 } });
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await listTimeBlocks(app, ana)).statusCode);
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.equal((await listTimeBlocks(app, ana)).json().error.code, 'RATE_LIMITED');
    assert.equal((await postTimeBlock(app, ana, TIME_BLOCK)).statusCode, 201);
  } finally {
    await app.close();
  }
});

test('POST no limite não impede o DELETE (contadores próprios por rota)', async () => {
  const { app, ana } = await timeBlockApp({ timeBlockWrite: { perUser: 1, perIp: 100 } });
  try {
    const created = await postTimeBlock(app, ana, TIME_BLOCK);
    assert.equal(created.statusCode, 201);
    assert.equal((await postTimeBlock(app, ana, TIME_BLOCK)).statusCode, 429);
    assert.equal((await deleteTimeBlock(app, ana, created.json().timeBlock.id)).statusCode, 204);
    assert.equal((await deleteTimeBlock(app, ana, created.json().timeBlock.id)).statusCode, 429);
  } finally {
    await app.close();
  }
});

test('timeBlockWrite.perIp 2: o 3º POST do mesmo IP por usuários diferentes dá 429', async () => {
  const clock = createClock('2026-12-01T12:00:00.000Z');
  const { app } = await buildTestApp({ now: clock.now, rateLimit: businessLimits({ timeBlockWrite: { perUser: 100, perIp: 2 } }) });
  try {
    const statuses = [];
    for (const [i, email] of ['a@x.com', 'b@x.com', 'c@x.com'].entries()) {
      const cookies = await signupAndLogin(app, { email });
      await createBusinessFor(app, cookies, { name: `Salão ${i + 1}` });
      statuses.push((await postTimeBlock(app, cookies, TIME_BLOCK, { remoteAddress: '10.0.0.1' })).statusCode);
    }
    assert.deepEqual(statuses, [201, 201, 429]);
  } finally {
    await app.close();
  }
});

test('sem sessão, GET e POST de bloqueios dão 401 e não consomem o limite do usuário', async () => {
  const { app, ana } = await timeBlockApp({
    timeBlockWrite: { perUser: 1, perIp: 100 },
    timeBlockRead: { perUser: 1, perIp: 100 },
  });
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await postTimeBlock(app, {}, TIME_BLOCK)).statusCode, 401);
      assert.equal((await listTimeBlocks(app, {})).statusCode, 401);
    }
    assert.equal((await postTimeBlock(app, ana, TIME_BLOCK)).statusCode, 201);
    assert.equal((await listTimeBlocks(app, ana)).statusCode, 200);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-04 (decisão 3, critério 17): nenhuma rota nova de cliente para contar.
// ---------------------------------------------------------------------------

test('AF-04: nenhuma rota registrada contém "customers" (sem gravação pública isolada)', async () => {
  const { app } = await buildTestApp();
  try {
    const routes = app.printRoutes({ commonPrefix: false });
    assert.ok(routes.includes('availability'), 'printRoutes sem as rotas conhecidas');
    assert.doesNotMatch(routes, /customer/i);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AF-11 (critério 41): teto publicBooking e contador compartilhado publicPage no POST público.
// ---------------------------------------------------------------------------

const { bookingBody, postAppointment } = await import('../helpers/appointments.js');

function bookingRequest(app, seed, i, remoteAddress = '10.1.1.1') {
  return postAppointment(
    app,
    seed.slug,
    bookingBody({
      serviceId: seed.services[0].id,
      professionalId: seed.professionals[0].id,
      start: `2026-11-27T${['09:00', '10:00', '11:00', '13:00', '14:00', '15:00'][i]}`,
      customer: { phone: `(11) 9765${i}-321${i}` },
    }),
    { remoteAddress },
  );
}

test('publicBooking.perIp 2: o 3º POST dá 429 com retry-after e no-store; horários e página continuam 200; outro IP passa', async () => {
  const { app, seed } = await availabilityApp({ publicPage: { perIp: 100 }, publicBooking: { perIp: 2 } });
  try {
    assert.equal((await bookingRequest(app, seed, 0)).statusCode, 201);
    assert.equal((await bookingRequest(app, seed, 1)).statusCode, 201);
    assertRateLimitedJson(await bookingRequest(app, seed, 2));
    assert.equal((await getAvailability(app, seed.slug, availabilityQuery(seed), { remoteAddress: '10.1.1.1' })).statusCode, 200);
    assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);
    assert.equal((await bookingRequest(app, seed, 3, '10.1.1.2')).statusCode, 201);
  } finally {
    await app.close();
  }
});

test('contador compartilhado: com publicPage.perIp 3, 2 páginas e 1 POST esgotam o contador e o 4º (qualquer rota) dá 429', async () => {
  for (const fourth of ['page', 'post']) {
    const { app, seed } = await availabilityApp({ publicPage: { perIp: 3 }, publicBooking: { perIp: 100 } });
    try {
      assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);
      assert.equal((await visit(app, `/${seed.slug}`)).statusCode, 200);
      const first = await bookingRequest(app, seed, 0);
      assert.equal(first.statusCode, 201, first.body);
      // O teto não sobrescreve os cabeçalhos do contador compartilhado (o POST conta uma vez).
      assert.equal(first.headers['x-ratelimit-limit'], '3');
      assert.equal(first.headers['x-ratelimit-remaining'], '0');
      if (fourth === 'page') assertRateLimitedHtml(await visit(app, `/${seed.slug}`));
      else assertRateLimitedJson(await bookingRequest(app, seed, 1));
      assert.equal((await bookingRequest(app, seed, 2, '10.1.1.2')).statusCode, 201);
    } finally {
      await app.close();
    }
  }
});
