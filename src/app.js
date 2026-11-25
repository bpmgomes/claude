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
import authPlugin from './modules/auth/auth.plugin.js';
import accountsRoutes from './modules/accounts/accounts.routes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const REDACT_PATHS = [
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  'body.password',
];

/**
 * @param {object} [overrides] sobrescreve chaves de loadConfig(); aceita também `logStream`
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp(overrides = {}) {
  const config = mergeConfig(loadConfig(), overrides);

  const logger = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  if (overrides.logStream) logger.stream = overrides.logStream;

  const app = Fastify({ logger, bodyLimit: 16 * 1024, trustProxy: false });
  app.decorate('config', config);
  // A API só aceita JSON: o Fastify 5 traz parser de text/plain por padrão, e
  // removê-lo faz qualquer outro content-type responder 415 (mitigação de CSRF, R5).
  app.removeContentTypeParser('text/plain');

  const db = createDatabase(config);
  await runMigrations(db);
  app.addHook('onClose', async () => db.close());

  const usersRepository = createUsersRepository(db);
  const sessionsRepository = createSessionsRepository(db);
  const sessionsService = createSessionsService({ sessionsRepository, config });
  const accountsService = createAccountsService({ db, usersRepository, sessionsService, config });
  app.decorate('db', db);
  app.decorate('services', { usersRepository, sessionsRepository, sessionsService, accountsService });

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

  app.get('/', (request, reply) => reply.redirect('/cadastro', 302));
  app.get('/cadastro', (request, reply) => reply.sendFile('cadastro.html'));
  app.get('/onboarding', (request, reply) => reply.sendFile('onboarding.html'));

  await app.register(accountsRoutes);

  await app.ready();
  return app;
}
