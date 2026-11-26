import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { buildTestApp } from '../helpers/test-app.js';
import { signupAndLogin, createBusinessFor, createService, createProfessional } from '../helpers/session.js';
import {
  pngOf,
  jpegOf,
  jpegWithExif,
  gifOf,
  svgBytes,
  truncated,
  padPngTo,
  metadataOf,
} from '../helpers/images.js';
import { PROFESSIONAL_MESSAGES as M } from '../../src/shared/professionals.js';
import { textKey } from '../../src/shared/validation.js';
import { createProfessionalsService } from '../../src/modules/professionals/professionals.service.js';
import { createImageLimiter } from '../../src/images/image-limiter.js';

const PHOTO_URL_RE = /^\/media\/professionals\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;
const MAX = 2_097_152;

let app;
let logs;
let storage;
let ana;
let anaBusiness;

beforeEach(async () => {
  ({ app, logs, storage } = await buildTestApp());
  ana = await signupAndLogin(app, { email: 'ana@x.com' });
  anaBusiness = await createBusinessFor(app, ana);
});

afterEach(async () => {
  await app.close();
});

function api(method, url, cookies, payload, headers = {}) {
  return app.inject({ method, url, cookies, payload, headers });
}

const post = (cookies, payload) => api('POST', '/api/professionals', cookies, payload);
const patch = (cookies, id, payload) => api('PATCH', `/api/professionals/${id}`, cookies, payload);
const del = (cookies, id) => api('DELETE', `/api/professionals/${id}`, cookies);
const get = (cookies, id) => api('GET', `/api/professionals/${id}`, cookies);
const list = (cookies) => api('GET', '/api/professionals', cookies);

function putPhoto(cookies, id, body, { contentType = 'application/octet-stream', headers = {} } = {}) {
  return app.inject({
    method: 'PUT',
    url: `/api/professionals/${id}/photo`,
    cookies,
    headers: { 'content-type': contentType, ...headers },
    payload: body,
  });
}
const delPhoto = (cookies, id, headers = {}) => api('DELETE', `/api/professionals/${id}/photo`, cookies, undefined, headers);

const keyOf = (url) => url.replace(/^\/media\//, '');

async function countProfessionals() {
  return (await app.db.get('SELECT COUNT(*) AS n FROM professionals')).n;
}

async function otherOwner(email = 'bia@x.com', name = 'Salão da Bia') {
  const cookies = await signupAndLogin(app, { email });
  const business = await createBusinessFor(app, cookies, { name });
  return { cookies, business };
}

/** Insere `n` profissionais ativos direto pelo repositório. */
async function fill(businessId, n) {
  const repo = app.services.professionalsRepository;
  for (let i = 0; i < n; i++) {
    const name = `Profissional ${i}`;
    await repo.insert({ id: randomUUID(), businessId, name, nameKey: textKey(name), createdAt: new Date().toISOString() });
  }
}

describe('criação (critérios 1, 4, 7)', () => {
  test('201 sem serviços: rascunho com services [] e bookable false', async () => {
    const res = await post(ana, { name: 'Ana Souza' });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal('warnings' in body, false);
    const { professional } = body;
    assert.equal(professional.name, 'Ana Souza');
    assert.deepEqual(professional.services, []);
    assert.equal(professional.bookable, false);
    assert.equal(professional.photoUrl, null);
    for (const hidden of ['businessId', 'nameKey', 'photoKey', 'removedAt']) assert.equal(hidden in professional, false);
    const read = await get(ana, professional.id);
    assert.deepEqual(read.json(), { professional });
  });

  test('com dois serviços: 201 com os dois e bookable true', async () => {
    const s1 = await createService(app, ana, { name: 'Corte' });
    const s2 = await createService(app, ana, { name: 'Barba' });
    const res = await post(ana, { name: 'Ana', serviceIds: [s1.id, s2.id] });
    assert.equal(res.statusCode, 201);
    const { professional } = res.json();
    assert.deepEqual(professional.services, [
      { id: s2.id, name: 'Barba', active: true },
      { id: s1.id, name: 'Corte', active: true },
    ]);
    assert.equal(professional.bookable, true);
  });

  test('businessId de outro negócio, id e removedAt no corpo são ignorados (critério 4)', async () => {
    const bia = await otherOwner();
    const forcedId = randomUUID();
    const res = await post(ana, {
      name: 'Ana',
      businessId: bia.business.id,
      id: forcedId,
      removedAt: '2020-01-01T00:00:00.000Z',
      photoKey: `professionals/${randomUUID()}.png`,
    });
    assert.equal(res.statusCode, 201);
    const { professional } = res.json();
    assert.notEqual(professional.id, forcedId);
    assert.equal(professional.photoUrl, null);
    const row = await app.db.get('SELECT business_id, removed_at, photo_key FROM professionals WHERE id = ?', [
      professional.id,
    ]);
    assert.deepEqual(row, { business_id: anaBusiness.id, removed_at: null, photo_key: null });
  });
});

describe('autenticação e negócio (critério 2)', () => {
  test('401 em todas as rotas sem sessão e nada é gravado', async () => {
    const id = randomUUID();
    const calls = [
      ['GET', '/api/professionals'],
      ['GET', `/api/professionals/${id}`],
      ['POST', '/api/professionals', { name: 'Ana' }],
      ['PATCH', `/api/professionals/${id}`, { name: 'Ana' }],
      ['DELETE', `/api/professionals/${id}`],
      ['DELETE', `/api/professionals/${id}/photo`],
    ];
    for (const [method, url, payload] of calls) {
      const res = await api(method, url, {}, payload);
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.equal(res.json().error.code, 'UNAUTHENTICATED');
    }
    const photo = await putPhoto({}, id, Buffer.alloc(MAX + 1024));
    assert.equal(photo.statusCode, 401);
    assert.equal(await countProfessionals(), 0);
  });

  test('dono sem negócio: GET e POST dão 409 BUSINESS_REQUIRED', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    for (const res of [await list(bia), await post(bia, { name: 'Ana' })]) {
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.json(), { error: { code: 'BUSINESS_REQUIRED', message: M.businessRequired } });
    }
    assert.equal(await countProfessionals(), 0);
  });
});

