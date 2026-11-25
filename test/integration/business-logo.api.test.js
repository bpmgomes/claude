import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from '../helpers/test-app.js';
import { signupAndLogin } from '../helpers/session.js';
import {
  pngOf,
  jpegOf,
  jpegWithExif,
  gifOf,
  svgBytes,
  truncated,
  padPngTo,
  pngHeaderOnly,
  metadataOf,
} from '../helpers/images.js';

const VALID = { name: 'Salão da Ana', address: 'Rua A, 10', phone: '(11) 91234-5678' };
const LOGO_URL_RE = /^\/media\/logos\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;
const MAX = 2_097_152;

let app;
let storage;
let logs;
let ana;

beforeEach(async () => {
  ({ app, storage, logs } = await buildTestApp());
  ana = await signupAndLogin(app);
  const res = await app.inject({ method: 'POST', url: '/api/business', cookies: ana, payload: VALID });
  assert.equal(res.statusCode, 201);
});

afterEach(async () => {
  await app.close();
});

function put(body, { cookies = ana, contentType = 'application/octet-stream', headers = {} } = {}) {
  return app.inject({
    method: 'PUT',
    url: '/api/business/logo',
    cookies,
    headers: { 'content-type': contentType, ...headers },
    payload: body,
  });
}

function keyOf(logoUrl) {
  return logoUrl.replace(/^\/media\//, '');
}

async function logoKeyInDb() {
  return (await app.db.get('SELECT logo_key FROM businesses')).logo_key;
}

describe('upload (critérios 10, 12, 13)', () => {
  test('PNG -> 200, logoUrl gerado pelo servidor e arquivo 256×256 no storage', async () => {
    const res = await put(await pngOf(800, 400), { headers: { 'x-filename': '../../evil.png' } });
    assert.equal(res.statusCode, 200);
    const { logoUrl } = res.json().business;
    assert.match(logoUrl, LOGO_URL_RE);
    assert.deepEqual(storage.keys(), [keyOf(logoUrl)]);
    const meta = await metadataOf(await storage.get(keyOf(logoUrl)));
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 256, 256]);
  });

  test('JPEG com EXIF e Content-Type image/jpeg -> 200, salvo sem EXIF', async () => {
    const res = await put(await jpegWithExif(300, 900), { contentType: 'image/jpeg' });
    assert.equal(res.statusCode, 200);
    const saved = await storage.get(keyOf(res.json().business.logoUrl));
    const meta = await metadataOf(saved);
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 256, 256]);
    assert.equal(meta.exif, undefined);
    assert.equal(saved.includes(Buffer.from('segredo')), false);
  });

  test('Content-Type image/png com corpo GIF, SVG ou GIF "renomeado" -> 422 INVALID_IMAGE, storage vazio', async () => {
    for (const body of [await gifOf(), svgBytes()]) {
      const res = await put(body, { contentType: 'image/png' });
      assert.equal(res.statusCode, 422);
      assert.deepEqual(res.json(), {
        error: { code: 'INVALID_IMAGE', message: 'Envie uma imagem PNG ou JPG válida.' },
      });
    }
    assert.deepEqual(storage.keys(), []);
    assert.equal(await logoKeyInDb(), null);
    assert.match(logs(), /logo_rejected/);
  });

  test('exatamente 2 MiB -> 200 (critério 11)', async () => {
    const body = padPngTo(await pngOf(64, 64), MAX);
    assert.equal(body.length, MAX);
    const res = await put(body);
    assert.equal(res.statusCode, 200);
    assert.equal(storage.keys().length, 1);
  });

  test('2 MiB + 1 -> 413 LOGO_TOO_LARGE, nada gravado (critério 11)', async () => {
    const body = padPngTo(await pngOf(64, 64), MAX + 1);
    const res = await put(body);
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), {
      error: { code: 'LOGO_TOO_LARGE', message: 'O logo deve ter no máximo 2 MB.' },
    });
    assert.deepEqual(storage.keys(), []);
    assert.equal(await logoKeyInDb(), null);
  });

  test('JPEG truncado, bomb 20000×20000 e corpo vazio -> 422, nunca 500 (critério 14)', async () => {
    const truncatedRes = await put(truncated(await jpegOf(300, 300)));
    assert.equal(truncatedRes.statusCode, 422);

    const bomb = await put(pngHeaderOnly(20000, 20000));
    assert.equal(bomb.statusCode, 422);
    assert.equal(bomb.json().error.message, 'A imagem deve ter no máximo 4096×4096 pixels.');

    const empty = await put(Buffer.alloc(0));
    assert.equal(empty.statusCode, 422);
    const noType = await app.inject({ method: 'PUT', url: '/api/business/logo', cookies: ana });
    assert.equal(noType.statusCode, 422);
    assert.deepEqual(storage.keys(), []);
  });

  test('multipart/form-data e application/json -> 415', async () => {
    const multipart = await put(Buffer.from('--x\r\n\r\n--x--'), { contentType: 'multipart/form-data; boundary=x' });
    assert.equal(multipart.statusCode, 415);
    assert.equal(multipart.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
    const json = await put(JSON.stringify({ a: 1 }), { contentType: 'application/json' });
    assert.equal(json.statusCode, 415);
    assert.deepEqual(storage.keys(), []);
  });

  test('sem cookie -> 401 mesmo com corpo acima do limite (autenticação antes de ler o corpo)', async () => {
    const res = await put(Buffer.alloc(MAX + 1024 * 1024), { cookies: {} });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'UNAUTHENTICATED');
  });

  test('sem negócio -> 404 BUSINESS_NOT_FOUND', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const res = await put(await pngOf(10, 10), { cookies: bia });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'BUSINESS_NOT_FOUND');
    assert.deepEqual(storage.keys(), []);
  });

  test('segundo upload apaga o arquivo anterior e a URL antiga dá 404', async () => {
    const first = (await put(await pngOf(10, 10))).json().business.logoUrl;
    const second = (await put(await jpegOf(10, 10))).json().business.logoUrl;
    assert.notEqual(first, second);
    assert.deepEqual(storage.keys(), [keyOf(second)]);
    assert.equal((await app.inject({ method: 'GET', url: first })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: second })).statusCode, 200);
  });

  test('uploads simultâneos: a última transação vence e só o arquivo referenciado sobra', async () => {
    const bodies = await Promise.all([pngOf(10, 10), pngOf(20, 20), jpegOf(30, 30)]);
    const results = await Promise.all(bodies.map((b) => put(b)));
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
    const key = await logoKeyInDb();
    assert.deepEqual(storage.keys(), [key]);
  });

  test('DELETE -> 204, logoUrl null e arquivo removido; DELETE repetido -> 204', async () => {
    const { logoUrl } = (await put(await pngOf(10, 10))).json().business;
    const del = await app.inject({ method: 'DELETE', url: '/api/business/logo', cookies: ana });
    assert.equal(del.statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/api/business', cookies: ana })).json().business.logoUrl, null);
    assert.deepEqual(storage.keys(), []);
    assert.equal((await app.inject({ method: 'GET', url: logoUrl })).statusCode, 404);
    const again = await app.inject({ method: 'DELETE', url: '/api/business/logo', cookies: ana });
    assert.equal(again.statusCode, 204);
  });

  test('falha ao gravar no banco apaga o arquivo recém-gravado', async () => {
    const original = app.db.transaction.bind(app.db);
    app.db.transaction = async () => {
      throw new Error('falha simulada');
    };
    try {
      const res = await put(await pngOf(10, 10));
      assert.equal(res.statusCode, 500);
      assert.equal(res.json().error.code, 'INTERNAL_ERROR');
    } finally {
      app.db.transaction = original;
    }
    assert.deepEqual(storage.keys(), []);
  });
});

