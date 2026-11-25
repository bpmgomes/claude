import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, mergeConfig, parseTrustProxy } from '../../src/config.js';

describe('loadConfig', () => {
  test('cookieSecure é true sem env (critério 1)', () => {
    assert.equal(loadConfig({}).cookieSecure, true);
    assert.equal(loadConfig({ NODE_ENV: 'production' }).cookieSecure, true);
  });

  test('COOKIE_SECURE=false com NODE_ENV=development dá false', () => {
    assert.equal(loadConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }).cookieSecure, false);
  });

  test('COOKIE_SECURE=false com NODE_ENV=production lança erro', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  });

  test('COOKIE_SECURE=false com NODE_ENV=test dá false (AF-02 item 6)', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test', COOKIE_SECURE: 'false' }).cookieSecure, false);
  });

  for (const nodeEnv of [undefined, '', 'production', 'Production', 'prod', 'staging', 'Development', ' development']) {
    test(`COOKIE_SECURE=false com NODE_ENV=${JSON.stringify(nodeEnv)} lança erro (AF-02 item 6)`, () => {
      const env = { COOKIE_SECURE: 'false' };
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      assert.throws(() => loadConfig(env), /COOKIE_SECURE/);
    });
  }

  test('COOKIE_SECURE=true é aceito em qualquer ambiente', () => {
    assert.equal(loadConfig({ NODE_ENV: 'staging', COOKIE_SECURE: 'true' }).cookieSecure, true);
  });

  test('PUBLIC_BASE_URL sem barra final; padrão usa a porta', () => {
    assert.equal(loadConfig({ PUBLIC_BASE_URL: 'https://agendafacil.app/' }).publicBaseUrl, 'https://agendafacil.app');
    assert.equal(loadConfig({ PUBLIC_BASE_URL: 'https://agendafacil.app//' }).publicBaseUrl, 'https://agendafacil.app');
    assert.equal(loadConfig({}).publicBaseUrl, 'http://localhost:3000');
    assert.equal(loadConfig({ PORT: '8080' }).publicBaseUrl, 'http://localhost:8080');
  });

  test('UPLOADS_DIR', () => {
    assert.equal(loadConfig({}).uploadsDir, './data/uploads');
    assert.equal(loadConfig({ UPLOADS_DIR: '/srv/uploads' }).uploadsDir, '/srv/uploads');
  });

  test('rate limits do AF-05', () => {
    const c = loadConfig({});
    assert.deepEqual(c.rateLimit.businessWrite, { perUser: 30, perIp: 60 });
    assert.deepEqual(c.rateLimit.logoUpload, { perUser: 10, perIp: 20 });
  });

  test('padrões do AF-02 (critério 22)', () => {
    const c = loadConfig({});
    assert.equal(c.trustProxy, false);
    assert.equal(c.sessionTtlDays, 7);
    assert.equal(c.sessionAbsoluteTtlDays, 30);
    assert.equal(c.sessionTouchIntervalSeconds, 60);
    assert.deepEqual(c.loginLock, { maxFailures: 5, lockMinutes: 15 });
    assert.equal(c.rateLimit.loginMax, 20);
    assert.deepEqual(c.allowedOrigins, []);
  });

  test('TRUST_PROXY e ALLOWED_ORIGINS vêm do ambiente', () => {
    const c = loadConfig({ TRUST_PROXY: '1', ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
    assert.equal(c.trustProxy, 1);
    assert.deepEqual(c.allowedOrigins, ['https://a.example', 'https://b.example']);
  });
});

describe('parseTrustProxy', () => {
  test('ausente, vazio, false e 0 dão false', () => {
    for (const v of [undefined, '', '  ', 'false', 'FALSE', '0']) assert.equal(parseTrustProxy(v), false, v);
  });
  test("'true' dá true", () => {
    assert.equal(parseTrustProxy('true'), true);
  });
  test("'1' dá 1 e '2' dá 2", () => {
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('2'), 2);
  });
  test('lista de IPs/CIDRs vira array', () => {
    assert.deepEqual(parseTrustProxy('10.0.0.0/8,127.0.0.1'), ['10.0.0.0/8', '127.0.0.1']);
  });
});

describe('mergeConfig', () => {
  test('mescla loginLock e rateLimit e descarta now, logStream e storage', () => {
    const merged = mergeConfig(loadConfig({}), {
      loginLock: { maxFailures: 3 },
      rateLimit: { loginMax: 2 },
      now: () => new Date(),
      logStream: {},
      storage: {},
    });
    assert.equal('storage' in merged, false);
    assert.deepEqual(merged.rateLimit.logoUpload, { perUser: 10, perIp: 20 });
    assert.deepEqual(merged.loginLock, { maxFailures: 3, lockMinutes: 15 });
    assert.equal(merged.rateLimit.loginMax, 2);
    assert.equal(merged.rateLimit.signupMax, 10);
    assert.equal('now' in merged, false);
    assert.equal('logStream' in merged, false);
  });
});