describe('validação sem eco (critérios 3, 5)', () => {
  test('nome com 10.000 caracteres e serviceIds com string de 5.000: 400 curto e sem a entrada', async () => {
    const res = await post(ana, { name: 'x'.repeat(10_000), serviceIds: ['y'.repeat(5000)] });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.length < 1024, `corpo com ${res.body.length} bytes`);
    assert.equal(res.body.includes('xxxx'), false);
    assert.equal(res.body.includes('yyyy'), false);
    assert.deepEqual(res.json().error.fields, { name: M.nameTooLong, serviceIds: M.serviceIdsInvalid });
  });

  test('nome vazio, invisível ou só marcas: 400 por campo', async () => {
    for (const name of ['', '   ', 'ㅤ', '́́', 'Ana‮', '...']) {
      const res = await post(ana, { name });
      assert.equal(res.statusCode, 400, JSON.stringify(name));
      assert.ok(res.json().error.fields.name);
    }
    assert.equal(await countProfessionals(), 0);
  });

  test('XSS: o nome é gravado e devolvido literalmente', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const res = await post(ana, { name });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().professional.name, name);
    assert.equal((await list(ana)).json().professionals[0].name, name);
  });
});

describe('serviços do profissional (critérios 6, 8, 9)', () => {
  test('serviço de outro negócio e UUID inexistente dão 400 com corpos idênticos', async () => {
    const bia = await otherOwner();
    const foreign = await createService(app, bia.cookies, { name: 'Corte' });
    const a = await post(ana, { name: 'Ana', serviceIds: [foreign.id] });
    const b = await post(ana, { name: 'Ana', serviceIds: [randomUUID()] });
    assert.equal(a.statusCode, 400);
    assert.equal(b.statusCode, 400);
    assert.equal(a.body, b.body);
    assert.deepEqual(a.json().error.fields, { serviceIds: M.serviceIdsInvalid });
    assert.equal(await countProfessionals(), 0);
  });

  test('o mesmo ID duas vezes: 201 com um vínculo só', async () => {
    const s = await createService(app, ana);
    const res = await post(ana, { name: 'Ana', serviceIds: [s.id, s.id] });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().professional.services.length, 1);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM professional_services')).n, 1);
  });

  test('serviço desativado depois do vínculo: active false, bookable false; reativar volta; PATCH com a lista atual passa', async () => {
    const s = await createService(app, ana);
    const p = await createProfessional(app, ana, { serviceIds: [s.id] });
    assert.equal(p.bookable, true);
    await api('POST', `/api/services/${s.id}/deactivate`, ana);
    let read = (await get(ana, p.id)).json().professional;
    assert.deepEqual(read.services, [{ id: s.id, name: 'Corte', active: false }]);
    assert.equal(read.bookable, false);

    const same = await patch(ana, p.id, { serviceIds: read.services.map((x) => x.id) });
    assert.equal(same.statusCode, 200);
    assert.equal(same.json().professional.services.length, 1);

    await api('POST', `/api/services/${s.id}/reactivate`, ana);
    read = (await get(ana, p.id)).json().professional;
    assert.equal(read.bookable, true);
    assert.equal(read.services[0].active, true);
  });
});

