import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  mergeConfig,
  parseTrustProxy,
  resolveConflictsTokenSecret,
  DEV_TEST_ENVS,
  COOKIE_INSECURE_ENVS,
} from '../../src/config.js';

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

  test('padrões do AF-07: buckets de profissionais e imageProcessing', () => {
    const c = loadConfig({});
    assert.deepEqual(c.rateLimit.professionalWrite, { perUser: 30, perIp: 60 });
    assert.deepEqual(c.rateLimit.professionalPhoto, { perUser: 10, perIp: 20 });
    assert.deepEqual(c.rateLimit.hoursWrite, { perUser: 30, perIp: 60 });
    assert.deepEqual(c.rateLimit.timeBlockWrite, { perUser: 30, perIp: 60 });
    assert.deepEqual(c.rateLimit.timeBlockRead, { perUser: 60, perIp: 120 });
    assert.deepEqual(c.imageProcessing, { concurrency: 2, queueMax: 4, queueTimeoutMs: 10000 });
  });

  test('padrões do AF-09: publicPage e publicMedia só por IP', () => {
    const c = loadConfig({});
    assert.deepEqual(c.rateLimit.publicPage, { perIp: 120 });
    assert.deepEqual(c.rateLimit.publicMedia, { perIp: 600 });
    const merged = mergeConfig(c, { rateLimit: { publicPage: { perIp: 2 } } });
    assert.deepEqual(merged.rateLimit.publicPage, { perIp: 2 });
    assert.deepEqual(merged.rateLimit.publicMedia, { perIp: 600 });
  });

  test('padrão do AF-10: teto de custo publicAvailability só por IP, sem alterar publicPage', () => {
    const c = loadConfig({});
    assert.deepEqual(c.rateLimit.publicAvailability, { perIp: 30 });
    assert.deepEqual(c.rateLimit.publicPage, { perIp: 120 });
    assert.ok(c.rateLimit.publicAvailability.perIp < c.rateLimit.publicPage.perIp);
    assert.equal(Object.isFrozen(c.rateLimit.publicAvailability), true);
    const merged = mergeConfig(c, { rateLimit: { publicAvailability: { perIp: 2 } } });
    assert.deepEqual(merged.rateLimit.publicAvailability, { perIp: 2 });
    assert.deepEqual(merged.rateLimit.publicPage, { perIp: 120 });
  });

  test('padrão do contador de URL malformada (AF-09 item 1): malformedUrl só por IP', () => {
    assert.deepEqual(loadConfig({}).rateLimit.malformedUrl, { perIp: 120 });
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

  test('merge raso de imageProcessing e descarte de imageLimiter (AF-07)', () => {
    const merged = mergeConfig(loadConfig({}), {
      imageProcessing: { concurrency: 1, queueMax: 0 },
      imageLimiter: { run: () => {} },
    });
    assert.deepEqual(merged.imageProcessing, { concurrency: 1, queueMax: 0, queueTimeoutMs: 10000 });
    assert.equal('imageLimiter' in merged, false);
    assert.deepEqual(mergeConfig(loadConfig({}), {}).imageProcessing, {
      concurrency: 2,
      queueMax: 4,
      queueTimeoutMs: 10000,
    });
  });
});

