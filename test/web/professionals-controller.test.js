import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  loadProfessionals,
  loadServiceOptions,
  submitProfessional,
  uploadPhoto,
  removePhoto,
  removeProfessional,
  safePhotoUrl,
  serviceChoices,
  removalBlockedMessage,
  describeProfessional,
} = await import('../../web/js/professionals-controller.js');
const { PROFESSIONAL_MESSAGES: M } = await import('../../src/shared/professionals.js');
const { GENERIC_ERROR_MESSAGE } = await import('../../web/js/api.js');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const S1 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const S2 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const PROFESSIONAL = { id: ID, name: 'Ana', photoUrl: null, services: [], bookable: false };
const WARNING = { code: 'PROFESSIONAL_NAME_DUPLICATE', field: 'name', message: M.nameDuplicate };

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

describe('submitProfessional (critérios 2, 28)', () => {
  test('criação 201 devolve professional e warnings', async () => {
    const fetchFn = fakeFetch(201, { professional: PROFESSIONAL, warnings: [WARNING] });
    const result = await submitProfessional({ name: 'Ana', serviceIds: [S1] }, { mode: 'create', fetchFn });
    assert.deepEqual(result, { ok: true, professional: PROFESSIONAL, warnings: [WARNING] });
    assert.equal(fetchFn.calls[0].url, '/api/professionals');
    assert.equal(fetchFn.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { name: 'Ana', serviceIds: [S1] });
  });

  test('sem warnings na resposta vira []', async () => {
    const result = await submitProfessional({ name: 'Ana', serviceIds: [] }, {
      mode: 'create',
      fetchFn: fakeFetch(201, { professional: PROFESSIONAL }),
    });
    assert.deepEqual(result.warnings, []);
  });

  test('nome inválido não chama fetchFn', async () => {
    const fetchFn = fakeFetch(201, { professional: PROFESSIONAL });
    for (const name of ['', 'ㅤ', 'a'.repeat(101)]) {
      const result = await submitProfessional({ name, serviceIds: [] }, { mode: 'create', fetchFn });
      assert.equal(result.ok, false);
      assert.ok(result.fields.name);
    }
    assert.equal(fetchFn.calls.length, 0);
  });

  test('edição usa PATCH /api/professionals/:id; id inválido não chama fetchFn', async () => {
    const fetchFn = fakeFetch(200, { professional: PROFESSIONAL });
    const ok = await submitProfessional({ name: 'Ana', serviceIds: [] }, { mode: 'update', id: ID, fetchFn });
    assert.equal(ok.ok, true);
    assert.equal(fetchFn.calls[0].url, `/api/professionals/${ID}`);
    assert.equal(fetchFn.calls[0].init.method, 'PATCH');
    for (const id of ['../x', 'abc', undefined, `${ID}/photo`]) {
      const result = await submitProfessional({ name: 'Ana', serviceIds: [] }, { mode: 'update', id, fetchFn });
      assert.equal(result.status, 404);
    }
    assert.equal(fetchFn.calls.length, 1);
  });

  test('409 BUSINESS_REQUIRED -> /onboarding; 401 -> /login; 500 -> mensagem genérica', async () => {
    const values = { name: 'Ana', serviceIds: [] };
    const none = await submitProfessional(values, {
      mode: 'create',
      fetchFn: fakeFetch(409, { error: { code: 'BUSINESS_REQUIRED', message: M.businessRequired } }),
    });
    assert.equal(none.redirectTo, '/onboarding');
    const unauth = await submitProfessional(values, {
      mode: 'create',
      fetchFn: fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    });
    assert.equal(unauth.redirectTo, '/login');
    const server = await submitProfessional(values, {
      mode: 'create',
      fetchFn: fakeFetch(500, { error: { code: 'INTERNAL_ERROR', message: 'detalhe' } }),
    });
    assert.equal(server.message, GENERIC_ERROR_MESSAGE);
  });

  test('400 do servidor devolve fields', async () => {
    const result = await submitProfessional({ name: 'Ana', serviceIds: [S1] }, {
      mode: 'create',
      fetchFn: fakeFetch(400, {
        error: { code: 'VALIDATION_ERROR', message: 'Verifique', fields: { serviceIds: M.serviceIdsInvalid } },
      }),
    });
    assert.deepEqual(result.fields, { serviceIds: M.serviceIdsInvalid });
  });
});

