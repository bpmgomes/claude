// Redact da URL nos logs (AF-12, critério 10). O token de gerenciar viaja só no caminho
// (`/agendamento/<token>` e `/api/public/manage/<token>/...`) e nunca pode aparecer em log.

export const REDACTED = '[REDACTED]';

const MANAGE_API_PREFIX = '/api/public/manage/';
const MANAGE_PAGE_SEGMENT = 'agendamento';

/** Sufixos conhecidos das rotas da API do gerenciar, os únicos preservados depois do token. */
const MANAGE_API_SUFFIXES = Object.freeze(['/cancel', '/reschedule', '/availability']);

/**
 * URL para o log: sem a query string (nenhum valor de query vai para o log) e, nos caminhos do
 * gerenciar, com TUDO depois do prefixo trocado por `[REDACTED]`. Na API, só um sufixo conhecido
 * (`/cancel`, `/reschedule`, `/availability`) no fim do caminho é preservado. Assim, um segmento com
 * `%2F` (`/agendamento/x%2F<token>`) não deixa pedaço do token no log (QA D1).
 * O caminho é decodificado como o roteador faria (`/%61gendamento/<t>` é a página), sem distinção de
 * maiúsculas. Se a decodificação falhar, a URL inteira vira `[REDACTED]`. Caminhos comuns saem como
 * vieram (sem a query).
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function redactLogUrl(rawUrl) {
  const url = String(rawUrl ?? '');
  const queryAt = url.indexOf('?');
  const path = queryAt >= 0 ? url.slice(0, queryAt) : url;
  let decoded;
  try {
    // Barras repetidas colapsadas só para decidir e redigir (`//agendamento/<t>` também é coberto).
    decoded = decodeURIComponent(path).replace(/\/{2,}/g, '/');
  } catch {
    return REDACTED;
  }
  const lower = decoded.toLowerCase();
  if (lower.startsWith(MANAGE_API_PREFIX)) {
    const head = decoded.slice(0, MANAGE_API_PREFIX.length);
    const rest = lower.slice(MANAGE_API_PREFIX.length);
    const suffix = MANAGE_API_SUFFIXES.find((s) => rest.endsWith(s) && rest.length > s.length);
    return `${head}${REDACTED}${suffix ?? ''}`;
  }
  const segments = lower.split('/');
  if (segments[1] === MANAGE_PAGE_SEGMENT && segments.length > 2) {
    return `${decoded.slice(0, `/${MANAGE_PAGE_SEGMENT}/`.length)}${REDACTED}`;
  }
  return path;
}
