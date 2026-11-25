import { ForbiddenOriginError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Checagem de CSRF por Fetch Metadata e `Origin` (função pura).
 * 1. Com `Sec-Fetch-Site`, aceita só `same-origin`.
 * 2. Senão, com `Origin`, aceita só a própria origem ou um item de `allowedOrigins`.
 * 3. Sem nenhum dos dois, aceita (cliente que não é navegador e não carrega cookie da vítima).
 * @param {{ headers: Record<string, string|string[]|undefined>, protocol: string, host: string }} request
 * @param {{ allowedOrigins?: string[] }} config
 * @returns {boolean}
 */
export function isSameOriginRequest(request, config) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined) return fetchSite === 'same-origin';

  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin === 'null') return false;

  const requestOrigin = originOf(origin);
  if (!requestOrigin || requestOrigin === 'null') return false;

  const own = originOf(`${request.protocol}://${request.host}`);
  if (own && requestOrigin === own) return true;

  return (config.allowedOrigins || []).some((allowed) => originOf(allowed) === requestOrigin);
}

/**
 * Hook global de CSRF. Encapsulamento desligado (como o auth.plugin) para valer
 * em todas as rotas. Roda em onRequest, antes do parse do corpo e do banco.
 */
async function csrfPlugin(app) {
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (!isSameOriginRequest(request, app.config)) throw new ForbiddenOriginError();
  });
}
csrfPlugin[Symbol.for('skip-override')] = true;
csrfPlugin[Symbol.for('fastify.display-name')] = 'csrf-plugin';

export default csrfPlugin;
