import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteGuards, createPublicRouteGuards, authOnly } from '../../src/http/route-guards.js';
import { rateLimitKey } from '../../src/http/ip-key.js';
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

describe('createPublicRouteGuards (AF-09, critério 19)', () => {
  const PUBLIC = { rateLimit: { enabled: true, timeWindow: '1 minute', publicPage: { perIp: 120 } } };

  test('sem requireAuth, com publicRoute, limite por IP e keyGenerator /64', () => {
    const guards = createPublicRouteGuards(PUBLIC, 'publicPage');
    assert.deepEqual(guards.onRequest, []);
    assert.equal(guards.onRequest.includes(requireAuth), false);
    assert.equal(guards.config.publicRoute, true);
    assert.equal(guards.config.rateLimit.max, 120);
    assert.equal(guards.config.rateLimit.timeWindow, '1 minute');
    const key = guards.config.rateLimit.keyGenerator;
    assert.equal(typeof key, 'function');
    assert.equal(key({ ip: '2001:db8::1' }), rateLimitKey('2001:db8::2'));
    assert.equal(key({ ip: '10.0.0.1' }), '10.0.0.1');
  });

  test('objetos novos a cada chamada e não congelados', () => {
    const a = createPublicRouteGuards(PUBLIC, 'publicPage');
    const b = createPublicRouteGuards(PUBLIC, 'publicPage');
    assert.notEqual(a.onRequest, b.onRequest);
    assert.notEqual(a.config, b.config);
    assert.notEqual(a.config.rateLimit, b.config.rateLimit);
    assert.equal(Object.isFrozen(a.onRequest), false);
    a.onRequest.push(() => {});
    assert.equal(b.onRequest.length, 0);
  });

  test('com enabled=false: só publicRoute, sem rateLimit', () => {
    const guards = createPublicRouteGuards({ rateLimit: { ...PUBLIC.rateLimit, enabled: false } }, 'publicPage');
    assert.deepEqual(guards, { onRequest: [], config: { publicRoute: true } });
  });

  test('bucket desconhecido lança', () => {
    assert.throws(() => createPublicRouteGuards(PUBLIC, 'naoExiste'), /Bucket/);
  });
});