describe('homônimo (decisão 4)', () => {
  test('segunda Ana (e ANA, Aná) dá 201 com aviso; renomear para o próprio nome não avisa', async () => {
    const first = await post(ana, { name: 'Ana' });
    assert.equal('warnings' in first.json(), false);
    for (const name of ['Ana', 'ANA', 'Aná']) {
      const res = await post(ana, { name });
      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.json().warnings, [
        { code: 'PROFESSIONAL_NAME_DUPLICATE', field: 'name', message: M.nameDuplicate },
      ]);
    }
    const bia = await createProfessional(app, ana, { name: 'Bia' });
    const self = await patch(ana, bia.id, { name: 'BIA' });
    assert.equal(self.statusCode, 200);
    assert.equal('warnings' in self.json(), false);
    const toAna = await patch(ana, bia.id, { name: 'ana' });
    assert.equal(toAna.json().warnings[0].code, 'PROFESSIONAL_NAME_DUPLICATE');
    const onlyServices = await patch(ana, bia.id, { serviceIds: [] });
    assert.equal('warnings' in onlyServices.json(), false);
  });
});

describe('limite de 50 (critério 22)', () => {
  test('com 50 ativos: 409; remover um libera a vaga', async () => {
    await fill(anaBusiness.id, 49);
    const last = await createProfessional(app, ana, { name: 'Última' });
    const res = await post(ana, { name: 'Excedente' });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: { code: 'PROFESSIONAL_LIMIT_REACHED', message: M.limitReached } });
    assert.equal((await del(ana, last.id)).statusCode, 204);
    assert.equal((await post(ana, { name: 'Excedente' })).statusCode, 201);
  });

  test('com 49: dois POST simultâneos dão um 201 e um 409', async () => {
    await fill(anaBusiness.id, 49);
    const results = await Promise.all([post(ana, { name: 'X' }), post(ana, { name: 'Y' })]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal(
      (await app.db.get('SELECT COUNT(*) AS n FROM professionals WHERE removed_at IS NULL')).n,
      50,
    );
  });
});

describe('edição (critérios 16, 27)', () => {
  test('PATCH de nome e de serviços; [] limpa; {} dá 400', async () => {
    const s1 = await createService(app, ana, { name: 'Corte' });
    const s2 = await createService(app, ana, { name: 'Barba' });
    const p = await createProfessional(app, ana, { serviceIds: [s1.id] });

    const renamed = await patch(ana, p.id, { name: 'Ana Lima' });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().professional.name, 'Ana Lima');
    assert.equal(renamed.json().professional.services.length, 1);

    const swapped = await patch(ana, p.id, { serviceIds: [s2.id] });
    assert.deepEqual(swapped.json().professional.services.map((s) => s.id), [s2.id]);
    assert.equal(swapped.json().professional.name, 'Ana Lima');

    const cleared = await patch(ana, p.id, { serviceIds: [] });
    assert.deepEqual(cleared.json().professional.services, []);
    assert.equal(cleared.json().professional.bookable, false);

    const empty = await patch(ana, p.id, {});
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error.message, 'Nada para atualizar.');

    const bad = await patch(ana, p.id, { serviceIds: [randomUUID()] });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual((await get(ana, p.id)).json().professional.services, [], 'erro não altera nada');
  });

  test('dois PATCH simultâneos: dois 200 e estado final X+S1 ou Y+S2', async () => {
    const s1 = await createService(app, ana, { name: 'Corte' });
    const s2 = await createService(app, ana, { name: 'Barba' });
    const p = await createProfessional(app, ana);
    for (let i = 0; i < 5; i++) {
      const results = await Promise.all([
        patch(ana, p.id, { name: 'X', serviceIds: [s1.id] }),
        patch(ana, p.id, { name: 'Y', serviceIds: [s2.id] }),
      ]);
      assert.deepEqual(results.map((r) => r.statusCode), [200, 200]);
      const final = (await get(ana, p.id)).json().professional;
      const state = `${final.name}+${final.services.map((s) => s.id).join(',')}`;
      assert.ok([`X+${s1.id}`, `Y+${s2.id}`].includes(state), state);
    }
  });
});