describe('loadProfessionals e loadServiceOptions (critérios 2, 30)', () => {
  test('GET /api/professionals devolve a lista; 401 -> /login', async () => {
    const fetchFn = fakeFetch(200, { professionals: [PROFESSIONAL] });
    assert.deepEqual(await loadProfessionals({ fetchFn }), { ok: true, professionals: [PROFESSIONAL] });
    assert.equal(fetchFn.calls[0].url, '/api/professionals');
    const unauth = await loadProfessionals({ fetchFn: fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }) });
    assert.equal(unauth.redirectTo, '/login');
    const none = await loadProfessionals({
      fetchFn: fakeFetch(409, { error: { code: 'BUSINESS_REQUIRED', message: M.businessRequired } }),
    });
    assert.equal(none.redirectTo, '/onboarding');
  });

  test('loadServiceOptions pede status=all; lista vazia dá hasActive false', async () => {
    const fetchFn = fakeFetch(200, { services: [] });
    assert.deepEqual(await loadServiceOptions({ fetchFn }), { ok: true, services: [], hasActive: false });
    assert.equal(fetchFn.calls[0].url, '/api/services?status=all');
    const onlyInactive = await loadServiceOptions({
      fetchFn: fakeFetch(200, { services: [{ id: S1, name: 'Corte', active: false }] }),
    });
    assert.equal(onlyInactive.hasActive, false);
    const some = await loadServiceOptions({ fetchFn: fakeFetch(200, { services: [{ id: S1, name: 'Corte', active: true }] }) });
    assert.equal(some.hasActive, true);
  });
});

