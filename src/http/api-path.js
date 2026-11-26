// Classificação do caminho por área (/api/, /media/, /shared/) sem confiar no texto bruto da URL.
//
// O roteador (find-my-way) decodifica o percent-encoding antes de casar a rota: `/%61pi/business`
// chega a `GET /api/business`. Pela RFC 3986 (6.2.2.2), `%61` e `a` são o mesmo caminho, então a
// decisão de política (cache, 404 JSON ou HTML) tem de seguir o que o roteador entende, e não o
// prefixo literal. Decisão (AF-04, QA): NÃO recusar nem redirecionar caminhos com percent-encoding.
// Recusar quebraria clientes e proxies que codificam além do necessário e criaria uma terceira
// interpretação do caminho (texto bruto, roteador e filtro), que é justamente a origem do problema.
// Em vez disso, há uma regra só: a rota casada manda; sem rota casada (404, erro antes do
// roteamento), o primeiro segmento é decodificado do mesmo jeito que o roteador faria.

/** Primeiro segmento de área mais longo que interessa ("shared"); acima disso, não é área. */
const AREA_SEGMENT_MAX_ENCODED = 3 * 'shared'.length;

/**
 * Primeiro segmento do caminho, decodificado, se for seguido de `/` (ex.: '/%61pi/x' -> 'api').
 * '/api' sem barra final, segmento longo ou percent-encoding inválido -> null.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function areaOf(rawUrl) {
  const url = String(rawUrl ?? '');
  if (!url.startsWith('/')) return null;
  const end = url.indexOf('/', 1);
  if (end < 0) return null;
  const query = url.indexOf('?');
  if (query >= 0 && query < end) return null;
  const segment = url.slice(1, end);
  if (segment.length === 0 || segment.length > AREA_SEGMENT_MAX_ENCODED) return null;
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Requisição da API: a rota casada é de `/api/` ou, sem rota casada, o caminho (decodificado)
 * começa com `/api/`. Basta um dos dois (na dúvida, a política mais restrita vale).
 * @param {{ url?: string, raw?: { url?: string }, routeOptions?: { url?: string } }} request
 */
export function isApiRequest(request) {
  const routeUrl = request.routeOptions?.url;
  if (typeof routeUrl === 'string' && routeUrl.startsWith('/api/')) return true;
  return areaOf(request.raw?.url ?? request.url) === 'api';
}
