import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { loadConfig, mergeConfig, resolveConflictsTokenSecret } from './config.js';
import { resolveEmailConfig, createMailTransport } from './modules/email/email-config.js';
import { createEmailOutboxRepository } from './modules/email/email-outbox.repository.js';
import { createEmailWorker } from './modules/email/email-worker.js';
import { enqueueEmail } from './modules/email/enqueue-email.js';
import { createManageTokenIssuer } from './modules/appointments/manage-token-issuer.js';
import { errorHandler, RateLimitedError } from './http/errors.js';
import { createSecurityHeaders, SECURITY_HEADERS_PROBE_URL } from './http/security-headers.js';
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
import { createSharedPublicLimiter } from './http/route-guards.js';
import { isApiRequest } from './http/api-path.js';
import { createAvailabilityService } from './modules/availability/availability.service.js';
import availabilityRoutes from './modules/availability/availability.routes.js';
import { createCustomersRepository } from './modules/customers/customers.repository.js';
import { createCustomersService } from './modules/customers/customers.service.js';
import { createAppointmentsRepository } from './modules/appointments/appointments.repository.js';
import { createAppointmentsPort } from './modules/appointments/appointments-port.js';
import { createAppointmentsService } from './modules/appointments/appointments.service.js';
import { noAppointmentEvents, combineAppointmentEvents } from './modules/appointments/appointment-events-port.js';
import appointmentsRoutes from './modules/appointments/appointments.routes.js';
import { createManageTokensRepository } from './modules/appointments/manage-tokens.repository.js';
import { createReschedulesRepository } from './modules/appointments/reschedules.repository.js';
import { createManageService } from './modules/appointments/manage.service.js';
import manageRoutes from './modules/appointments/manage.routes.js';
import { createAgendaService } from './modules/agenda/agenda.service.js';
import agendaRoutes from './modules/agenda/agenda.routes.js';
import { redactLogUrl } from './http/log-redact.js';
import { createImageLimiter } from './images/image-limiter.js';
import { createStorage } from './storage/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Rotas curinga dos arquivos estáticos (`web/` e `src/shared/`). */
const STATIC_WILDCARD_URLS = Object.freeze(['/*', '/shared/*']);

const FRAMEWORK_NOT_FOUND_CODES = Object.freeze(['FST_ERR_BAD_URL', 'FST_ERR_MAX_PARAM_LENGTH']);
const RATE_LIMITED = new RateLimitedError(0);
const INTERNAL_ERROR_BODY = Object.freeze({ error: { code: 'INTERNAL_ERROR', message: 'Erro inesperado. Tente novamente.' } });

/**
 * JSON dos erros de framework: os cabeçalhos do helmet já foram aplicados; aqui só o que é próprio
 * de uma resposta de erro sem conteúdo ativo (CSP mais restrita, sem frame e sem cache).
 */
function sendFrameworkJson(reply, status, body) {
  return reply
    .status(status)
    .header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', FRAMEWORK_ERROR_CSP)
    .header('X-Frame-Options', 'DENY')
    .send(body);
}

/** CSP do JSON 400 de `frameworkErrors` (resposta sem conteúdo ativo). */
export const FRAMEWORK_ERROR_CSP = "default-src 'none'; frame-ancestors 'none'";

