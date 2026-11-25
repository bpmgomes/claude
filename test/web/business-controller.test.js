import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  submitBusiness,
  checkSlugAvailability,
  uploadLogo,
  removeLogo,
  loadBusiness,
  suggestSlugFromName,
  safeLogoUrl,
  safePublicUrl,
} = await import('../../web/js/business-controller.js');
const { GENERIC_ERROR_MESSAGE, requestBinary } = await import('../../web/js/api.js');

const VALID = { name: 'Salão da Ana', address: 'Rua A, 10', phone: '(11) 91234-5678', slug: 'salao-da-ana' };
const BUSINESS = { id: '1', name: 'Salão da Ana', slug: 'salao-da-ana', publicUrl: 'https://agendafacil.app/salao-da-ana' };

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('no body');
        return body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

describe('submitBusiness (critérios 9, 15, 20)', () => {
  test('criação 201 devolve business e redirectTo; POST com JSON', async () => {
    const fetchFn = fakeFetch(201, { business: BUSINESS, redirectTo: '/servicos' });
    const result = await submitBusiness(VALID, { mode: 'create', fetchFn });
    assert.deepEqual(result, { ok: true, business: BUSINESS, redirectTo: '/servicos' });
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].url, '/api/business');
    assert.equal(fetchFn.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), VALID);
  });

  test('edição usa PATCH e envia só os campos informados', async () => {
    const fetchFn = fakeFetch(200, { business: BUSINESS });
    const result = await submitBusiness({ phone: '11912345678' }, { mode: 'update', fetchFn });
    assert.equal(result.ok, true);
    assert.equal(fetchFn.calls[0].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { phone: '11912345678' });
  });

  test('409 SLUG_TAKEN devolve fields.slug e suggestion', async () => {
    const fetchFn = fakeFetch(409, {
      error: {
        code: 'SLUG_TAKEN',
        message: 'Este link já está em uso.',
        fields: { slug: 'Este link já está em uso.' },
        suggestion: 'salao-da-ana-2',
      },
    });
    const result = await submitBusiness(VALID, { mode: 'create', fetchFn });
    assert.equal(result.ok, false);
    assert.deepEqual(result.fields, { slug: 'Este link já está em uso.' });
    assert.equal(result.suggestion, 'salao-da-ana-2');
  });

  test('telefone inválido não chama fetchFn', async () => {
    const fetchFn = fakeFetch(201, {});
    const result = await submitBusiness({ ...VALID, phone: '1234-5678' }, { mode: 'create', fetchFn });
    assert.equal(result.ok, false);
    assert.ok(result.fields.phone);
    assert.equal(fetchFn.calls.length, 0);
  });

  test('slug reservado ou nome que gera slug curto não chamam fetchFn', async () => {
    const fetchFn = fakeFetch(201, {});
    assert.ok((await submitBusiness({ ...VALID, slug: 'admin' }, { mode: 'create', fetchFn })).fields.slug);
    assert.ok((await submitBusiness({ ...VALID, name: 'Zé', slug: '' }, { mode: 'create', fetchFn })).fields.slug);
    assert.equal(fetchFn.calls.length, 0);
  });

  test('400 do servidor devolve fields; 500 e rede devolvem mensagem genérica', async () => {
    const r400 = await submitBusiness(VALID, {
      mode: 'create',
      fetchFn: fakeFetch(400, { error: { code: 'VALIDATION_ERROR', message: 'x', fields: { name: 'y' } } }),
    });
    assert.deepEqual(r400.fields, { name: 'y' });
    const r500 = await submitBusiness(VALID, { mode: 'create', fetchFn: fakeFetch(500) });
    assert.equal(r500.message, GENERIC_ERROR_MESSAGE);
    const net = await submitBusiness(VALID, {
      mode: 'create',
      fetchFn: async () => {
        throw new TypeError('offline');
      },
    });
    assert.equal(net.message, GENERIC_ERROR_MESSAGE);
  });
});

