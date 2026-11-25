/**
 * Carrega a configuração a partir de variáveis de ambiente.
 * @param {Record<string, string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const config = {
    port: toInt(env.PORT, 3000),
    databasePath: env.DATABASE_PATH || './data/agendafacil.db',
    bcryptCost: toInt(env.BCRYPT_COST, 12),
    sessionTtlDays: toInt(env.SESSION_TTL_DAYS, 7),
    cookieSecure: env.COOKIE_SECURE !== undefined ? toBool(env.COOKIE_SECURE) : isProduction,
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED !== undefined ? toBool(env.RATE_LIMIT_ENABLED) : true,
      signupMax: 10,
      timeWindow: '1 minute',
    },
    logLevel: env.LOG_LEVEL || 'info',
  };
  return deepFreeze(config);
}

/**
 * Combina a config base com overrides (merge raso, exceto `rateLimit`).
 */
export function mergeConfig(base, overrides = {}) {
  const { logStream, ...rest } = overrides;
  const merged = {
    ...base,
    ...rest,
    rateLimit: { ...base.rateLimit, ...(rest.rateLimit || {}) },
  };
  return deepFreeze(merged);
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