export const REDACT_PATHS = [
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  'body.password',
  // Corpo do AF-11 (`customer: { name, phone, email }`): dado pessoal nunca vai para o log (AF-04,
  // critério 20), em qualquer nível até 4 (ex.: `customer`, `body.customer`, `req.body.customer`,
  // `err.details.body.customer`).
  'customer',
  'body.customer',
  '*.customer',
  '*.*.customer',
  '*.*.*.customer',
  // AF-04 item 1 (critério 38 do AF-11): snapshot, entrada e campos pessoais em até 4 níveis. O
  // @pinojs/redact não aceita curinga no meio de uma chave (`customer_*`): a lista é explícita.
  // Consequência: logs não usam `name` para identificar erros (usam `errCode`/`errName`).
  ...['snapshot', 'input', 'name', 'phone', 'email', 'customer_name', 'customer_phone', 'customerName', 'customerPhone']
    .flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
  // AF-12 (critério 10): token de gerenciar, o hash e o link (payload dos eventos) em até 4 níveis. A
  // URL do pedido sai pelo serializador `req` (redactLogUrl).
  ...['token', 'tokenHash', 'token_hash', 'manageUrl'].flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
  // AF-18 (critério 26): mensagem de e-mail (destinatário, remetente, assunto, corpo, anexos) e
  // credenciais SMTP em até 4 níveis. Os logs do worker nunca recebem esses objetos; isto é rede.
  ...['to', 'from', 'subject', 'text', 'html', 'attachments', 'smtpPassword', 'auth'].flatMap((key) => [
    key,
    `*.${key}`,
    `*.*.${key}`,
    `*.*.*.${key}`,
  ]),
];

/**
 * Serializador `req` do log: a forma do padrão do Fastify (`method`, `url`, `host`, `remoteAddress`,
 * `remotePort`), com a URL sem query e sem o token de gerenciar (AF-12, critério 10; R13).
 */
export function serializeRequestForLog(req) {
  return {
    method: req.method,
    url: redactLogUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}

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
  '/agenda': 'agenda.html',
});