describe('remoção (critérios 17, 20, 21)', () => {
  test('204; some do GET; linha fica com removed_at e nome; foto apagada; 2ª remoção 404', async () => {
    const p = await createProfessional(app, ana, { name: 'Ana Souza' });
    const { photoUrl } = (await putPhoto(ana, p.id, await pngOf(20, 20))).json().professional;
    assert.match(photoUrl, PHOTO_URL_RE);

    const res = await del(ana, p.id);
    assert.equal(res.statusCode, 204);
    assert.deepEqual((await list(ana)).json().professionals, []);
    assert.equal((await get(ana, p.id)).statusCode, 404);
    const row = await app.db.get('SELECT name, removed_at, photo_key FROM professionals WHERE id = ?', [p.id]);
    assert.equal(row.name, 'Ana Souza');
    assert.ok(row.removed_at);
    assert.equal(row.photo_key, null);
    assert.deepEqual(storage.keys(), []);
    assert.equal((await app.inject({ method: 'GET', url: photoUrl })).statusCode, 404);

    const again = await del(ana, p.id);
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().error.code, 'PROFESSIONAL_NOT_FOUND');
    assert.equal((await patch(ana, p.id, { name: 'X' })).statusCode, 404);
    assert.equal((await putPhoto(ana, p.id, await pngOf(10, 10))).statusCode, 404);
    assert.equal((await delPhoto(ana, p.id)).statusCode, 404);
    assert.deepEqual(storage.keys(), []);
  });

  test('409 com futureAppointmentsCount pela API (porta falsa com 3) e nada muda', async () => {
    const s = await createService(app, ana);
    const p = await createProfessional(app, ana, { serviceIds: [s.id] });
    await putPhoto(ana, p.id, await pngOf(10, 10));
    const before = await app.db.get('SELECT name, photo_key, removed_at, updated_at FROM professionals WHERE id = ?', [p.id]);

    const { professionalsRepository, businessesRepository } = app.services;
    app.services.professionalsService = createProfessionalsService({
      db: app.db,
      professionalsRepository,
      businessesRepository,
      storage,
      appointments: { countFutureByService: async () => 0, countFutureByProfessional: async () => 3 },
    });

    const res = await del(ana, p.id);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), {
      error: {
        code: 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS',
        message: M.hasFutureAppointments,
        futureAppointmentsCount: 3,
      },
    });
    assert.deepEqual(
      await app.db.get('SELECT name, photo_key, removed_at, updated_at FROM professionals WHERE id = ?', [p.id]),
      before,
    );
    assert.equal((await get(ana, p.id)).json().professional.services.length, 1);
    assert.equal(storage.keys().length, 1);
  });
});

