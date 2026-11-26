import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRouteGuards,
  createPublicRouteGuards,
  authOnly,
  createSharedPublicLimiter,
  sharedPublicGuards,
} from '../../src/http/route-guards.js';
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

describe('createSharedPublicLimiter e sharedPublicGuards (AF-10, critério 25; AF-09 item 3)', () => {
  const SHARED = { rateLimit: { enabled: true, timeWindow: '1 minute', publicPage: { perIp: 2 } } };

  /** App falso: guarda as opções de createRateLimit e simula o contador. */
  function fakeApp() {
    const calls = [];
    return {
      calls,
      createRateLimit(options) {
        calls.push(options);
        let count = 0;
        return async (request) => {
          count += 1;
          return { isAllowed: false, isExceeded: count > options.max, max: options.max, remaining: Math.max(0, options.max - count), ttlInSeconds: 42, key: options.keyGenerator(request) };
        };
      },
    };
  }

  function fakeReply() {
    const headers = {};
    return { headers, header(name, value) { headers[name.toLowerCase()] = String(value); return this; } };
  }

  test('sem rate limit devolve null e não cria contador', () => {
    const app = fakeApp();
    assert.equal(createSharedPublicLimiter(app, { rateLimit: { ...SHARED.rateLimit, enabled: false } }, 'publicPage'), null);
    assert.equal(app.calls.length, 0);
  });

  test('um contador por chamada, com perIp, timeWindow e keyGenerator /64', () => {
    const app = fakeApp();
    createSharedPublicLimiter(app, SHARED, 'publicPage');
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].max, 2);
    assert.equal(app.calls[0].timeWindow, '1 minute');
    assert.equal(app.calls[0].keyGenerator({ ip: '2001:db8::1' }), rateLimitKey('2001:db8::1'));
  });

  test('o mesmo hook conta todas as chamadas; acima do limite lança 429 com Retry-After', async () => {
    const limiter = createSharedPublicLimiter(fakeApp(), SHARED, 'publicPage');
    const replies = [fakeReply(), fakeReply(), fakeReply()];
    await limiter({ ip: '10.0.0.1' }, replies[0]);
    await limiter({ ip: '10.0.0.1' }, replies[1]);
    await assert.rejects(limiter({ ip: '10.0.0.1' }, replies[2]), (err) => err.statusCode === 429);
    assert.equal(replies[0].headers['x-ratelimit-remaining'], '1');
    assert.equal(replies[2].headers['retry-after'], '42');
    assert.equal(replies[2].headers['x-ratelimit-remaining'], '0');
  });

  test('addHeaders: false não define x-ratelimit-*, mas o 429 mantém Retry-After', async () => {
    const limiter = createSharedPublicLimiter(fakeApp(), { rateLimit: { ...SHARED.rateLimit, publicPage: { perIp: 0 } } }, 'publicPage', { addHeaders: false });
    const reply = fakeReply();
    await assert.rejects(limiter({ ip: '10.0.0.1' }, reply), (err) => err.statusCode === 429);
    assert.deepEqual(reply.headers, { 'retry-after': '42' });
  });

  test('bucket desconhecido lança', () => {
    assert.throws(() => createSharedPublicLimiter(fakeApp(), SHARED, 'naoExiste'), /Bucket/);
  });

  test('sharedPublicGuards: publicRoute, arrays novos a cada chamada e nulos ignorados', () => {
    const a = async () => {};
    const b = async () => {};
    const first = sharedPublicGuards(a, null, b);
    const second = sharedPublicGuards(a, null, b);
    assert.deepEqual(first, { onRequest: [a, b], config: { publicRoute: true } });
    assert.notEqual(first.onRequest, second.onRequest);
    assert.notEqual(first.config, second.config);
    assert.deepEqual(sharedPublicGuards(null), { onRequest: [], config: { publicRoute: true } });
    assert.equal(Object.isFrozen(first.onRequest), false);
  });
});
