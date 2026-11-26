import { createHash } from 'node:crypto';
import { sharedPublicGuards } from '../../http/route-guards.js';
import { NotFoundError } from '../../http/errors.js';
import { parsePublicSlug } from '../../shared/slug.js';
import {
  renderPublicPage,
  PUBLIC_PAGE_CSP,
  NOT_FOUND_HTML,
  RATE_LIMITED_HTML,
  ERROR_HTML,
} from './public-page.render.js';

/** Cache curto da página e do 404 (critério 23). */
export const PUBLIC_PAGE_MAX_AGE_SECONDS = 60;
/** Orçamento de peso: HTML + CSS + JS + imagens da primeira dobra (critério 12, decisão 2). */
export const PUBLIC_PAGE_BYTES_BUDGET = 500 * 1024;

export const PUBLIC_PAGE_CACHE_CONTROL = `public, max-age=${PUBLIC_PAGE_MAX_AGE_SECONDS}`;
const NO_STORE = 'no-store';

/** Prefixos que mantêm o 404 JSON da API (o resto recebe o 404 HTML uniforme). */
const JSON_404_PREFIXES = Object.freeze(['/api/', '/media/', '/shared/']);

/**
 * GET/HEAD fora de /api/, /media/ e /shared/: recebe o 404 HTML uniforme (notFound e
 * frameworkErrors, design AF-09 4.1).
 * @param {{ method: string, url?: string, raw?: { url?: string } }} request
 */
export function wantsHtmlNotFound(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const url = String(request.raw?.url ?? request.url ?? '');
  return !JSON_404_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Envia HTML com os cabeçalhos da página pública: CSP própria, nosniff, Referrer-Policy e
 * proibição de frame. Os cabeçalhos são definidos aqui (e não só pelo helmet) para que o 404
 * de `frameworkErrors`, que não passa pelos hooks, saia igual aos outros.
 * @param {import('fastify').FastifyReply} reply
 * @param {number} status
 * @param {string|Buffer|null} body
 * @param {{ cacheControl: string }} options
 */
export function sendHtml(reply, status, body, { cacheControl }) {
  reply
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', cacheControl)
    .header('Content-Security-Policy', PUBLIC_PAGE_CSP)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Frame-Options', 'DENY');
  return body === null ? reply.send() : reply.send(body);
}

/** 404 uniforme: mesmos bytes, status e cabeçalhos, sem refletir a entrada. */
export function sendNotFoundPage(reply) {
  reply.header('X-Robots-Tag', 'noindex');
  return sendHtml(reply, 404, NOT_FOUND_HTML, { cacheControl: PUBLIC_PAGE_CACHE_CONTROL });
}

/** 429 em HTML curto e fixo; o `Retry-After` já foi definido pelo @fastify/rate-limit. */
export function sendRateLimitedPage(reply) {
  return sendHtml(reply, 429, RATE_LIMITED_HTML, { cacheControl: NO_STORE });
}

/** 301 decidido só pelo formato, antes de qualquer consulta; sem query string. */
function sendCanonicalRedirect(reply, slug) {
  return reply.header('Cache-Control', PUBLIC_PAGE_CACHE_CONTROL).redirect(`/${slug}`, 301);
}

/** ETag fraco do corpo renderizado. */
export function etagOf(body) {
  return `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

/** `If-None-Match` contém o ETag (comparação fraca, lista separada por vírgula ou `*`). */
function matchesEtag(header, etag) {
  if (typeof header !== 'string' || header.length === 0) return false;
  const opaque = etag.replace(/^W\//, '');
  return header.split(',').some((item) => {
    const tag = item.trim();
    return tag === '*' || tag.replace(/^W\//, '') === opaque;
  });
}

/** errorHandler das rotas públicas: nunca JSON e nunca eco. */
function publicErrorHandler(error, request, reply) {
  if (error && error.statusCode === 429) return sendRateLimitedPage(reply);
  if (error instanceof NotFoundError) return sendNotFoundPage(reply);
  request.log.error({ event: 'public_page_error', err: error });
  return sendHtml(reply, 500, ERROR_HTML, { cacheControl: NO_STORE });
}

/**
 * GET /:slug e GET /:slug/ (AF-09). Registrado por último em buildApp: as rotas estáticas de
 * PAGES têm prioridade no find-my-way e estão todas em RESERVED_SLUGS.
 */
export default async function publicPageRoutes(app) {
  const service = () => app.services.publicPageService;

  // Contador por IP compartilhado com o 404 HTML de fallback e o endpoint de horários (AF-09
  // item 3, AF-10 critério 25). sharedPublicGuards devolve objetos novos a cada chamada.
  app.get(
    '/:slug',
    { ...sharedPublicGuards(app.publicReadLimiter), errorHandler: publicErrorHandler },
    async (request, reply) => {
      const parsed = parsePublicSlug(request.params.slug);
      if (parsed.kind === 'invalid') return sendNotFoundPage(reply);
      if (parsed.kind === 'redirect') return sendCanonicalRedirect(reply, parsed.slug);

      const page = await service().getPage(parsed.slug);
      if (!page) return sendNotFoundPage(reply);

      const body = renderPublicPage(page);
      const etag = etagOf(body);
      reply.header('ETag', etag);
      if (matchesEtag(request.headers['if-none-match'], etag)) {
        return sendHtml(reply, 304, null, { cacheControl: PUBLIC_PAGE_CACHE_CONTROL });
      }
      return sendHtml(reply, 200, body, { cacheControl: PUBLIC_PAGE_CACHE_CONTROL });
    },
  );

  app.get(
    '/:slug/',
    { ...sharedPublicGuards(app.publicReadLimiter), errorHandler: publicErrorHandler },
    async (request, reply) => {
      const parsed = parsePublicSlug(request.params.slug);
      if (parsed.kind === 'invalid') return sendNotFoundPage(reply);
      return sendCanonicalRedirect(reply, parsed.slug);
    },
  );
}