/**
 * O boot também purga os tokens de gerenciar vencidos há mais de 30 dias (AF-12, critério 7).
 * @param {object} [overrides] sobrescreve chaves de loadConfig(); aceita também `logStream`,
 *   `now` (relógio `() => Date`, padrão `() => new Date()`, repassado a todos os serviços)
 *   `storage` (instância de `Storage`; padrão: disco local em `config.uploadsDir`) e
 *   `imageLimiter` (instância pronta de `createImageLimiter`; padrão: criada com
 *   `config.imageProcessing`, dividida entre logo e foto) e `appointmentEvents` (porta de eventos
 *   pós-commit do AF-11; padrão: `noAppointmentEvents`; combinada com a porta que acorda o worker de
 *   e-mail) e `mailTransport` (porta de envio do AF-18; com ela o transporte é `injected`, ativo).
 * O worker de e-mail só roda com o servidor ouvindo (`onListen`): `app.inject` dos testes nunca o
 * liga sozinho; os testes chamam `app.services.emailWorker.runOnce()`.
 * @throws {Error} sem `CONFLICTS_TOKEN_SECRET` fora de development/test, ou com valor curto
 * @throws {Error} configuração de e-mail inválida (resolveEmailConfig, mensagens sem eco)
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp(overrides = {}) {
  const fullConfig = mergeConfig(loadConfig(), overrides);
  // O segredo do token de conflitos fica só aqui e no timeBlocksService (nunca em app.config nem
  // em log). Lança fora de development/test sem CONFLICTS_TOKEN_SECRET (AF-11, critério 36).
  const { secret: conflictsTokenSecret, generated: conflictsTokenSecretGenerated } =
    resolveConflictsTokenSecret(fullConfig);
  // AF-18 (design 2.2): transporte de e-mail decidido e validado aqui; a senha SMTP fica só nesta
  // função e no adaptador SMTP (nunca em app.config nem em log).
  const emailConfig = resolveEmailConfig(fullConfig, { injected: Boolean(overrides.mailTransport) });
  const { conflictsTokenSecret: _secret, smtpPassword, ...publicConfig } = fullConfig;
  const config = Object.freeze({ ...publicConfig, email: Object.freeze(emailConfig) });
  const now = overrides.now || (() => new Date());

  const logger = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { req: serializeRequestForLog },
  };
  if (overrides.logStream) logger.stream = overrides.logStream;

  const app = Fastify({
    logger,
    bodyLimit: 16 * 1024,
    trustProxy: config.trustProxy,
    // URL malformada (ex.: /%E0%A4%A) em GET/HEAD fora da API: o mesmo 404 HTML uniforme da
    // página pública, sem eco (AF-09, critério 21). Outros erros de framework: JSON 400 fixo.
    // Este caminho não passa pelo helmet: os cabeçalhos dele vêm da captura do boot (AF-09 item 1).
    frameworkErrors: (error, request, reply) => {
      handleFrameworkError(error, request, reply).catch((err) => {
        request.log.error({ event: 'framework_error_failed', err });
        if (!reply.sent) reply.status(500).header('Cache-Control', 'no-store').send(INTERNAL_ERROR_BODY);
      });
    },
  });

  /**
   * Erros de framework (antes do roteamento): cabeçalhos do helmet, contador barato por IP (o 404
   * HTML usa o contador compartilhado das rotas públicas, como o 404 de fallback; o JSON 400 usa o
   * bucket `malformedUrl`) e corpo fixo sem eco.
   */
  async function handleFrameworkError(error, request, reply) {
    securityHeaders.apply(reply);
    const html = FRAMEWORK_NOT_FOUND_CODES.includes(error.code) && wantsHtmlNotFound(request);
    const limiter = html ? publicReadLimiter : malformedUrlLimiter;
    if (limiter) {
      try {
        await limiter(request, reply);
      } catch (err) {
        if (!err || err.statusCode !== 429) throw err;
        if (html) return sendRateLimitedPage(reply);
        return sendFrameworkJson(reply, 429, { error: { code: RATE_LIMITED.code, message: RATE_LIMITED.message } });
      }
    }
    if (html) return sendNotFoundPage(reply);
    return sendFrameworkJson(reply, 400, { error: { code: 'VALIDATION_ERROR', message: 'Requisição inválida.' } });
  }

  // Preenchidos depois do registro do @fastify/rate-limit (null sem rate limit).
  if (conflictsTokenSecretGenerated) app.log.warn({ event: 'conflicts_token_secret_generated' });
  if (emailConfig.transport === 'none') app.log.warn({ event: 'email_transport_not_configured' });
  let publicReadLimiter = null;
  let malformedUrlLimiter = null;
  const securityHeaders = createSecurityHeaders();
  app.decorate('securityHeaders', securityHeaders);
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
  // Porta de agendamentos real (AF-11, critério 31): passada a todos os consumidores.
  const workingHoursRepository = createWorkingHoursRepository(db);
  const appointmentsRepository = createAppointmentsRepository(db);
  const appointments = createAppointmentsPort({ appointmentsRepository, workingHoursRepository });
  const servicesRepository = createServicesRepository(db);
  const servicesService = createServicesService({
    db,
    servicesRepository,
    businessesRepository,
    appointments,
    now,
    log: app.log,
  });
  const professionalsRepository = createProfessionalsRepository(db);
  const professionalsService = createProfessionalsService({
    db,
    professionalsRepository,
    businessesRepository,
    appointments,
    storage,
    imageLimiter,
    now,
    log: app.log,
  });
  const workingHoursService = createWorkingHoursService({
    db,
    workingHoursRepository,
    professionalsRepository,
    businessesRepository,
    appointments,
    now,
    log: app.log,
  });
  const timeBlocksRepository = createTimeBlocksRepository(db);
  const timeBlocksService = createTimeBlocksService({
    db,
    timeBlocksRepository,
    professionalsRepository,
    businessesRepository,
    appointments,
    conflictsTokenSecret,
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
    now,
  });
  const availabilityService = createAvailabilityService({
    businessesRepository,
    servicesRepository,
    professionalsRepository,
    workingHoursRepository,
    timeBlocksRepository,
    appointments,
    now,
    log: app.log,
  });
  // Porta customers (AF-04): sem rota própria; só o AF-11 (e o AF-15) chama, com a transação dele.
  const customersRepository = createCustomersRepository(db);
  const customersService = createCustomersService({ customersRepository, now });
  const manageTokensRepository = createManageTokensRepository(db);
  const reschedulesRepository = createReschedulesRepository(db);
  // AF-18: emissor único de tokens (teto de 5 vivos), fila, transporte e worker de e-mail.
  const tokenIssuer = createManageTokenIssuer({ manageTokensRepository, publicBaseUrl: config.publicBaseUrl });
  const emailOutboxRepository = createEmailOutboxRepository(db);
  const mailTransport = overrides.mailTransport || createMailTransport(emailConfig, { smtpPassword, now });
  if (mailTransport && typeof mailTransport.init === 'function') await mailTransport.init();
  const emailWorker = createEmailWorker({
    db,
    outbox: emailOutboxRepository,
    appointmentsRepository,
    businessesRepository,
    customersRepository,
    reschedulesRepository,
    manageTokensRepository,
    tokenIssuer,
    mailTransport,
    emailConfig,
    publicBaseUrl: config.publicBaseUrl,
    enabled: emailConfig.enabled,
    intervalMs: emailConfig.worker.intervalMs,
    now,
    log: app.log,
  });
  // A mesma porta para a reserva e o gerenciar: a do chamador (ou a nula) mais a que acorda o worker.
  const appointmentEvents = combineAppointmentEvents(overrides.appointmentEvents ?? noAppointmentEvents, emailWorker.events);
  // Reserva pública (AF-11). Eventos pós-commit pela porta injetável (nula por padrão).
  const appointmentsService = createAppointmentsService({
    db,
    businessesRepository,
    servicesRepository,
    professionalsRepository,
    workingHoursRepository,
    timeBlocksRepository,
    appointmentsRepository,
    appointments,
    customersService,
    availabilityService,
    appointmentEvents,
    manageTokensRepository,
    reschedulesRepository,
    tokenIssuer,
    enqueueEmail,
    publicBaseUrl: config.publicBaseUrl,
    now,
    log: app.log,
  });
  // Idempotency-Key expiradas (24 h) saem no boot; uma falha não impede a subida.
  await appointmentsService.purgeExpiredIdempotencyKeys();
  // Gerenciar pelo link (AF-12): cancelar e remarcar, com a mesma porta de eventos.
  const manageService = createManageService({
    db,
    businessesRepository,
    servicesRepository,
    professionalsRepository,
    appointmentsRepository,
    manageTokensRepository,
    reschedulesRepository,
    appointmentsService,
    availabilityService,
    appointmentEvents,
    enqueueEmail,
    config,
    now,
    log: app.log,
  });
  // Tokens vencidos há mais de 30 dias saem no boot; uma falha não impede a subida.
  await manageService.purgeExpiredTokens();
  // Agenda do dono (AF-14): leitura e cancelamento pelo dono, com a mesma porta de eventos e a fila.
  const agendaService = createAgendaService({
    db,
    businessesRepository,
    professionalsRepository,
    appointmentsRepository,
    timeBlocksRepository,
    customersRepository,
    manageTokensRepository,
    reschedulesRepository,
    appointmentEvents,
    enqueueEmail,
    emailEnabled: emailConfig.enabled,
    now,
    log: app.log,
  });
  // Fila de e-mails (AF-18, 5.6), também com `none`: expira as pendentes velhas e purga as terminais.
  await emailWorker.maintenance();
  // R16: o Fastify roda os hooks onClose na ordem INVERSA do registro. Este é registrado depois do
  // que fecha o banco (logo após runMigrations), então o worker para ANTES de o banco fechar.
  app.addHook('onClose', async () => emailWorker.stop());
  // O laço só roda com o servidor ouvindo; `app.inject` nunca liga o worker sozinho.
  app.addHook('onListen', async () => emailWorker.start());
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
    availabilityService,
    customersRepository,
    customersService,
    appointmentsRepository,
    appointments,
    appointmentsService,
    manageTokensRepository,
    reschedulesRepository,
    manageService,
    agendaService,
    imageLimiter,
    tokenIssuer,
    emailOutboxRepository,
    emailWorker,
    mailTransport,
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
  // `no-store` em toda resposta de /api/* sem política própria, inclusive erros e o 404 JSON
  // (AF-16 item 5, AF-04 critério 16). Decide pela rota casada (ou, sem rota, pelo caminho
  // decodificado), nunca pelo texto bruto: `/%61pi/business` é `/api/business` (src/http/api-path.js).
  // O JSON de `frameworkErrors` já define o seu.
  app.addHook('onSend', async (request, reply, payload) => {
    if (isApiRequest(request) && !reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await app.register(cookie);
  await app.register(csrfPlugin);
  if (config.rateLimit.enabled) {
    await app.register(rateLimit, { global: false });
  }
  // Contador por IP COMPARTILHADO entre as rotas públicas de leitura do negócio (AF-09 item 3, AF-10
  // critério 25): `/:slug`, `/:slug/`, o 404 HTML de fallback e o endpoint de horários. null sem rate limit.
  publicReadLimiter = createSharedPublicLimiter(app, config, 'publicPage');
  app.decorate('publicReadLimiter', publicReadLimiter);
  // Teto de escrita pública ÚNICO (AF-12, critério 33): reservar (AF-11), cancelar e remarcar dividem
  // o mesmo contador `publicBooking`, sem multiplicar o limite entre rotas. null sem rate limit.
  app.decorate('publicWriteLimiter', createSharedPublicLimiter(app, config, 'publicBooking', { addHeaders: false }));
  // Contador barato por IP para o JSON 400 de URL malformada (AF-09 item 1).
  malformedUrlLimiter = createSharedPublicLimiter(app, config, 'malformedUrl');

  // 404 fora das rotas (AF-09, 4.1): GET/HEAD fora de /api/, /media/ e /shared/ recebem o 404
  // HTML uniforme (slug acima do maxParamLength, arquivo estático inexistente); o resto, o JSON
  // NOT_FOUND. Com rate limit ligado, só o 404 HTML consome o contador compartilhado (AF-09 item 2):
  // /api/*, /media/*, /shared/* e outros métodos não contam.
  const notFoundOptions = {};
  if (publicReadLimiter) {
    notFoundOptions.preHandler = async (request, reply) => {
      if (!wantsHtmlNotFound(request)) return;
      try {
        await publicReadLimiter(request, reply);
      } catch (err) {
        if (err && err.statusCode === 429) return sendRateLimitedPage(reply);
        throw err;
      }
    };
  }
  app.setNotFoundHandler(notFoundOptions, (request, reply) => {
    if (wantsHtmlNotFound(request)) return sendNotFoundPage(reply);
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } });
  });
  await app.register(authPlugin);

  // Os wildcards do @fastify/static (`/*` e `/shared/*`) servem só arquivos públicos e também
  // encaminham o 404 de fallback (callNotFound) de todo GET/HEAD sem rota: marcados como
  // `publicRoute`, não leem nem renovam a sessão do dono (AF-09 item 4; o `is404` só cobre o
  // que não casou nenhuma rota).
  app.addHook('onRoute', (routeOptions) => {
    if (STATIC_WILDCARD_URLS.includes(routeOptions.url)) {
      routeOptions.config = { ...(routeOptions.config || {}), publicRoute: true };
    }
  });
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
  await app.register(agendaRoutes);
  // Antes de publicPageRoutes (rota estática /api/public/... tem prioridade sobre `/:slug`).
  await app.register(availabilityRoutes);
  await app.register(appointmentsRoutes);
  await app.register(manageRoutes);
  // Por último: `/:slug` só casa o que nenhuma rota estática casou.
  await app.register(publicPageRoutes);

  await app.ready();
  // Fonte única dos cabeçalhos do helmet para os erros de framework: captura do próprio helmet.
  const probe = await app.inject({ method: 'GET', url: SECURITY_HEADERS_PROBE_URL });
  securityHeaders.capture(probe.headers);
  return app;
}