describe('foto (critérios 11, 12, 13)', () => {
  test('PNG 800x400 e JPEG com EXIF: 200, photoUrl válido, 256x256 sem EXIF', async () => {
    const p = await createProfessional(app, ana);
    const png = await putPhoto(ana, p.id, await pngOf(800, 400));
    assert.equal(png.statusCode, 200);
    const pngUrl = png.json().professional.photoUrl;
    assert.match(pngUrl, PHOTO_URL_RE);
    let meta = await metadataOf(await storage.get(keyOf(pngUrl)));
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 256, 256]);

    const jpeg = await putPhoto(ana, p.id, await jpegWithExif(300, 900), { contentType: 'image/jpeg' });
    assert.equal(jpeg.statusCode, 200);
    const saved = await storage.get(keyOf(jpeg.json().professional.photoUrl));
    meta = await metadataOf(saved);
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 256, 256]);
    assert.equal(meta.exif, undefined);
    assert.equal(saved.includes(Buffer.from('segredo')), false);
  });

  test('PNG 800x400: foto 256x256 com fit cover, sem pixel transparente nos cantos (AF-09)', async () => {
    const p = await createProfessional(app, ana);
    const res = await putPhoto(ana, p.id, await pngOf(800, 400));
    assert.equal(res.statusCode, 200);
    const saved = await storage.get(keyOf(res.json().professional.photoUrl));
    const { data, info } = await sharp(saved).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [256, 256]);
    const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
    for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255], [128, 0], [128, 255]]) {
      assert.equal(alphaAt(x, y), 255, `pixel ${x},${y}`);
    }

    // O logo continua com `contain`: faixas transparentes em cima e embaixo.
    const logo = await app.inject({
      method: 'PUT',
      url: '/api/business/logo',
      cookies: ana,
      headers: { 'content-type': 'image/png' },
      payload: await pngOf(800, 400),
    });
    assert.equal(logo.statusCode, 200);
    const logoPng = await storage.get(keyOf(logo.json().business.logoUrl));
    const raw = await sharp(logoPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const logoAlpha = (x, y) => raw.data[(y * raw.info.width + x) * raw.info.channels + 3];
    assert.equal(logoAlpha(0, 0), 0);
    assert.equal(logoAlpha(255, 255), 0);
    assert.equal(logoAlpha(128, 128), 255);
  });

  test('GIF, SVG como png, vazio, JPEG truncado e PNG 5000x10: 422 INVALID_IMAGE', async () => {
    const p = await createProfessional(app, ana);
    const bodies = [
      [await gifOf(), 'image/png'],
      [svgBytes(), 'image/png'],
      [Buffer.alloc(0), 'application/octet-stream'],
      [truncated(await jpegOf(300, 300)), 'image/jpeg'],
      [await pngOf(5000, 10), 'image/png'],
    ];
    for (const [body, contentType] of bodies) {
      const res = await putPhoto(ana, p.id, body, { contentType });
      assert.equal(res.statusCode, 422, contentType);
      assert.equal(res.json().error.code, 'INVALID_IMAGE');
    }
    assert.equal(
      (await putPhoto(ana, p.id, await pngOf(5000, 10))).json().error.message,
      'A imagem deve ter no máximo 4096×4096 pixels.',
    );
    assert.deepEqual(storage.keys(), []);
    assert.match(logs(), /professional_photo_rejected/);
  });

  test('2 MiB + 1 dá 413 PHOTO_TOO_LARGE; exatamente 2 MiB passa', async () => {
    const p = await createProfessional(app, ana);
    const over = await putPhoto(ana, p.id, padPngTo(await pngOf(64, 64), MAX + 1));
    assert.equal(over.statusCode, 413);
    assert.deepEqual(over.json(), { error: { code: 'PHOTO_TOO_LARGE', message: M.photoTooLarge } });
    assert.deepEqual(storage.keys(), []);
    assert.equal((await putPhoto(ana, p.id, padPngTo(await pngOf(64, 64), MAX))).statusCode, 200);
  });

  test('multipart/form-data e application/json dão 415', async () => {
    const p = await createProfessional(app, ana);
    const multipart = await putPhoto(ana, p.id, Buffer.from('--x\r\n\r\n--x--'), {
      contentType: 'multipart/form-data; boundary=x',
    });
    assert.equal(multipart.statusCode, 415);
    assert.equal(multipart.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal((await putPhoto(ana, p.id, '{}', { contentType: 'application/json' })).statusCode, 415);
  });

  test('trocar a foto: URL antiga dá 404 e a chave antiga é apagada', async () => {
    const p = await createProfessional(app, ana);
    const first = (await putPhoto(ana, p.id, await pngOf(10, 10))).json().professional.photoUrl;
    const second = (await putPhoto(ana, p.id, await jpegOf(10, 10))).json().professional.photoUrl;
    assert.notEqual(first, second);
    assert.deepEqual(storage.keys(), [keyOf(second)]);
    assert.equal((await app.inject({ method: 'GET', url: first })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: second })).statusCode, 200);
  });

  test('DELETE /photo dá 204 duas vezes, photoUrl null e a URL dá 404', async () => {
    const p = await createProfessional(app, ana);
    const { photoUrl } = (await putPhoto(ana, p.id, await pngOf(10, 10))).json().professional;
    assert.equal((await delPhoto(ana, p.id)).statusCode, 204);
    assert.equal((await delPhoto(ana, p.id)).statusCode, 204);
    assert.equal((await get(ana, p.id)).json().professional.photoUrl, null);
    assert.deepEqual(storage.keys(), []);
    assert.equal((await app.inject({ method: 'GET', url: photoUrl })).statusCode, 404);
  });
});

