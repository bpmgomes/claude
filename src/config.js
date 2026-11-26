import { randomBytes } from 'node:crypto';

/**
 * Carrega a configuração a partir de variáveis de ambiente.
 *
 * Padrões relevantes para segurança (ver README.md, seção "Configuração"):
 * - `COOKIE_SECURE`: ligado por padrão. `false` só é aceito com `NODE_ENV` em
 *   `COOKIE_INSECURE_ENVS` (`development`, `test`); com qualquer outro valor
 *   (inclusive ausente), `COOKIE_SECURE=false` faz esta função lançar erro.
 * - `TRUST_PROXY`: desligado por padrão (usa o IP da conexão TCP e ignora
 *   `X-Forwarded-For`). Atrás de um único proxy/load balancer, use `TRUST_PROXY=1`.
 *   Aceita também `true` (qualquer salto; só se o proxy sobrescreve o header)
 *   ou uma lista de IPs/CIDRs separados por vírgula.
 * - `SESSION_TTL_DAYS` (7): expiração por inatividade.
 *   `SESSION_ABSOLUTE_TTL_DAYS` (30): teto desde a criação da sessão.
 * - `ALLOWED_ORIGINS`: origens extras aceitas pela checagem de CSRF (vírgula).
 * - `UPLOADS_DIR` (`./data/uploads`): raiz do armazenamento local dos logos.
 * - `PUBLIC_BASE_URL` (`http://localhost:<port>`): base do link público do negócio,
 *   normalizada sem barra final. Nunca é derivada do header `Host`.
 * - `rateLimit.businessWrite`, `rateLimit.logoUpload` e `rateLimit.serviceWrite`
 *   (`{ perUser, perIp }` por `timeWindow`): valores aplicados POR ROTA, cada rota com
 *   contadores próprios (ver src/http/route-guards.js). `serviceWrite` (30/60 por minuto)
 *   vale para criar, editar, desativar e reativar serviços.
 * - `rateLimit.professionalWrite` (30/60 por minuto: criar, editar e remover profissional) e
 *   `rateLimit.professionalPhoto` (10/20 por minuto: trocar e remover a foto), também POR ROTA.
 * - `rateLimit.hoursWrite` (30/60 por minuto: gravar a grade de horários do profissional, POR ROTA).
 *   A leitura da grade não tem limite por usuário.
 * - `rateLimit.timeBlockWrite` (30/60 por minuto: criar e remover bloqueio de horário, POR ROTA:
 *   POST e DELETE com contadores próprios).
 * - `rateLimit.timeBlockRead` (60/120 por minuto: listar bloqueios, `GET /api/time-blocks`). É a
 *   única leitura do dono com limite por usuário (AF-16, critério 22).
 * - `rateLimit.publicPage` (`{ perIp: 120 }` por minuto): UM contador por IP compartilhado entre as
 *   rotas públicas de leitura do negócio (`/:slug`, `/:slug/`, o 404 HTML de fallback e
 *   `GET /api/public/:slug/availability`), sem multiplicar o limite por rota (AF-10, critério 25).
 * - `rateLimit.publicAvailability` (`{ perIp: 30 }` por minuto): teto de custo ADICIONAL, só para o
 *   endpoint de horários. Cada consulta consome os dois contadores.
 * - `rateLimit.publicBooking` (`{ perIp: 10 }` por minuto): teto de escrita ADICIONAL, só para
 *   `POST /api/public/:slug/appointments` (AF-11, critério 41). A mesma requisição consome também o
 *   contador compartilhado `publicPage`.
 * - `rateLimit.malformedUrl` (`{ perIp: 120 }` por minuto): contador barato por IP do JSON 400 de URL
 *   malformada (`frameworkErrors`, AF-09 item 1). O 404 HTML de URL malformada usa `publicPage`.
 * - `rateLimit.publicMedia` (`{ perIp: 600 }` por minuto: `/media/logos/:file` e
 *   `/media/professionals/:file`): POR ROTA. Rotas anônimas, só por IP (IPv6 agrupado no /64).
 * - `imageProcessing` (`{ concurrency: 2, queueMax: 4, queueTimeoutMs: 10000 }`): limite de
 *   processamentos de imagem simultâneos, dividido entre logo e foto (src/images/image-limiter.js);
 *   acima da fila, 503 IMAGE_BUSY.
 * - `CONFLICTS_TOKEN_SECRET` (`conflictsTokenSecret`, sem padrão): segredo do HMAC do token de
 *   conflitos dos bloqueios (AF-11, critério 36). Mínimo de 32 caracteres. Obrigatório fora de
 *   `NODE_ENV` em `DEV_TEST_ENVS`; a checagem é de `resolveConflictsTokenSecret`, chamada pelo
 *   `buildApp` (esta função só lê o valor e nunca lança por causa dele).
 * - `nodeEnv` (`NODE_ENV`, só leitura): `null` quando ausente.
 *
 * @param {Record<string, string|undefined>} env
 * @throws {Error} se `COOKIE_SECURE=false` com `NODE_ENV` fora de `COOKIE_INSECURE_ENVS`
 */
