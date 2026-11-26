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
import { createProfessionalsRepository } from './modules/professionals/professionals.repository.js';
import { createProfessionalsService } from './modules/professionals/professionals.service.js';
import professionalsRoutes from './modules/professionals/professionals.routes.js';
import { createWorkingHoursRepository } from './modules/working-hours/working-hours.repository.js';
import { createWorkingHoursService } from './modules/working-hours/working-hours.service.js';
import workingHoursRoutes from './modules/working-hours/working-hours.routes.js';
import { createTimeBlocksRepository } from './modules/time-blocks/time-blocks.repository.js';
import { createTimeBlocksService } from './modules/time-blocks/time-blocks.service.js';
import timeBlocksRoutes from './modules/time-blocks/time-blocks.routes.js';
import { createPublicPageService } from './modules/public-page/public-page.service.js';
import publicPageRoutes, {
  sendNotFoundPage,
  sendRateLimitedPage,
  wantsHtmlNotFound,
} from './modules/public-page/public-page.routes.js';
import { publicKeyGenerator } from './http/route-guards.js';
import { createImageLimiter } from './images/image-limiter.js';
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
  '/profissionais': 'profissionais.html',
  '/horarios': 'horarios.html',
  '/bloqueios': 'bloqueios.html',
});

/**
 * @param {object} [overrides] sobrescreve chaves de loadConfig(); aceita também `logStream`,
 *   `now` (relógio `() => Date`, padrão `() => new Date()`, repassado a todos os serviços)
 *   `storage` (instância de `Storage`; padrão: disco local em `config.uploadsDir`) e
 *   `imageLimiter` (instância pronta de `createImageLimiter`; padrão: criada com
 *   `config.imageProcessing`, dividida entre logo e foto)
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

  const app = Fastify({
    logger,
    bodyLimit: 16 * 1024,
    trustProxy: config.trustProxy,
    // URL malformada (ex.: /%E0%A4%A) em GET/HEAD fora da API: o mesmo 404 HTML uniforme da
    // página pública, sem eco (AF-09, critério 21). Outros erros de framework: JSON 400 fixo.
    frameworkErrors: (error, request, reply) => {
      const notFoundCodes = ['FST_ERR_BAD_URL', 'FST_ERR_MAX_PARAM_LENGTH'];
      if (notFoundCodes.includes(error.code) && wantsHtmlNotFound(request)) return sendNotFoundPage(reply);
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Requisição inválida.' } });
    },
  });
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
  const imageLimiter = overrides.imageLimiter || createImageLimiter(config.imageProcessing);
  const businessesRepository = createBusinessesRepository(db);
  const businessesService = createBusinessesService({
    db,
    businessesRepository,
    storage,
    imageLimiter,
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
  const professionalsRepository = createProfessionalsRepository(db);
  // Sem `appointments`: usa a porta nula (noAppointments) até o AF-11.
  const professionalsService = createProfessionalsService({
    db,
    professionalsRepository,
    businessesRepository,
    storage,
    imageLimiter,
    now,
    log: app.log,
  });
  const workingHoursRepository = createWorkingHoursRepository(db);
  // Sem `appointments`: usa a porta nula (noAppointments) até o AF-11.
  const workingHoursService = createWorkingHoursService({
    db,
    workingHoursRepository,
    professionalsRepository,
    businessesRepository,
    now,
    log: app.log,
  });
  const timeBlocksRepository = createTimeBlocksRepository(db);
  // Sem `appointments`: usa a porta nula (noAppointments) até o AF-11.
  const timeBlocksService = createTimeBlocksService({
    db,
    timeBlocksRepository,
    professionalsRepository,
    businessesRepository,
    now,
    log: app.log,
  });
  // Retenção (AF-16, 5.5): encerrados há mais de 90 dias saem no boot.
  await timeBlocksService.purgeExpired();
  const publicPageService = createPublicPageService({
    businessesRepository,
    servicesRepository,
    professionalsRepository,
    config,
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
    professionalsRepository,
    professionalsService,
    workingHoursRepository,
    workingHoursService,
    timeBlocksRepository,
    timeBlocksService,
    publicPageService,
    imageLimiter,
  });

  // Caminho recusado pelo @fastify/static (ex.: segmento acima de 255 bytes, que não casa
  // `/:slug`): para navegação, segue para o 404 uniforme (com o limite do notFound), sem eco.
  app.setErrorHandler((error, request, reply) => {
    if (error && error.code === 'FST_STATIC_FORBIDDEN_PATH' && wantsHtmlNotFound(request)) {
      return reply.callNotFound();
    }
    return errorHandler(error, request, reply);
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

  // 404 fora das rotas (AF-09, 4.1): GET/HEAD fora de /api/, /media/ e /shared/ recebem o 404
  // HTML uniforme (slug acima do maxParamLength, arquivo estático inexistente); o resto, o JSON
  // NOT_FOUND. Com rate limit ligado, contador próprio com o bucket publicPage (o 404 conta).
  const notFoundOptions = {};
  if (config.rateLimit.enabled) {
    const limit = app.rateLimit({
      max: config.rateLimit.publicPage.perIp,
      timeWindow: config.rateLimit.timeWindow,
      keyGenerator: publicKeyGenerator,
    });
    notFoundOptions.preHandler = async (request, reply) => {
      try {
        await limit(request, reply);
      } catch (err) {
        if (err && err.statusCode === 429 && wantsHtmlNotFound(request)) return sendRateLimitedPage(reply);
        throw err;
      }
    };
  }
  app.setNotFoundHandler(notFoundOptions, (request, reply) => {
    if (wantsHtmlNotFound(request)) return sendNotFoundPage(reply);
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } });
  });
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
  await app.register(professionalsRoutes);
  await app.register(workingHoursRoutes);
  await app.register(timeBlocksRoutes);
  // Por último: `/:slug` só casa o que nenhuma rota estática casou.
  await app.register(publicPageRoutes);

  await app.ready();
  return app;
}