describe('media (critérios 13, 15)', () => {
  test('Cache-Control de 1 dia sem immutable, nosniff, image/png, CSP sandbox', async () => {
    const p = await createProfessional(app, ana);
    const { photoUrl } = (await putPhoto(ana, p.id, await pngOf(10, 10))).json().professional;
    const res = await app.inject({ method: 'GET', url: photoUrl });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=86400');
    assert.doesNotMatch(res.headers['cache-control'], /immutable/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['content-disposition'], 'inline; filename="foto.png"');
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.deepEqual(res.rawPayload, await storage.get(keyOf(photoUrl)));
  });

  test('travessia, .svg, maiúsculas e arquivo órfão dão 404', async () => {
    const orphan = `professionals/${randomUUID()}.png`;
    await storage.put(orphan, Buffer.from('orfao'));
    for (const url of [
      `/media/${orphan}`,
      '/media/professionals/..%2F..%2Fetc%2Fpasswd',
      '/media/professionals/../../etc/passwd',
      '/media/professionals/abc.png',
      `/media/professionals/${randomUUID()}.svg`,
      `/media/professionals/${randomUUID().toUpperCase()}.png`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(String(res.headers['content-type']).startsWith('image/'), false, url);
    }
  });

  test('a chave de um logo não é servida em /media/professionals', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/business/logo',
      cookies: ana,
      headers: { 'content-type': 'application/octet-stream' },
      payload: await pngOf(10, 10),
    });
    const logoUrl = (await api('GET', '/api/business', ana)).json().business.logoUrl;
    const file = logoUrl.split('/').pop();
    assert.equal((await app.inject({ method: 'GET', url: `/media/professionals/${file}` })).statusCode, 404);
  });
});

describe('fila de imagem (critério 14)', () => {
  test('limitador cheio: PUT /photo e PUT /logo dão 503 IMAGE_BUSY com Retry-After; liberado, passam', async () => {
    await app.close();
    const imageLimiter = createImageLimiter({ concurrency: 1, queueMax: 0, queueTimeoutMs: 1000 });
    ({ app, storage, logs } = await buildTestApp({ imageLimiter }));
    ana = await signupAndLogin(app, { email: 'ana@x.com' });
    anaBusiness = await createBusinessFor(app, ana);
    const p = await createProfessional(app, ana);

    let release;
    const occupied = imageLimiter.run(() => new Promise((resolve) => (release = resolve)));
    assert.deepEqual(imageLimiter.stats(), { active: 1, queued: 0 });

    const busy = await putPhoto(ana, p.id, await pngOf(10, 10));
    assert.equal(busy.statusCode, 503);
    assert.equal(busy.json().error.code, 'IMAGE_BUSY');
    assert.equal(busy.headers['retry-after'], '5');
    const logo = await app.inject({
      method: 'PUT',
      url: '/api/business/logo',
      cookies: ana,
      headers: { 'content-type': 'application/octet-stream' },
      payload: await pngOf(10, 10),
    });
    assert.equal(logo.statusCode, 503);
    assert.equal(logo.json().error.code, 'IMAGE_BUSY');
    assert.deepEqual(storage.keys(), []);
    assert.equal((await get(ana, p.id)).json().professional.photoUrl, null);
    assert.match(logs(), /image_busy/);
    assert.doesNotMatch(logs(), /"statusCode":500/);

    release();
    await occupied;
    assert.equal((await putPhoto(ana, p.id, await pngOf(10, 10))).statusCode, 200);
  });
});

