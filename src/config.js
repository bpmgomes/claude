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
    },
    logLevel: env.LOG_LEVEL || 'info',
  };
  return deepFreeze(config);
}

/** Ambientes em que `COOKIE_SECURE=false` é aceito (comparação exata). */
export const COOKIE_INSECURE_ENVS = Object.freeze(['development', 'test']);

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
 * Combina a config base com overrides (merge raso, exceto `rateLimit` e `loginLock`).
 * `logStream`, `now` e `storage` não fazem parte da config e são descartados.
 * Dentro de `rateLimit` o merge também é raso: quem sobrescreve `rateLimit.logoUpload`
 * passa o objeto inteiro.
 */
export function mergeConfig(base, overrides = {}) {
  // eslint-disable-next-line no-unused-vars
  const { logStream, now, storage, ...rest } = overrides;
  const merged = {
    ...base,
    ...rest,
    rateLimit: { ...base.rateLimit, ...(rest.rateLimit || {}) },
    loginLock: { ...base.loginLock, ...(rest.loginLock || {}) },
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
