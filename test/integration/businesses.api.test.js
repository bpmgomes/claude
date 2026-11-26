import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { signupAndLogin, TEST_PASSWORD } from '../helpers/session.js';

const VALID = { name: 'Salão da Ana', address: 'Rua A, 10 - Centro, São Paulo/SP', phone: '(11) 91234-5678' };
const ADDRESS_SECRET = 'Rua Secreta do Log, 987';
const PHONE_SECRET = '(21) 98765-4321';

let app;
let logs;
let ana;

beforeEach(async () => {
  ({ app, logs } = await buildTestApp());
  ana = await signupAndLogin(app, { email: 'ana@x.com' });
});

afterEach(async () => {
  await app.close();
});

function api(method, url, cookies, payload, headers = {}) {
  return app.inject({ method, url, cookies, payload, headers });
}

const create = (cookies, payload = VALID) => api('POST', '/api/business', cookies, payload);
const patch = (cookies, payload) => api('PATCH', '/api/business', cookies, payload);
const get = (cookies) => api('GET', '/api/business', cookies);
const availability = (cookies, slug) =>
  api('GET', `/api/business/slug-availability?slug=${encodeURIComponent(slug)}`, cookies);

async function count() {
  return (await app.db.get('SELECT COUNT(*) AS n FROM businesses')).n;
}

describe('criação (critérios 1, 4, 9, 15, 20)', () => {
  test('201 com business, redirectTo /servicos e linha vinculada ao dono', async () => {
    const res = await create(ana, { ...VALID, slug: 'salao-da-ana' });
    assert.equal(res.statusCode, 201);
    const { business, redirectTo } = res.json();
    assert.equal(redirectTo, '/servicos');
    assert.equal(business.name, 'Salão da Ana');
    assert.equal(business.slug, 'salao-da-ana');
    assert.equal(business.phone, '11912345678');
    assert.equal(business.timezone, 'America/Sao_Paulo');
    assert.equal(business.publicUrl, 'https://agendafacil.app/salao-da-ana');
    assert.equal(business.logoUrl, null);
    assert.equal('ownerId' in business, false);
    assert.equal('logoKey' in business, false);

    const me = (await api('GET', '/api/me', ana)).json().user;
    const row = await app.db.get('SELECT owner_id, phone FROM businesses WHERE id = ?', [business.id]);
    assert.equal(row.owner_id, me.id);
    assert.equal(row.phone, '11912345678');

    const read = await get(ana);
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), { business });
  });

  test('sem slug no corpo, gera salao-da-ana a partir do nome', async () => {
    const res = await create(ana);
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().business.slug, 'salao-da-ana');
  });

  test('campos extras (ownerId de outro, timezone, logoKey, id) são ignorados', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const biaId = (await api('GET', '/api/me', bia)).json().user.id;
    const res = await create(ana, {
      ...VALID,
      ownerId: biaId,
      owner_id: biaId,
      timezone: 'UTC',
      logoKey: '../x',
      logo_key: '../x',
      id: 'fixo',
    });
    assert.equal(res.statusCode, 201);
    const row = await app.db.get('SELECT * FROM businesses');
    assert.notEqual(row.owner_id, biaId);
    assert.equal(row.timezone, 'America/Sao_Paulo');
    assert.equal(row.logo_key, null);
    assert.notEqual(row.id, 'fixo');
    assert.equal((await get(bia)).statusCode, 404);
  });

  test('nome que gera slug curto ("Zé") sem slug no corpo -> 400 em fields.slug', async () => {
    const res = await create(ana, { ...VALID, name: 'Zé' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(Object.keys(res.json().error.fields), ['slug']);
    assert.equal(await count(), 0);
  });
});

describe('401 sem sessão (critério 2)', () => {
  for (const [method, url] of [
    ['GET', '/api/business'],
    ['POST', '/api/business'],
    ['PATCH', '/api/business'],
    ['GET', '/api/business/slug-availability?slug=abc'],
    ['PUT', '/api/business/logo'],
    ['DELETE', '/api/business/logo'],
  ]) {
    test(`${method} ${url}`, async () => {
      const res = await app.inject({ method, url, payload: method === 'POST' || method === 'PATCH' ? VALID : undefined });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'UNAUTHENTICATED');
      assert.equal(await count(), 0);
    });
  }

  test('cookie inválido também dá 401', async () => {
    const res = await create({ af_session: 'x'.repeat(43) });
    assert.equal(res.statusCode, 401);
    assert.equal(await count(), 0);
  });
});