describe('removeProfessional (critérios 17, 29)', () => {
  test('204 -> ok; DELETE na URL certa', async () => {
    const fetchFn = fakeFetch(204);
    assert.deepEqual(await removeProfessional(ID, { fetchFn }), { ok: true });
    assert.equal(fetchFn.calls[0].url, `/api/professionals/${ID}`);
    assert.equal(fetchFn.calls[0].init.method, 'DELETE');
  });

  test('409 devolve blocked, count e a mensagem de bloqueio', async () => {
    const result = await removeProfessional(ID, {
      fetchFn: fakeFetch(409, {
        error: { code: 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS', message: M.hasFutureAppointments, futureAppointmentsCount: 3 },
      }),
    });
    assert.deepEqual(result, { ok: false, status: 409, blocked: true, count: 3, message: removalBlockedMessage(3) });
  });

  test('404 devolve alreadyRemoved; id inválido não chama fetchFn', async () => {
    const result = await removeProfessional(ID, {
      fetchFn: fakeFetch(404, { error: { code: 'PROFESSIONAL_NOT_FOUND', message: M.notFound } }),
    });
    assert.deepEqual(result, { ok: true, alreadyRemoved: true });
    const fetchFn = fakeFetch(204);
    assert.equal((await removeProfessional('../x', { fetchFn })).ok, false);
    assert.equal(fetchFn.calls.length, 0);
  });

  test('removalBlockedMessage: singular e plural com orientação', () => {
    assert.equal(
      removalBlockedMessage(1),
      'Este profissional tem 1 agendamento futuro. Realoque ou cancele esses agendamentos antes de remover.',
    );
    assert.match(removalBlockedMessage(3), /^Este profissional tem 3 agendamentos futuros\. Realoque ou cancele/);
  });
});

describe('foto (critérios 11, 13, 14)', () => {
  test('3 MB ou image/gif não chamam fetchFn', async () => {
    const fetchFn = fakeFetch(200, { professional: PROFESSIONAL });
    const big = await uploadPhoto(ID, { size: 3 * 1024 * 1024, type: 'image/png' }, { fetchFn });
    assert.deepEqual(big, { ok: false, message: M.photoTooLarge });
    const gif = await uploadPhoto(ID, { size: 10, type: 'image/gif' }, { fetchFn });
    assert.equal(gif.ok, false);
    const badId = await uploadPhoto('x', { size: 10, type: 'image/png' }, { fetchFn });
    assert.equal(badId.status, 404);
    assert.equal(fetchFn.calls.length, 0);
  });

  test('PUT binário na URL certa', async () => {
    const fetchFn = fakeFetch(200, { professional: { ...PROFESSIONAL, photoUrl: `/media/professionals/${S1}.png` } });
    const file = { size: 10, type: 'image/jpeg' };
    const result = await uploadPhoto(ID, file, { fetchFn });
    assert.equal(result.ok, true);
    assert.equal(fetchFn.calls[0].url, `/api/professionals/${ID}/photo`);
    assert.equal(fetchFn.calls[0].init.method, 'PUT');
    assert.equal(fetchFn.calls[0].init.body, file);
    assert.equal(fetchFn.calls[0].init.headers['Content-Type'], 'application/octet-stream');
  });

  test('503 IMAGE_BUSY repassa a mensagem do servidor', async () => {
    const message = 'Muitas imagens sendo processadas agora. Tente novamente em instantes.';
    const result = await uploadPhoto(ID, { size: 10, type: 'image/png' }, {
      fetchFn: fakeFetch(503, { error: { code: 'IMAGE_BUSY', message } }),
    });
    assert.deepEqual(result, { ok: false, status: 503, message });
  });

  test('removePhoto: DELETE /photo', async () => {
    const fetchFn = fakeFetch(204);
    assert.deepEqual(await removePhoto(ID, { fetchFn }), { ok: true });
    assert.equal(fetchFn.calls[0].url, `/api/professionals/${ID}/photo`);
    assert.equal(fetchFn.calls[0].init.method, 'DELETE');
  });

  test('safePhotoUrl aceita só /media/professionals/<uuid>.png', () => {
    assert.equal(safePhotoUrl(`/media/professionals/${S1}.png`), `/media/professionals/${S1}.png`);
    for (const url of [
      'javascript:alert(1)',
      `//evil.example/media/professionals/${S1}.png`,
      `/media/logos/${S1}.png`,
      `/media/professionals/../logos/${S1}.png`,
      `https://evil.example/media/professionals/${S1}.png`,
      null,
      undefined,
    ]) {
      assert.equal(safePhotoUrl(url), null, String(url));
    }
  });
});

describe('serviceChoices e describeProfessional (critérios 8, 21, 28)', () => {
  const services = [
    { id: S1, name: 'Corte', active: true },
    { id: S2, name: 'Coloração', active: false },
    { id: ID, name: 'Barba', active: false },
  ];

  test('esconde desativado não vinculado e mostra desativado vinculado com "(inativo)"', () => {
    assert.deepEqual(serviceChoices(services, []).map((c) => c.label), ['Corte']);
    const choices = serviceChoices(services, [{ id: S2 }]);
    assert.deepEqual(
      choices.map((c) => [c.label, c.checked]),
      [
        ['Corte', false],
        ['Coloração (inativo)', true],
      ],
    );
    assert.deepEqual(serviceChoices(services, [S1]).map((c) => c.checked), [true]);
  });

  test('describeProfessional: serviços por vírgula e selo de não agendável', () => {
    assert.deepEqual(
      describeProfessional({
        services: [
          { name: 'Corte', active: true },
          { name: 'Coloração', active: false },
        ],
        bookable: true,
      }),
      { servicesLabel: 'Corte, Coloração (inativo)', bookableLabel: null },
    );
    assert.deepEqual(describeProfessional({ services: [], bookable: false }), {
      servicesLabel: 'Nenhum serviço',
      bookableLabel: 'Não aparece para clientes',
    });
  });
});