describe('checkSlugAvailability', () => {
  test('consulta o servidor com o slug normalizado', async () => {
    const fetchFn = fakeFetch(200, { slug: 'salao', available: true });
    const result = await checkSlugAvailability('Salao', { fetchFn });
    assert.deepEqual(result, { ok: true, slug: 'salao', available: true });
    assert.equal(fetchFn.calls[0].url, '/api/business/slug-availability?slug=salao');
  });

  test('slug inválido localmente não chama o servidor', async () => {
    const fetchFn = fakeFetch(200, {});
    const result = await checkSlugAvailability('a', { fetchFn });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'INVALID');
    assert.equal(fetchFn.calls.length, 0);
  });
});

describe('uploadLogo (critérios 10, 11)', () => {
  test('arquivo com 2 MB + 1 não chama fetchFn', async () => {
    const fetchFn = fakeFetch(200, {});
    const result = await uploadLogo({ size: 2 * 1024 * 1024 + 1, type: 'image/png' }, { fetchFn });
    assert.deepEqual(result, { ok: false, message: 'O logo deve ter no máximo 2 MB.' });
    assert.equal(fetchFn.calls.length, 0);
  });

  test('image/gif e SVG não chamam fetchFn', async () => {
    const fetchFn = fakeFetch(200, {});
    for (const type of ['image/gif', 'image/svg+xml', '']) {
      const result = await uploadLogo({ size: 10, type }, { fetchFn });
      assert.equal(result.message, 'Envie uma imagem PNG ou JPG válida.');
    }
    assert.equal(fetchFn.calls.length, 0);
  });

  test('PUT envia o arquivo como corpo com application/octet-stream', async () => {
    const fetchFn = fakeFetch(200, { business: { ...BUSINESS, logoUrl: '/media/logos/x.png' } });
    const file = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });
    const result = await uploadLogo(file, { fetchFn });
    assert.equal(result.ok, true);
    const { url, init } = fetchFn.calls[0];
    assert.equal(url, '/api/business/logo');
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers['Content-Type'], 'application/octet-stream');
    assert.equal(init.body, file);
  });

  test('exatamente 2 MB é enviado; 422 do servidor vira mensagem', async () => {
    const fetchFn = fakeFetch(422, { error: { code: 'INVALID_IMAGE', message: 'Envie uma imagem PNG ou JPG válida.' } });
    const result = await uploadLogo({ size: 2 * 1024 * 1024, type: 'image/jpeg' }, { fetchFn });
    assert.equal(fetchFn.calls.length, 1);
    assert.deepEqual(result, { ok: false, status: 422, message: 'Envie uma imagem PNG ou JPG válida.' });
  });
});

describe('outros', () => {
  test('suggestSlugFromName', () => {
    assert.equal(suggestSlugFromName('Salão da Ana'), 'salao-da-ana');
  });

  test('removeLogo e loadBusiness', async () => {
    const del = fakeFetch(204);
    assert.deepEqual(await removeLogo({ fetchFn: del }), { ok: true });
    assert.equal(del.calls[0].init.method, 'DELETE');
    const missing = await loadBusiness({
      fetchFn: fakeFetch(404, { error: { code: 'BUSINESS_NOT_FOUND', message: 'x' } }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await loadBusiness({ fetchFn: fakeFetch(200, { business: BUSINESS }) })).business, BUSINESS);
  });

  test('safeLogoUrl e safePublicUrl só aceitam URLs esperadas (critério 5)', () => {
    const logo = '/media/logos/0f8fad5b-d9cb-469f-a165-70867728950e.png';
    assert.equal(safeLogoUrl(logo), logo);
    for (const bad of ['javascript:alert(1)', '//evil.example/x.png', '/media/logos/../x.png', null]) {
      assert.equal(safeLogoUrl(bad), null, String(bad));
    }
    assert.equal(safePublicUrl('https://agendafacil.app/salao'), 'https://agendafacil.app/salao');
    assert.equal(safePublicUrl('javascript:alert(1)'), null);
    assert.equal(safePublicUrl('data:text/html,x'), null);
    assert.equal(safePublicUrl('nada'), null);
  });

  test('requestBinary nunca lança', async () => {
    const res = await requestBinary('/x', {
      body: new Uint8Array(1),
      fetchFn: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(res.status, 0);
    assert.equal(res.error.code, 'NETWORK_ERROR');
  });
});