describe('servir o logo (critério 23)', () => {
  test('200 image/png, nosniff, CSP sandbox, inline e corpo idêntico ao do storage', async () => {
    const { logoUrl } = (await put(await pngOf(10, 10))).json().business;
    const res = await app.inject({ method: 'GET', url: logoUrl });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(res.headers['content-disposition'], 'inline; filename="logo.png"');
    // AF-07 (decisão 8, fecha AF-05 item 4): 1 dia, sem immutable.
    assert.equal(res.headers['cache-control'], 'public, max-age=86400');
    assert.deepEqual(res.rawPayload, await storage.get(keyOf(logoUrl)));
  });

  test('UUID válido não referenciado, traversal, nome curto e .svg -> 404', async () => {
    const orphan = `logos/${randomUUID()}.png`;
    await storage.put(orphan, Buffer.from('orfao'));
    for (const url of [
      `/media/${orphan}`,
      '/media/logos/..%2F..%2Fetc%2Fpasswd',
      '/media/logos/../../etc/passwd',
      '/media/logos/abc.png',
      `/media/logos/${randomUUID()}.svg`,
      `/media/logos/${randomUUID().toUpperCase()}.png`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.headers['content-type'].startsWith('image/'), false, url);
    }
  });
});

describe('disco real', () => {
  let dir;
  let diskApp;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'af-uploads-'));
  });

  afterEach(async () => {
    if (diskApp) await diskApp.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('com o storage padrão, o arquivo fica em uploadsDir/logos/<uuid>.png', async () => {
    ({ app: diskApp } = await buildTestApp({ storage: undefined, uploadsDir: dir }));
    const cookies = await signupAndLogin(diskApp);
    await diskApp.inject({ method: 'POST', url: '/api/business', cookies, payload: VALID });
    const res = await diskApp.inject({
      method: 'PUT',
      url: '/api/business/logo',
      cookies,
      headers: { 'content-type': 'application/octet-stream' },
      payload: await pngOf(50, 50),
    });
    assert.equal(res.statusCode, 200);
    const file = res.json().business.logoUrl.split('/').pop();
    assert.deepEqual(await readdir(dir), ['logos']);
    assert.deepEqual(await readdir(join(dir, 'logos')), [file]);

    const served = await diskApp.inject({ method: 'GET', url: res.json().business.logoUrl });
    assert.equal(served.statusCode, 200);
    assert.equal((await metadataOf(served.rawPayload)).width, 256);
  });
});