describe('AF-11: publicBooking, CONFLICTS_TOKEN_SECRET e appointmentEvents', () => {
  test('padrão de rateLimit.publicBooking: 10 por minuto por IP', () => {
    assert.deepEqual(loadConfig({}).rateLimit.publicBooking, { perIp: 10 });
  });

  test('loadConfig({}) e loadConfig({ NODE_ENV: "production" }) não lançam por causa do segredo', () => {
    assert.equal(loadConfig({}).conflictsTokenSecret, null);
    assert.equal(loadConfig({}).nodeEnv, null);
    assert.equal(loadConfig({ NODE_ENV: 'production' }).nodeEnv, 'production');
    assert.equal(loadConfig({ CONFLICTS_TOKEN_SECRET: 'x'.repeat(40) }).conflictsTokenSecret, 'x'.repeat(40));
  });

  test('resolveConflictsTokenSecret: 32 caracteres aceito; 31 lança sem ecoar o valor', () => {
    assert.deepEqual(resolveConflictsTokenSecret({ conflictsTokenSecret: 'a'.repeat(32), nodeEnv: 'production' }), {
      secret: 'a'.repeat(32),
      generated: false,
    });
    const short = 'segredo-curto-0123456789abcdefg';
    assert.equal(short.length, 31);
    assert.throws(
      () => resolveConflictsTokenSecret({ conflictsTokenSecret: short, nodeEnv: 'development' }),
      (err) => /pelo menos 32/.test(err.message) && !err.message.includes(short),
    );
  });

  test('ausente com development/test gera 43 caracteres, generated: true, e dois resultados diferentes', () => {
    for (const nodeEnv of DEV_TEST_ENVS) {
      const a = resolveConflictsTokenSecret({ conflictsTokenSecret: null, nodeEnv });
      const b = resolveConflictsTokenSecret({ conflictsTokenSecret: null, nodeEnv });
      assert.equal(a.generated, true);
      assert.equal(a.secret.length, 43);
      assert.notEqual(a.secret, b.secret);
    }
    assert.equal(COOKIE_INSECURE_ENVS, DEV_TEST_ENVS);
  });

  for (const nodeEnv of ['production', 'staging', 'Production', null, undefined, ' test']) {
    test(`ausente com NODE_ENV=${JSON.stringify(nodeEnv)} lança`, () => {
      assert.throws(() => resolveConflictsTokenSecret({ conflictsTokenSecret: null, nodeEnv }), /CONFLICTS_TOKEN_SECRET é obrigatório/);
      assert.throws(() => resolveConflictsTokenSecret(loadConfig(nodeEnv ? { NODE_ENV: nodeEnv } : {})), /obrigatório/);
    });
  }

  test('mergeConfig descarta appointmentEvents', () => {
    const merged = mergeConfig(loadConfig({}), { appointmentEvents: { confirmed: async () => {} } });
    assert.equal('appointmentEvents' in merged, false);
  });

  test('buildApp sem segredo fora de development/test não sobe; o segredo não fica em app.config', async () => {
    const { buildApp } = await import('../../src/app.js');
    await assert.rejects(buildApp({ databasePath: ':memory:', conflictsTokenSecret: null, nodeEnv: 'production' }), /obrigatório/);
    const app = await buildApp({ databasePath: ':memory:', conflictsTokenSecret: 'z'.repeat(40), logLevel: 'silent' });
    try {
      assert.equal('conflictsTokenSecret' in app.config, false);
      assert.equal(JSON.stringify(app.config).includes('z'.repeat(40)), false);
    } finally {
      await app.close();
    }
  });
});

test('AF-12: padrão de rateLimit.publicManage: 30 por minuto por IP; publicBooking continua 10', () => {
  assert.deepEqual(loadConfig({}).rateLimit.publicManage, { perIp: 30 });
  assert.deepEqual(loadConfig({}).rateLimit.publicBooking, { perIp: 10 });
});

