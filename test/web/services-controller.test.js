import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  loadServices,
  submitService,
  setServiceActive,
  describeService,
  deactivationNotice,
} = await import('../../web/js/services-controller.js');
const { SERVICE_MESSAGES: M } = await import('../../src/shared/services.js');
const { GENERIC_ERROR_MESSAGE } = await import('../../web/js/api.js');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SERVICE = {
  id: ID,
  name: 'Corte',
  durationMinutes: 90,
  priceCents: 5000,
  priceOnRequest: false,
  active: true,
};
const VALUES = { name: 'Corte', durationMinutes: '30', price: '50,00', priceOnRequest: false };

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

describe('submitService (critérios 6, 21)', () => {
  test('criação 201 devolve service; duração do select vira número', async () => {
    const fetchFn = fakeFetch(201, { service: SERVICE });
    const result = await submitService(VALUES, { mode: 'create', fetchFn });
    assert.deepEqual(result, { ok: true, service: SERVICE });
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].url, '/api/services');
    assert.equal(fetchFn.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), {
      name: 'Corte',
      durationMinutes: 30,
      priceOnRequest: false,
      price: '50,00',
    });
  });

  test('com sob consulta o corpo não tem price', async () => {
    const fetchFn = fakeFetch(201, { service: SERVICE });
    await submitService({ ...VALUES, price: '99', priceOnRequest: true }, { mode: 'create', fetchFn });
    const body = JSON.parse(fetchFn.calls[0].init.body);
    assert.equal('price' in body, false);
    assert.equal(body.priceOnRequest, true);
  });

  test('preço 50,555 ou duração vazia não chamam fetchFn e devolvem fields', async () => {
    const fetchFn = fakeFetch(201, { service: SERVICE });
    const price = await submitService({ ...VALUES, price: '50,555' }, { mode: 'create', fetchFn });
    assert.equal(price.ok, false);
    assert.deepEqual(price.fields, { price: M.priceDecimals });
    const duration = await submitService({ ...VALUES, durationMinutes: '' }, { mode: 'create', fetchFn });
    assert.deepEqual(duration.fields, { durationMinutes: M.durationRequired });
    assert.equal(fetchFn.calls.length, 0);
  });

  test('edição usa PATCH /api/services/:id', async () => {
    const fetchFn = fakeFetch(200, { service: SERVICE });
    const result = await submitService(VALUES, { mode: 'update', id: ID, fetchFn });
    assert.equal(result.ok, true);
    assert.equal(fetchFn.calls[0].url, `/api/services/${ID}`);
    assert.equal(fetchFn.calls[0].init.method, 'PATCH');
  });

  test('edição com id inválido não chama fetchFn', async () => {
    const fetchFn = fakeFetch(200, { service: SERVICE });
    for (const id of ['../x', 'abc', undefined, `${ID}/deactivate`]) {
      const result = await submitService(VALUES, { mode: 'update', id, fetchFn });
      assert.equal(result.ok, false);
      assert.equal(result.status, 404);
    }
    assert.equal(fetchFn.calls.length, 0);
  });

  test('409 SERVICE_NAME_TAKEN devolve fields.name', async () => {
    const fetchFn = fakeFetch(409, {
      error: { code: 'SERVICE_NAME_TAKEN', message: M.nameTaken, fields: { name: M.nameTaken } },
    });
    const result = await submitService(VALUES, { mode: 'create', fetchFn });
    assert.deepEqual(result, { ok: false, status: 409, fields: { name: M.nameTaken }, message: M.nameTaken });
  });

  test('409 BUSINESS_REQUIRED -> redirectTo /onboarding; 401 -> /login', async () => {
    const noBusiness = await submitService(VALUES, {
      mode: 'create',
      fetchFn: fakeFetch(409, { error: { code: 'BUSINESS_REQUIRED', message: M.businessRequired } }),
    });
    assert.equal(noBusiness.redirectTo, '/onboarding');
    const unauth = await submitService(VALUES, {
      mode: 'create',
      fetchFn: fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    });
    assert.equal(unauth.redirectTo, '/login');
  });

  test('500 e erro de rede -> mensagem genérica', async () => {
    const server = await submitService(VALUES, {
      mode: 'create',
      fetchFn: fakeFetch(500, { error: { code: 'INTERNAL_ERROR', message: 'detalhe' } }),
    });
    assert.equal(server.message, GENERIC_ERROR_MESSAGE);
    const network = await submitService(VALUES, {
      mode: 'create',
      fetchFn: async () => {
        throw new TypeError('offline');
      },
    });
    assert.equal(network.ok, false);
    assert.equal(network.message, GENERIC_ERROR_MESSAGE);
  });
});