describe('isolamento (critério 24)', () => {
  test('dono B recebe 404 idêntico ao de UUID inexistente em todas as rotas', async () => {
    const p = await createProfessional(app, ana);
    await putPhoto(ana, p.id, await pngOf(10, 10));
    const bia = await otherOwner();
    const missing = randomUUID();
    const png = await pngOf(10, 10);
    const pairs = [
      [(id) => get(bia.cookies, id)],
      [(id) => patch(bia.cookies, id, { name: 'Hack' })],
      [(id) => del(bia.cookies, id)],
      [(id) => putPhoto(bia.cookies, id, png)],
      [(id) => delPhoto(bia.cookies, id)],
    ];
    for (const [call] of pairs) {
      const foreign = await call(p.id);
      const none = await call(missing);
      assert.equal(foreign.statusCode, 404);
      assert.equal(foreign.body, none.body);
      assert.deepEqual(foreign.json(), { error: { code: 'PROFESSIONAL_NOT_FOUND', message: M.notFound } });
    }
    assert.deepEqual((await list(bia.cookies)).json().professionals, []);
    const mine = (await get(ana, p.id)).json().professional;
    assert.equal(mine.name, 'Ana Souza');
    assert.ok(mine.photoUrl);
  });

  test(':id inválido dá 404', async () => {
    for (const id of ['abc', randomUUID().toUpperCase(), '..%2F..', '1']) {
      const res = await get(ana, id);
      assert.equal(res.statusCode, 404, id);
      assert.equal(res.json().error.code, 'PROFESSIONAL_NOT_FOUND');
    }
  });
});

describe('CSRF (critério 25)', () => {
  test('Origin de outro site em POST, PATCH, DELETE e PUT/DELETE de foto: 403 e nada muda', async () => {
    const p = await createProfessional(app, ana);
    const evil = { origin: 'https://evil.example' };
    const responses = [
      await api('POST', '/api/professionals', ana, { name: 'X' }, evil),
      await api('PATCH', `/api/professionals/${p.id}`, ana, { name: 'X' }, evil),
      await api('DELETE', `/api/professionals/${p.id}`, ana, undefined, evil),
      await putPhoto(ana, p.id, await pngOf(10, 10), { headers: evil }),
      await delPhoto(ana, p.id, evil),
    ];
    for (const res of responses) {
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'FORBIDDEN_ORIGIN');
    }
    assert.equal(await countProfessionals(), 1);
    const read = (await get(ana, p.id)).json().professional;
    assert.equal(read.name, 'Ana Souza');
    assert.equal(read.photoUrl, null);
  });
});

describe('listagem e logs (critério 21)', () => {
  test('ordem por nome sem acento; removido não aparece', async () => {
    for (const name of ['Bruno', 'Ágata', 'carla', 'Davi']) await createProfessional(app, ana, { name });
    const davi = (await list(ana)).json().professionals.find((p) => p.name === 'Davi');
    await del(ana, davi.id);
    assert.deepEqual(
      (await list(ana)).json().professionals.map((p) => p.name),
      ['Ágata', 'Bruno', 'carla'],
    );
  });

  test('o nome não aparece nos logs', async () => {
    const p = await createProfessional(app, ana, { name: 'Zulmira Secreta' });
    await patch(ana, p.id, { name: 'Zulmira Renomeada' });
    await putPhoto(ana, p.id, await pngOf(10, 10));
    await delPhoto(ana, p.id);
    await del(ana, p.id);
    const output = logs();
    for (const event of [
      'professional_created',
      'professional_updated',
      'professional_photo_updated',
      'professional_photo_removed',
      'professional_removed',
    ]) {
      assert.match(output, new RegExp(event));
    }
    assert.equal(output.includes('Zulmira'), false);
  });
});

describe('página', () => {
  test('GET /profissionais serve o HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/profissionais' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /profissionais-page\.js/);
  });
});