describe('AF-18: configuração de e-mail (critérios 24 e 25)', () => {
  const MARK = 'marcador-unico-xyz-123';
  const load = async () => (await import('../../src/config.js')).resolveEmailConfig;
  const base = (env) => loadConfig(env);
  const SMTP_OK = { NODE_ENV: 'production', EMAIL_TRANSPORT: 'smtp', EMAIL_FROM: 'nao-responda@agendafacil.app', SMTP_HOST: 'smtp.example.com', PUBLIC_BASE_URL: 'https://agendafacil.app' };

  test('loadConfig lê as variáveis sem lançar, inclusive valores inválidos; a senha fica na raiz', () => {
    const c = loadConfig({
      EMAIL_TRANSPORT: 'pombo', EMAIL_FROM: 'x\r\ny', EMAIL_FROM_NAME: 'A\nB', SMTP_HOST: 'http://x', SMTP_PORT: 'abc',
      SMTP_SECURE: 'true', SMTP_USER: 'u', SMTP_PASSWORD: MARK, EMAIL_WORKER_ENABLED: 'false', EMAIL_WORKER_INTERVAL_MS: '5',
      EMAIL_FILE_DIR: '/tmp/emails',
    });
    assert.equal(c.email.transport, 'pombo');
    assert.ok(Number.isNaN(c.email.smtp.port));
    assert.equal(c.email.smtp.secure, true);
    assert.equal(c.email.worker.enabled, false);
    assert.equal(c.email.worker.intervalMs, 5);
    assert.equal(c.smtpPassword, MARK);
    assert.equal(JSON.stringify(c.email).includes(MARK), false);
    const d = loadConfig({});
    assert.equal(d.email.transport, null);
    assert.equal(d.email.fromName, 'AgendaFácil');
    assert.equal(d.email.fileDir, './data/emails');
    assert.deepEqual(d.email.worker, { enabled: true, intervalMs: 15000 });
    assert.equal(d.smtpPassword, null);
  });

  test('padrão por ambiente: development=file, test=memory, outros=none; injected ativo', async () => {
    const resolve = await load();
    assert.equal(resolve(base({ NODE_ENV: 'development' })).transport, 'file');
    assert.equal(resolve(base({ NODE_ENV: 'test' })).transport, 'memory');
    for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'staging' }]) {
      const r = resolve(base(env));
      assert.equal(r.transport, 'none');
      assert.equal(r.enabled, false);
    }
    const inj = resolve(base({ NODE_ENV: 'production' }), { injected: true });
    assert.equal(inj.transport, 'injected');
    assert.equal(inj.enabled, true);
    assert.equal(resolve(base({ EMAIL_WORKER_ENABLED: 'false' }), { injected: true }).enabled, false);
    assert.deepEqual(inj.from, { name: 'AgendaFácil', address: 'nao-responda@agendafacil.invalid' });
    assert.equal(inj.messageIdDomain, 'agendafacil.invalid');
  });

  test('cópia de DEV_TEST_ENVS no módulo de e-mail é igual à de config.js', async () => {
    const { EMAIL_DEV_TEST_ENVS } = await import('../../src/modules/email/email-config.js');
    assert.deepEqual([...EMAIL_DEV_TEST_ENVS], [...DEV_TEST_ENVS]);
  });

  test('smtp válido; porta padrão 587/465; usuário e senha juntos', async () => {
    const resolve = await load();
    const r = resolve(base(SMTP_OK));
    assert.deepEqual(r.smtp, { host: 'smtp.example.com', port: 587, secure: false, user: null });
    assert.equal(r.requireHttps, true);
    assert.equal(r.messageIdDomain, 'agendafacil.app');
    assert.equal(resolve(base({ ...SMTP_OK, SMTP_SECURE: 'true' })).smtp.port, 465);
    assert.equal(resolve(base({ ...SMTP_OK, SMTP_USER: 'u', SMTP_PASSWORD: MARK })).smtp.user, 'u');
    assert.equal(JSON.stringify(resolve(base({ ...SMTP_OK, SMTP_USER: 'u', SMTP_PASSWORD: MARK }))).includes(MARK), false);
  });

  test('toda a tabela de recusas, com mensagens fixas sem o valor recebido', async () => {
    const resolve = await load();
    const cases = [
      [{ EMAIL_TRANSPORT: `pombo-${MARK}` }, /EMAIL_TRANSPORT inválido/],
      [{ NODE_ENV: 'production', EMAIL_TRANSPORT: 'memory' }, /memory e file só são permitidos/],
      [{ NODE_ENV: 'production', EMAIL_TRANSPORT: 'file' }, /memory e file só são permitidos/],
      [{ EMAIL_TRANSPORT: 'memory' }, /memory e file só são permitidos/],
      [{ ...SMTP_OK, EMAIL_FROM: undefined }, /EMAIL_FROM é obrigatório/],
      [{ ...SMTP_OK, EMAIL_FROM: `${MARK}\r\n@x.com` }, /EMAIL_FROM é obrigatório/],
      [{ NODE_ENV: 'test', EMAIL_TRANSPORT: 'memory', EMAIL_FROM: `${MARK}%@x.com` }, /EMAIL_FROM precisa ser/],
      [{ ...SMTP_OK, SMTP_HOST: undefined }, /SMTP_HOST e SMTP_PORT/],
      [{ ...SMTP_OK, SMTP_HOST: `smtp://${MARK}` }, /SMTP_HOST e SMTP_PORT/],
      [{ ...SMTP_OK, SMTP_PORT: '0' }, /SMTP_HOST e SMTP_PORT/],
      [{ ...SMTP_OK, SMTP_PORT: '65536' }, /SMTP_HOST e SMTP_PORT/],
      [{ ...SMTP_OK, SMTP_PORT: `25${MARK}` }, /SMTP_HOST e SMTP_PORT/],
      [{ ...SMTP_OK, SMTP_USER: 'u' }, /juntos/],
      [{ ...SMTP_OK, SMTP_PASSWORD: MARK }, /juntos/],
      [{ ...SMTP_OK, PUBLIC_BASE_URL: 'http://agendafacil.app' }, /https/],
      [{ EMAIL_FROM_NAME: `${MARK}\r\nBcc: x` }, /EMAIL_FROM_NAME inválido/],
      [{ EMAIL_FROM_NAME: 'x'.repeat(65) }, /EMAIL_FROM_NAME inválido/],
      [{ EMAIL_WORKER_INTERVAL_MS: '99' }, /EMAIL_WORKER_INTERVAL_MS/],
      [{ EMAIL_WORKER_INTERVAL_MS: '3600001' }, /EMAIL_WORKER_INTERVAL_MS/],
      [{ NODE_ENV: 'development', EMAIL_TRANSPORT: 'file', EMAIL_FILE_DIR: './web' }, /EMAIL_FILE_DIR/],
    ];
    for (const [env, re] of cases) {
      assert.throws(() => resolve(base(env), { injected: false }), (err) => re.test(err.message) && !err.message.includes(MARK), JSON.stringify(env));
    }
    // smtp em development aceita http (link só https fora de dev/test)
    assert.equal(resolve(base({ ...SMTP_OK, NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:3000' })).requireHttps, false);
  });

  test('mergeConfig: email raso e mailTransport descartado (não é congelado)', () => {
    const transport = { send: async () => ({}) };
    const merged = mergeConfig(loadConfig({}), { mailTransport: transport, email: { worker: { enabled: false, intervalMs: 200 } } });
    assert.equal('mailTransport' in merged, false);
    assert.equal(Object.isFrozen(transport), false);
    assert.deepEqual(merged.email.worker, { enabled: false, intervalMs: 200 });
    assert.equal(merged.email.fromName, 'AgendaFácil');
  });

  test('buildApp: sem smtpPassword nem o valor em app.config; e-mail resolvido em app.config.email', async () => {
    const { buildApp } = await import('../../src/app.js');
    const { createMemoryMailTransport } = await import('../../src/modules/email/transports/memory.js');
    const app = await buildApp({
      databasePath: ':memory:', conflictsTokenSecret: 'z'.repeat(40), logLevel: 'silent', smtpPassword: MARK,
      mailTransport: createMemoryMailTransport(),
    });
    try {
      assert.equal('smtpPassword' in app.config, false);
      assert.equal(JSON.stringify(app.config).includes(MARK), false);
      assert.equal(app.config.email.transport, 'injected');
      assert.ok(Object.isFrozen(app.config.email));
    } finally {
      await app.close();
    }
  });
});
