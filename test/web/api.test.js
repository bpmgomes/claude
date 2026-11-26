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