describe('validação (critérios 3, 4, 5)', () => {
  test('corpo vazio -> 400 com name, address e phone de uma vez', async () => {
    const res = await create(ana, {});
    assert.equal(res.statusCode, 400);
    const { error } = res.json();
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.deepEqual(Object.keys(error.fields).sort(), ['address', 'name', 'phone']);
    assert.equal(error.fields.name, 'Informe o nome do negócio.');
    assert.equal(error.fields.address, 'Informe o endereço.');
    assert.equal(error.fields.phone, 'Informe o telefone.');
  });

  test('telefone sem DDD (1234-5678) -> 400 phone', async () => {
    const res = await create(ana, { ...VALID, phone: '1234-5678' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json().error.fields, { phone: 'Informe um telefone com DDD, ex.: (11) 91234-5678.' });
  });

  test('nome com 101 caracteres e endereço com 201 -> 400', async () => {
    const res = await create(ana, { ...VALID, name: 'a'.repeat(101), address: 'b'.repeat(201) });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(Object.keys(res.json().error.fields).sort(), ['address', 'name']);
  });

  test('U+202E no nome e no endereço -> 400', async () => {
    const res = await create(ana, { ...VALID, name: 'Salão‮ana', address: 'Rua‮A' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json().error.fields, {
      name: 'O nome contém caracteres inválidos.',
      address: 'O endereço contém caracteres inválidos.',
    });
    assert.equal(await count(), 0);
  });

  test('JSON malformado e content-type text/plain não criam nada', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/business',
      cookies: ana,
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    assert.equal(bad.statusCode, 400);
    const text = await app.inject({
      method: 'POST',
      url: '/api/business',
      cookies: ana,
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify(VALID),
    });
    assert.equal(text.statusCode, 415);
    assert.equal(await count(), 0);
  });
});

describe('injeção e XSS (critério 5)', () => {
  test('texto gravado e devolvido literalmente, tabela intacta', async () => {
    const name = "x'); DROP TABLE businesses;--";
    const address = '<img src=x onerror=alert(1)>';
    const res = await create(ana, { ...VALID, name, address, slug: 'salao-x' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().business.name, name);
    assert.equal(res.json().business.address, address);
    assert.equal(await count(), 1);
    const read = (await get(ana)).json().business;
    assert.equal(read.name, name);
    assert.equal(read.address, address);
  });
});

describe('um negócio por dono (critério 6)', () => {
  test('segundo POST -> 409 BUSINESS_ALREADY_EXISTS', async () => {
    assert.equal((await create(ana)).statusCode, 201);
    const res = await create(ana, { ...VALID, slug: 'outro-slug' });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), {
      error: { code: 'BUSINESS_ALREADY_EXISTS', message: 'Você já cadastrou seu negócio.' },
    });
    assert.equal(await count(), 1);
  });

  test('dois POST simultâneos do mesmo dono -> um 201, um 409, nenhum 500', async () => {
    const results = await Promise.all([create(ana), create(ana, { ...VALID, slug: 'outro-slug' })]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal(results.find((r) => r.statusCode === 409).json().error.code, 'BUSINESS_ALREADY_EXISTS');
    assert.equal(await count(), 1);
  });

  test('dois POST simultâneos do mesmo dono com o mesmo slug -> 201 e 409 BUSINESS_ALREADY_EXISTS', async () => {
    const results = await Promise.all([create(ana), create(ana)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal(results.find((r) => r.statusCode === 409).json().error.code, 'BUSINESS_ALREADY_EXISTS');
    assert.equal(await count(), 1);
  });
});

describe('slug (critérios 16, 17, 18, 19)', () => {
  let bia;
  let caio;

  beforeEach(async () => {
    bia = await signupAndLogin(app, { email: 'bia@x.com' });
    caio = await signupAndLogin(app, { email: 'caio@x.com' });
  });

  test('reservado (admin) -> 400 em fields.slug, sem sugestão', async () => {
    const res = await create(ana, { ...VALID, slug: 'admin' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json().error.fields, { slug: 'Este link é reservado. Escolha outro.' });
    assert.equal('suggestion' in res.json().error, false);
  });

  test('inválido (salão, a--b) -> 400 fields.slug', async () => {
    for (const slug of ['salão', 'a--b', 'ab']) {
      const res = await create(ana, { ...VALID, slug });
      assert.equal(res.statusCode, 400, slug);
      assert.ok(res.json().error.fields.slug, slug);
    }
  });

  test('slug existente -> 409 SLUG_TAKEN com sugestão -2 livre; depois -3', async () => {
    assert.equal((await create(ana)).statusCode, 201);
    const res = await create(bia);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), {
      error: {
        code: 'SLUG_TAKEN',
        message: 'Este link já está em uso.',
        fields: { slug: 'Este link já está em uso.' },
        suggestion: 'salao-da-ana-2',
      },
    });
    const taken = await app.db.get('SELECT COUNT(*) AS n FROM businesses WHERE slug = ?', ['salao-da-ana-2']);
    assert.equal(taken.n, 0, 'a sugestão não existe no banco no momento da resposta');

    assert.equal((await create(bia, { ...VALID, slug: 'salao-da-ana-2' })).statusCode, 201);
    const third = await create(caio);
    assert.equal(third.statusCode, 409);
    assert.equal(third.json().error.suggestion, 'salao-da-ana-3');
  });

  test('sem diferença de maiúsculas: Salao-Da-Ana depois de salao-da-ana -> 409', async () => {
    assert.equal((await create(ana, { ...VALID, slug: 'salao-da-ana' })).statusCode, 201);
    const res = await create(bia, { ...VALID, slug: 'Salao-Da-Ana' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'SLUG_TAKEN');
  });

  test('dois donos simultâneos com o mesmo slug -> um 201, um 409, nenhum 500', async () => {
    const results = await Promise.all([create(ana), create(bia)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    const conflict = results.find((r) => r.statusCode === 409).json().error;
    assert.equal(conflict.code, 'SLUG_TAKEN');
    assert.equal(conflict.suggestion, 'salao-da-ana-2');
    assert.equal(await count(), 1);
  });

  test('com -2 a -20 ocupados, sugere um sufixo aleatório livre', async () => {
    assert.equal((await create(ana)).statusCode, 201);
    for (let n = 2; n <= 20; n++) {
      await app.db.run(
        `INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES (?, 'X', ?, 'h', 'x', 'x')`,
        [`u${n}`, `u${n}@x.com`],
      );
      await app.db.run(
        `INSERT INTO businesses (id, owner_id, name, slug, address, phone, created_at, updated_at)
         VALUES (?, ?, 'S', ?, 'R', '11912345678', 'x', 'x')`,
        [`b${n}`, `u${n}`, `salao-da-ana-${n}`],
      );
    }
    const res = await create(bia);
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error.suggestion, /^salao-da-ana-\d{4}$/);
  });
});

describe('isolamento entre donos (critério 7)', () => {
  test('B não lê nem altera o negócio de A', async () => {
    const a = (await create(ana)).json().business;
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });

    const read = await get(bia);
    assert.equal(read.statusCode, 404);
    assert.deepEqual(read.json(), {
      error: { code: 'BUSINESS_NOT_FOUND', message: 'Você ainda não cadastrou seu negócio.' },
    });

    const edit = await patch(bia, { name: 'Invadido', id: a.id });
    assert.equal(edit.statusCode, 404);
    const logo = await api('DELETE', '/api/business/logo', bia);
    assert.equal(logo.statusCode, 404);

    const after = (await get(ana)).json().business;
    assert.equal(after.name, 'Salão da Ana');
    for (const res of [read, edit, logo]) {
      assert.equal(res.body.includes(a.id), false);
      assert.equal(res.body.includes('Salão da Ana'), false);
    }
  });
});

describe('edição (critérios 8, 21)', () => {
  beforeEach(async () => {
    assert.equal((await create(ana)).statusCode, 201);
  });

  test('PATCH de nome, endereço e telefone', async () => {
    const res = await patch(ana, { name: 'Ana Beleza', address: 'Rua B, 20', phone: '(11) 3123-4567' });
    assert.equal(res.statusCode, 200);
    const { business } = res.json();
    assert.equal(business.name, 'Ana Beleza');
    assert.equal(business.address, 'Rua B, 20');
    assert.equal(business.phone, '1131234567');
    assert.equal(business.slug, 'salao-da-ana');
    assert.deepEqual((await get(ana)).json().business, business);
  });

  test('PATCH só com um campo altera só ele', async () => {
    const res = await patch(ana, { phone: '11987654321' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().business.name, 'Salão da Ana');
    assert.equal(res.json().business.phone, '11987654321');
  });

  test('PATCH {} -> 400 "Nada para atualizar."', async () => {
    const res = await patch(ana, {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.message, 'Nada para atualizar.');
    const extras = await patch(ana, { timezone: 'UTC', ownerId: 'x' });
    assert.equal(extras.statusCode, 400);
  });

  test('PATCH com null ou "" em campo obrigatório -> 400', async () => {
    const res = await patch(ana, { name: null, phone: '' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(Object.keys(res.json().error.fields).sort(), ['name', 'phone']);
  });

  test('troca de slug: o antigo fica em quarentena para outros donos e livre para o próprio (AF-09, 24)', async () => {
    const res = await patch(ana, { slug: 'ana-beleza' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().business.slug, 'ana-beleza');
    assert.equal(res.json().business.publicUrl, 'https://agendafacil.app/ana-beleza');

    const check = await availability(ana, 'salao-da-ana');
    assert.deepEqual(check.json(), { slug: 'salao-da-ana', available: true });

    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const other = await create(bia, { ...VALID, slug: 'salao-da-ana' });
    assert.equal(other.statusCode, 409);
    assert.equal(other.json().error.code, 'SLUG_TAKEN');
    assert.equal(other.json().error.suggestion, 'salao-da-ana-2');

    const back = await patch(ana, { slug: 'salao-da-ana' });
    assert.equal(back.statusCode, 200);
    assert.equal(back.json().business.slug, 'salao-da-ana');
  });

  test('o próprio slug atual no PATCH -> 200', async () => {
    const res = await patch(ana, { slug: 'Salao-Da-Ana' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().business.slug, 'salao-da-ana');
  });

  test('PATCH sem negócio -> 404', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const res = await patch(bia, { name: 'X' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'BUSINESS_NOT_FOUND');
  });
});

describe('checagem de disponibilidade (critérios 16, 18, 19)', () => {
  test('livre, ocupado com sugestão, reservado, inválido e próprio slug', async () => {
    const free = await availability(ana, 'Salao-Da-Ana');
    assert.equal(free.statusCode, 200);
    assert.deepEqual(free.json(), { slug: 'salao-da-ana', available: true });

    assert.equal((await create(ana)).statusCode, 201);
    assert.deepEqual((await availability(ana, 'salao-da-ana')).json(), { slug: 'salao-da-ana', available: true });

    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    assert.deepEqual((await availability(bia, 'salao-da-ana')).json(), {
      slug: 'salao-da-ana',
      available: false,
      reason: 'TAKEN',
      message: 'Este link já está em uso.',
      suggestion: 'salao-da-ana-2',
    });

    assert.deepEqual((await availability(bia, 'admin')).json(), {
      slug: 'admin',
      available: false,
      reason: 'RESERVED',
      message: 'Este link é reservado. Escolha outro.',
    });

    const invalid = (await availability(bia, 'salão')).json();
    assert.equal(invalid.available, false);
    assert.equal(invalid.reason, 'INVALID');
    assert.equal('suggestion' in invalid, false);
    // AF-05 item 6: INVALID não ecoa a entrada.
    assert.equal('slug' in invalid, false);
    assert.equal(typeof invalid.message, 'string');

    const huge = await availability(bia, 'a'.repeat(10_000));
    assert.equal(huge.statusCode, 200);
    assert.deepEqual(Object.keys(huge.json()).sort(), ['available', 'message', 'reason']);
    assert.equal(huge.json().reason, 'INVALID');
    assert.ok(Buffer.byteLength(huge.body) < 300, `corpo com ${huge.body.length} bytes`);

    const missing = await api('GET', '/api/business/slug-availability', bia);
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.json().reason, 'INVALID');
  });
});

describe('CSRF (critério 24)', () => {
  const evil = { origin: 'https://evil.example' };

  test('POST, PATCH, PUT e DELETE com Origin de outro site -> 403 e nada gravado', async () => {
    const post = await api('POST', '/api/business', ana, VALID, evil);
    assert.equal(post.statusCode, 403);
    assert.equal(post.json().error.code, 'FORBIDDEN_ORIGIN');
    assert.equal(await count(), 0);

    assert.equal((await create(ana)).statusCode, 201);
    const patched = await api('PATCH', '/api/business', ana, { name: 'Hackeado' }, evil);
    assert.equal(patched.statusCode, 403);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/business/logo',
      cookies: ana,
      headers: { ...evil, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    assert.equal(put.statusCode, 403);
    const del = await api('DELETE', '/api/business/logo', ana, undefined, { 'sec-fetch-site': 'cross-site' });
    assert.equal(del.statusCode, 403);
    assert.equal((await get(ana)).json().business.name, 'Salão da Ana');
  });
});

describe('login e logs (critério 9)', () => {
  test('login sem negócio -> /onboarding; com negócio -> /servicos', async () => {
    const login = () =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@x.com', password: TEST_PASSWORD } });
    assert.equal((await login()).json().redirectTo, '/onboarding');
    const fresh = await login();
    const cookies = { af_session: fresh.cookies.find((c) => c.name === 'af_session').value };
    assert.equal((await create(cookies)).statusCode, 201);
    assert.equal((await login()).json().redirectTo, '/servicos');
  });

  test('endereço e telefone não aparecem nos logs', async () => {
    const res = await create(ana, { ...VALID, address: ADDRESS_SECRET, phone: PHONE_SECRET });
    assert.equal(res.statusCode, 201);
    await patch(ana, { address: `${ADDRESS_SECRET} B` });
    const text = logs();
    assert.match(text, /business_created/);
    assert.equal(text.includes(ADDRESS_SECRET), false);
    assert.equal(text.includes('21987654321'), false);
    assert.equal(text.includes(PHONE_SECRET), false);
  });
});

describe('páginas', () => {
  test('/onboarding, /negocio e /servicos servem HTML', async () => {
    for (const url of ['/onboarding', '/negocio', '/servicos']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /text\/html/);
    }
  });
});

describe('AF-12: prazo de cancelamento e remarcação (critérios 1 e 2)', () => {
  const LEAD = {
    notInteger: 'Informe o prazo em minutos, com um número inteiro.',
    outOfRange: 'Escolha um prazo entre 0 e 4320 minutos (72 h).',
    notMultiple: 'Use múltiplos de 15 minutos (ex.: 15, 30, 60, 120).',
  };

  test('POST sem a chave dá 120; GET traz 120; PATCH 60 dá 200 com 60; PATCH 0 aceito', async () => {
    const created = await create(ana);
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().business.cancellationLeadMinutes, 120);
    assert.equal((await get(ana)).json().business.cancellationLeadMinutes, 120);
    const res = await patch(ana, { cancellationLeadMinutes: 60 });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().business.cancellationLeadMinutes, 60);
    assert.equal((await get(ana)).json().business.cancellationLeadMinutes, 60);
    assert.equal((await patch(ana, { cancellationLeadMinutes: 0 })).json().business.cancellationLeadMinutes, 0);
    // PATCH de outro campo não mexe no prazo.
    assert.equal((await patch(ana, { name: 'Salão Novo' })).json().business.cancellationLeadMinutes, 0);
  });

  test('POST com a chave grava o valor dado', async () => {
    const created = await create(ana, { ...VALID, cancellationLeadMinutes: 1440 });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().business.cancellationLeadMinutes, 1440);
  });

  test('erros por campo, junto com phone inválido no mesmo corpo, sem eco; nada gravado', async () => {
    await create(ana);
    for (const [value, message] of [
      ['120', LEAD.notInteger],
      [null, LEAD.notInteger],
      [1.5, LEAD.notInteger],
      [true, LEAD.notInteger],
      [-15, LEAD.outOfRange],
      [4335, LEAD.outOfRange],
      [10_000, LEAD.outOfRange],
      [10, LEAD.notMultiple],
    ]) {
      const res = await patch(ana, { cancellationLeadMinutes: value, phone: '123<b>' });
      assert.equal(res.statusCode, 400, JSON.stringify(value));
      const { fields } = res.json().error;
      assert.equal(fields.cancellationLeadMinutes, message, JSON.stringify(value));
      assert.ok(fields.phone);
      assert.equal(res.body.includes('123<b>'), false, 'sem eco da entrada');
      assert.deepEqual(Object.keys(res.json().error).sort(), ['code', 'fields', 'message']);
    }
    assert.equal((await get(ana)).json().business.cancellationLeadMinutes, 120);
  });

  test('o dono B não altera o prazo de A (escopo da sessão)', async () => {
    await create(ana);
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    await create(bia, { ...VALID, name: 'Barbearia da Bia' });
    assert.equal((await patch(bia, { cancellationLeadMinutes: 4320 })).statusCode, 200);
    assert.equal((await get(ana)).json().business.cancellationLeadMinutes, 120);
    assert.equal((await get(bia)).json().business.cancellationLeadMinutes, 4320);
  });
});
