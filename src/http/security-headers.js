// Cabeçalhos de segurança do helmet para respostas que não passam pelos hooks (AF-09 item 1):
// erros de framework (`frameworkErrors`: URL malformada, parâmetro longo demais), que o Fastify
// responde antes do roteamento e, portanto, antes do `onRequest` do helmet.
//
// Fonte única: o conjunto é CAPTURADO do próprio helmet no boot (buildApp faz uma requisição
// interna a uma URL inexistente da API e guarda os cabeçalhos que o helmet definiu), então não há
// lista paralela que possa divergir da configuração do helmet.

/** URL da sonda do boot: cai no 404 JSON da API (não lê sessão nem consome rate limit). */
export const SECURITY_HEADERS_PROBE_URL = '/api/__security-headers-probe';

/** Cabeçalhos da resposta da sonda que NÃO vêm do helmet (transporte, corpo, cache e limite). */
const NOT_FROM_HELMET = new Set([
  'connection',
  'content-length',
  'content-type',
  'date',
  'keep-alive',
  'transfer-encoding',
  'cache-control',
  'set-cookie',
  'etag',
  'last-modified',
  'vary',
  'retry-after',
]);

/**
 * Filtra os cabeçalhos do helmet de uma resposta (light-my-request ou http).
 * @param {Record<string, string|string[]|number|undefined>} headers
 * @returns {Readonly<Record<string, string>>}
 */
export function helmetHeadersOf(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (NOT_FROM_HELMET.has(key) || key.startsWith('x-ratelimit-') || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return Object.freeze(out);
}

/**
 * Registro dos cabeçalhos capturados. `apply` antes da captura (só durante o boot) não define nada.
 * @returns {{ capture(headers: object): void, apply(reply: import('fastify').FastifyReply): void, get(): Readonly<Record<string, string>> }}
 */
export function createSecurityHeaders() {
  let captured = Object.freeze({});
  return {
    capture(headers) {
      captured = helmetHeadersOf(headers);
      if (!captured['strict-transport-security'] || !captured['x-content-type-options']) {
        throw new Error('Cabeçalhos do helmet ausentes na sonda de boot.');
      }
    },
    apply(reply) {
      for (const [name, value] of Object.entries(captured)) reply.header(name, value);
    },
    get() {
      return captured;
    },
  };
}
