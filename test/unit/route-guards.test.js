import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteGuards, authOnly } from '../../src/http/route-guards.js';
import { requireAuth } from '../../src/modules/auth/auth.plugin.js';

const CONFIG = {
  rateLimit: { enabled: true, timeWindow: '1 minute', businessWrite: { perUser: 3, perIp: 7 } },
};

describe('createRouteGuards (AF-05 item 1, design AF-06 seção 2)', () => {
  test('duas chamadas devolvem arrays, limitadores e config diferentes', () => {
    const a = createRouteGuards(CONFIG, 'businessWrite');
    const b = createRouteGuards(CONFIG, 'businessWrite');
    assert.notEqual(a.onRequest, b.onRequest);
    assert.notEqual(a.onRequest[1], b.onRequest[1]);
    assert.notEqual(a.config, b.config);
    assert.notEqual(a.config.rateLimit, b.config.rateLimit);
    assert.equal(a.onRequest[0], requireAuth);
    assert.equal(typeof a.onRequest[1], 'function');
    assert.deepEqual(a.config, { rateLimit: { max: 7, timeWindow: '1 minute' } });
  });

  test('o limitador usa perUser do bucket e é independente entre chamadas', async () => {
    const a = createRouteGuards(CONFIG, 'businessWrite').onRequest[1];
    const b = createRouteGuards(CONFIG, 'businessWrite').onRequest[1];
    const request = { user: { id: 'u1' } };
    for (let i = 0; i < 3; i++) await a(request);
    await assert.rejects(a(request), (err) => err.statusCode === 429);
    await b(request); // contador próprio
  });

  test('com rateLimit.enabled=false, só requireAuth e config vazio', () => {
    const guards = createRouteGuards({ rateLimit: { ...CONFIG.rateLimit, enabled: false } }, 'businessWrite');
    assert.deepEqual(guards.onRequest, [requireAuth]);
    assert.deepEqual(guards.config, {});
    const other = createRouteGuards({ rateLimit: { enabled: false } }, 'businessWrite');
    assert.notEqual(guards.onRequest, other.onRequest);
  });

  test('o retorno não está congelado (o @fastify/rate-limit faz push no array)', () => {
    const guards = createRouteGuards(CONFIG, 'businessWrite');
    assert.equal(Object.isFrozen(guards), false);
    assert.equal(Object.isFrozen(guards.onRequest), false);
    assert.equal(Object.isFrozen(guards.config), false);
    guards.onRequest.push(() => {});
    assert.equal(guards.onRequest.length, 3);
  });

  test('bucket inexistente lança erro na montagem das rotas', () => {
    assert.throws(() => createRouteGuards(CONFIG, 'naoExiste'));
  });
});

describe('authOnly', () => {
  test('só requireAuth, array novo a cada chamada', () => {
    const a = authOnly();
    const b = authOnly();
    assert.deepEqual(a.onRequest, [requireAuth]);
    assert.notEqual(a.onRequest, b.onRequest);
    assert.equal(Object.isFrozen(a.onRequest), false);
  });
});
