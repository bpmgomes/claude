import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../../web/js/api.js';

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

test("requestJson usa credentials 'same-origin' por padrão (telas do dono)", async () => {
  const fetchFn = fakeFetch();
  await requestJson('/api/business', { fetchFn });
  assert.equal(fetchFn.calls[0].init.credentials, 'same-origin');
});

test("requestJson repassa credentials 'omit' quando pedido (JS público, AF-10 item 5)", async () => {
  const fetchFn = fakeFetch();
  const res = await requestJson('/api/public/x/availability', { fetchFn, credentials: 'omit' });
  assert.equal(res.ok, true);
  assert.equal(fetchFn.calls[0].init.credentials, 'omit');
  assert.equal(fetchFn.calls[0].init.method, 'GET');
  assert.equal(fetchFn.calls[0].init.headers.Accept, 'application/json');
});

test('com corpo e omit: JSON e Content-Type continuam', async () => {
  const fetchFn = fakeFetch();
  await requestJson('/api/x', { method: 'POST', body: { a: 1 }, fetchFn, credentials: 'omit' });
  const { init } = fetchFn.calls[0];
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, '{"a":1}');
});

test('requestJson repassa headers (Idempotency-Key do AF-11) depois de Accept e Content-Type', async () => {
  const fetchFn = fakeFetch();
  await requestJson('/api/x', {
    method: 'POST',
    body: { a: 1 },
    fetchFn,
    credentials: 'omit',
    headers: { 'Idempotency-Key': '3b241101-e2bb-4255-8caf-4136c566a962' },
  });
  const { init } = fetchFn.calls[0];
  assert.equal(init.headers['Idempotency-Key'], '3b241101-e2bb-4255-8caf-4136c566a962');
  assert.equal(init.headers.Accept, 'application/json');
  assert.equal(init.headers['Content-Type'], 'application/json');
});

test('requestJson não copia valor não string (Content-Type continua JSON)', async () => {
  const fetchFn = fakeFetch();
  await requestJson('/api/x', {
    method: 'POST',
    body: {},
    fetchFn,
    headers: { 'Content-Type': 42, 'X-Obj': { a: 1 }, 'X-Null': null },
  });
  const { headers } = fetchFn.calls[0].init;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal('X-Obj' in headers, false);
  assert.equal('X-Null' in headers, false);
});