describe('loadServices (critérios 2, 12)', () => {
  test('GET com status e devolve services', async () => {
    const fetchFn = fakeFetch(200, { services: [SERVICE] });
    const result = await loadServices('inactive', { fetchFn });
    assert.deepEqual(result, { ok: true, services: [SERVICE] });
    assert.equal(fetchFn.calls[0].url, '/api/services?status=inactive');
  });

  test('status ausente vira all; inválido não chama fetchFn', async () => {
    const fetchFn = fakeFetch(200, { services: [] });
    await loadServices(undefined, { fetchFn });
    assert.equal(fetchFn.calls[0].url, '/api/services?status=all');
    const bad = await loadServices('<x>', { fetchFn });
    assert.equal(bad.ok, false);
    assert.equal(fetchFn.calls.length, 1);
  });

  test('401 -> /login; 409 BUSINESS_REQUIRED -> /onboarding', async () => {
    const unauth = await loadServices('all', { fetchFn: fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }) });
    assert.deepEqual(unauth, { ok: false, status: 401, message: 'x', redirectTo: '/login' });
    const none = await loadServices('all', {
      fetchFn: fakeFetch(409, { error: { code: 'BUSINESS_REQUIRED', message: M.businessRequired } }),
    });
    assert.equal(none.redirectTo, '/onboarding');
  });
});

describe('setServiceActive (critérios 9, 10)', () => {
  test('deactivate chama a URL certa e repassa futureAppointmentsCount', async () => {
    const fetchFn = fakeFetch(200, { service: { ...SERVICE, active: false }, futureAppointmentsCount: 2 });
    const result = await setServiceActive(ID, false, { fetchFn });
    assert.equal(fetchFn.calls[0].url, `/api/services/${ID}/deactivate`);
    assert.equal(fetchFn.calls[0].init.method, 'POST');
    assert.equal(fetchFn.calls[0].init.body, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.futureAppointmentsCount, 2);
  });

  test('reactivate', async () => {
    const fetchFn = fakeFetch(200, { service: SERVICE });
    const result = await setServiceActive(ID, true, { fetchFn });
    assert.equal(fetchFn.calls[0].url, `/api/services/${ID}/reactivate`);
    assert.deepEqual(result, { ok: true, service: SERVICE });
  });

  test('id inválido não chama fetchFn', async () => {
    const fetchFn = fakeFetch(200, { service: SERVICE });
    const result = await setServiceActive('../../api/business', false, { fetchFn });
    assert.equal(result.ok, false);
    assert.equal(fetchFn.calls.length, 0);
  });
});

describe('exibição (critério 22)', () => {
  test('describeService', () => {
    assert.deepEqual(describeService(SERVICE), { durationLabel: '1 h 30 min', priceLabel: 'R$ 50,00', stateLabel: 'Ativo' });
    assert.deepEqual(describeService({ ...SERVICE, durationMinutes: 15, priceCents: null, priceOnRequest: true, active: false }), {
      durationLabel: '15 min',
      priceLabel: 'Sob consulta',
      stateLabel: 'Desativado',
    });
  });

  test('deactivationNotice', () => {
    assert.equal(deactivationNotice(0), null);
    assert.equal(deactivationNotice(1), '1 agendamento futuro continua marcado.');
    assert.equal(deactivationNotice(3), '3 agendamentos futuros continuam marcados.');
    assert.equal(typeof deactivationNotice(null), 'string');
  });
});