export function loadConfig(env = process.env) {
  const cookieSecure = env.COOKIE_SECURE !== undefined ? toBool(env.COOKIE_SECURE) : true;
  if (!cookieSecure && !COOKIE_INSECURE_ENVS.includes(env.NODE_ENV)) {
    throw new Error(
      `COOKIE_SECURE=false só é permitido com NODE_ENV em: ${COOKIE_INSECURE_ENVS.join(', ')}.`,
    );
  }
  const port = toInt(env.PORT, 3000);
  const config = {
    port,
    databasePath: env.DATABASE_PATH || './data/agendafacil.db',
    bcryptCost: toInt(env.BCRYPT_COST, 12),
    sessionTtlDays: toInt(env.SESSION_TTL_DAYS, 7),
    sessionAbsoluteTtlDays: toInt(env.SESSION_ABSOLUTE_TTL_DAYS, 30),
    sessionTouchIntervalSeconds: 60,
    cookieSecure,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    allowedOrigins: parseList(env.ALLOWED_ORIGINS),
    uploadsDir: env.UPLOADS_DIR || './data/uploads',
    publicBaseUrl: normalizeBaseUrl(env.PUBLIC_BASE_URL || `http://localhost:${port}`),
    loginLock: {
      maxFailures: 5,
      lockMinutes: 15,
    },
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED !== undefined ? toBool(env.RATE_LIMIT_ENABLED) : true,
      signupMax: 10,
      loginMax: 20,
      timeWindow: '1 minute',
      businessWrite: { perUser: 30, perIp: 60 },
      logoUpload: { perUser: 10, perIp: 20 },
      serviceWrite: { perUser: 30, perIp: 60 },
      professionalWrite: { perUser: 30, perIp: 60 },
      professionalPhoto: { perUser: 10, perIp: 20 },
      hoursWrite: { perUser: 30, perIp: 60 },
      timeBlockWrite: { perUser: 30, perIp: 60 },
      timeBlockRead: { perUser: 60, perIp: 120 },
      publicPage: { perIp: 120 },
      publicAvailability: { perIp: 30 },
      publicBooking: { perIp: 10 },
      malformedUrl: { perIp: 120 },
      publicMedia: { perIp: 600 },
    },
    imageProcessing: {
      concurrency: 2,
      queueMax: 4,
      queueTimeoutMs: 10_000,
    },
    logLevel: env.LOG_LEVEL || 'info',
    conflictsTokenSecret: typeof env.CONFLICTS_TOKEN_SECRET === 'string' && env.CONFLICTS_TOKEN_SECRET !== ''
      ? env.CONFLICTS_TOKEN_SECRET
      : null,
    nodeEnv: typeof env.NODE_ENV === 'string' && env.NODE_ENV !== '' ? env.NODE_ENV : null,
  };
  return deepFreeze(config);
}

/** Ambientes de desenvolvimento e teste (comparação exata). */
export const DEV_TEST_ENVS = Object.freeze(['development', 'test']);

/** Ambientes em que `COOKIE_SECURE=false` é aceito (comparação exata). Alias de DEV_TEST_ENVS. */
export const COOKIE_INSECURE_ENVS = DEV_TEST_ENVS;

/** Tamanho mínimo de `CONFLICTS_TOKEN_SECRET`. */
export const CONFLICTS_TOKEN_SECRET_MIN = 32;

/**
 * Segredo do token de conflitos (AF-11, critério 36, decisão 12). Chamada pelo `buildApp` depois do
 * `mergeConfig`. Lista de permitidos, como `COOKIE_SECURE`: sem valor, só `development` e `test`
 * sobem, com um segredo aleatório por processo (reiniciar invalida os tokens pendentes).
 * As mensagens nunca ecoam o valor.
 * @param {{ conflictsTokenSecret?: string|null, nodeEnv?: string|null }} config
 * @returns {{ secret: string, generated: boolean }}
 * @throws {Error} valor curto, ou ausente fora de development/test
 */
export function resolveConflictsTokenSecret(config) {
  const value = config?.conflictsTokenSecret;
  if (typeof value === 'string' && value !== '') {
    if (value.length < CONFLICTS_TOKEN_SECRET_MIN) {
      throw new Error(`CONFLICTS_TOKEN_SECRET deve ter pelo menos ${CONFLICTS_TOKEN_SECRET_MIN} caracteres.`);
    }
    return { secret: value, generated: false };
  }
  if (DEV_TEST_ENVS.includes(config?.nodeEnv)) {
    return { secret: randomBytes(32).toString('base64url'), generated: true };
  }
  throw new Error('CONFLICTS_TOKEN_SECRET é obrigatório fora de development e test.');
}

/** Remove barras finais da URL base. */
export function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, '');
}

/**
 * Converte `TRUST_PROXY` para o formato aceito pelo Fastify.
 * - ausente, vazio, `false`, `0` -> false
 * - `true` -> true
 * - inteiro positivo -> número de saltos confiáveis
 * - outro texto -> lista de IPs/CIDRs (array)
 * @param {string|undefined} value
 * @returns {boolean|number|string[]}
 */
export function parseTrustProxy(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  const lower = text.toLowerCase();
  if (text === '' || lower === 'false' || text === '0') return false;
  if (lower === 'true') return true;
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  return parseList(text);
}

/**
 * Combina a config base com overrides (merge raso, exceto `rateLimit`, `loginLock` e
 * `imageProcessing`). `logStream`, `now`, `storage`, `imageLimiter` e `appointmentEvents` não
 * fazem parte da config e são descartados.
 * Dentro de `rateLimit` o merge também é raso: quem sobrescreve `rateLimit.logoUpload`
 * passa o objeto inteiro.
 */
export function mergeConfig(base, overrides = {}) {
  // eslint-disable-next-line no-unused-vars
  const { logStream, now, storage, imageLimiter, appointmentEvents, ...rest } = overrides;
  const merged = {
    ...base,
    ...rest,
    rateLimit: { ...base.rateLimit, ...(rest.rateLimit || {}) },
    loginLock: { ...base.loginLock, ...(rest.loginLock || {}) },
    imageProcessing: { ...base.imageProcessing, ...(rest.imageProcessing || {}) },
  };
  return deepFreeze(merged);
}

function parseList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}
