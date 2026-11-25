import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { loadConfig, mergeConfig } from './config.js';
import { errorHandler } from './http/errors.js';
import { createDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createUsersRepository } from './modules/accounts/users.repository.js';
import { createSessionsRepository } from './modules/auth/sessions.repository.js';
import { createSessionsService } from './modules/auth/sessions.service.js';
import { createAccountsService } from './modules/accounts/accounts.service.js';
import { createLoginAttemptsRepository } from './modules/auth/login-attempts.repository.js';
import { createLoginAttemptsService } from './modules/auth/login-attempts.service.js';
import { createAuthService } from './modules/auth/auth.service.js';
import authPlugin from './modules/auth/auth.plugin.js';
import csrfPlugin from './http/csrf.js';
import accountsRoutes from './modules/accounts/accounts.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import { createBusinessesRepository } from './modules/businesses/businesses.repository.js';
import { createBusinessesService } from './modules/businesses/businesses.service.js';
import businessesRoutes from './modules/businesses/businesses.routes.js';
import { createServicesRepository } from './modules/services/services.repository.js';
import { createServicesService } from './modules/services/services.service.js';
import servicesRoutes from './modules/services/services.routes.js';
import { createStorage } from './storage/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const REDACT_PATHS = [
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  'body.password',
];

/** Páginas HTML servidas pelo app. Todo caminho aqui precisa estar em RESERVED_SLUGS (teste). */
export const PAGES = Object.freeze({
  '/login': 'login.html',
  '/cadastro': 'cadastro.html',
  '/onboarding': 'onboarding.html',
  '/negocio': 'negocio.html',
  '/servicos': 'servicos.html',
});

/**
 * @param {object} [overrides] sobrescreve chaves de loadConfig(); aceita também `logStream`,
 *   `now` (relógio `() => Date`, padrão `() => new Date()`, repassado a todos os serviços)
 *   e `storage` (instância de `Storage`; padrão: disco local em `config.uploadsDir`)
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp(overrides = {}) {
  const config = mergeConfig(loadConfig(), overrides);
  const now = overrides.now || (() => new Date());

  const logger = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  if (overrides.logStream) logger.stream = overrides.logStream;

  const app = Fastify({ logger, bodyLimit: 16 * 1024, trustProxy: config.trustProxy });
  app.decorate('config', config);
  // A API só aceita JSON: o Fastify 5 traz parser de text/plain por padrão, e
  // removê-lo faz qualquer outro content-type responder 415 (mitigação de CSRF, R5).
  app.removeContentTypeParser('text/plain');

  const db = createDatabase(config);
  await runMigrations(db);
  app.addHook('onClose', async () => db.close());

  const usersRepository = createUsersRepository(db);
  const sessionsRepository = createSessionsRepository(db);
  const loginAttemptsRepository = createLoginAttemptsRepository(db);
  const sessionsService = createSessionsService({ sessionsRepository, config, now });
  const accountsService = createAccountsService({ db, usersRepository, sessionsService, config, now });
  const loginAttemptsService = createLoginAttemptsService({ db, loginAttemptsRepository, config, now });
  const storage = overrides.storage || createStorage(config);
  const businessesRepository = createBusinessesRepository(db);
  const businessesService = createBusinessesService({
    db,
    businessesRepository,
    storage,
    config,
    now,
    log: app.log,
  });
  const servicesRepository = createServicesRepository(db);
  // Sem `appointments`: usa a porta nula (noAppointments) até o AF-11.
  const servicesService = createServicesService({
    db,
    servicesRepository,
    businessesRepository,
    now,
    log: app.log,
  });
  const authService = createAuthService({
    db,
    usersRepository,
    sessionsService,
    loginAttemptsService,
    businessesRepository,
    config,
    now,
  });
  app.decorate('db', db);
  app.decorate('services', {
    usersRepository,
    sessionsRepository,
    sessionsService,
    accountsService,
    loginAttemptsRepository,
    loginAttemptsService,
    authService,
    storage,
    businessesRepository,
    businessesService,
    servicesRepository,
    servicesService,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  });
  await app.register(cookie);
  await app.register(csrfPlugin);
  if (config.rateLimit.enabled) {
    await app.register(rateLimit, { global: false });
  }
  await app.register(authPlugin);

  await app.register(fastifyStatic, { root: join(ROOT, 'web'), prefix: '/', index: false });
  await app.register(fastifyStatic, {
    root: join(ROOT, 'src', 'shared'),
    prefix: '/shared/',
    decorateReply: false,
  });

  app.get('/', (request, reply) => reply.redirect('/login', 302));
  for (const [path, file] of Object.entries(PAGES)) {
    app.get(path, (request, reply) => reply.sendFile(file));
  }

  await app.register(accountsRoutes);
  await app.register(authRoutes);
  await app.register(businessesRoutes);
  await app.register(servicesRoutes);

  await app.ready();
  return app;
}
