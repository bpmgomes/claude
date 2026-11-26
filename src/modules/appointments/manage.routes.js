import { createSharedPublicLimiter, sharedPublicGuards } from '../../http/route-guards.js';
import { sendHtml, publicErrorHandler } from '../public-page/public-page.routes.js';
import { MANAGE_PAGE_HTML } from './manage-page.render.js';

/** Cache da página e da API do gerenciar: nada guardado (critério 10). */
export const MANAGE_CACHE_CONTROL = 'no-store';

/**
 * Gerenciar o agendamento pelo link (AF-12, design 4.1 e 4.3). Plugin encapsulado: o `onSend` daqui
 * vale só para estas rotas (inclusive erros e 429). Todas públicas (`publicRoute`: o auth.plugin não
 * lê nem renova a sessão do dono), sem `Set-Cookie`. O token só aparece no caminho.
 * - Leituras (`GET manage` e `GET manage/availability`): contador compartilhado `publicPage` e o teto
 *   de leitura `publicManage` (um contador só para as duas).
 * - Escritas (`cancel` e `reschedule`): contador compartilhado e o teto `publicBooking`
 *   (`app.publicWriteLimiter`, o MESMO limitador da reserva do AF-11). CSRF global antes (403).
 * - Página `/agendamento/:token`: HTML fixo para qualquer token, contador compartilhado, 429 em HTML.
 * Ordem dos hooks: CSRF global, contador compartilhado, teto, parser JSON e handler. Um token 404
 * consome os contadores como qualquer pedido (critério 33). Sem log por requisição.
 */
export default async function manageRoutes(app) {
  const { config } = app;
  const manageReadLimiter = createSharedPublicLimiter(app, config, 'publicManage', { addHeaders: false });
  // Resolvido a cada requisição: os testes trocam relógio e porta de eventos.
  const service = () => app.services.manageService;

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex');
    reply.header('Cache-Control', MANAGE_CACHE_CONTROL);
    return payload;
  });

  app.get(
    '/agendamento/:token',
    { ...sharedPublicGuards(app.publicReadLimiter), errorHandler: publicErrorHandler },
    async (request, reply) => sendHtml(reply, 200, MANAGE_PAGE_HTML, { cacheControl: MANAGE_CACHE_CONTROL }),
  );

  const send = (reply, { status, body }) => reply.status(status).send(body);

  app.get('/api/public/manage/:token', sharedPublicGuards(app.publicReadLimiter, manageReadLimiter), async (request, reply) =>
    send(reply, await service().get(request.params.token)),
  );

  app.get(
    '/api/public/manage/:token/availability',
    sharedPublicGuards(app.publicReadLimiter, manageReadLimiter),
    async (request, reply) => send(reply, await service().availability(request.params.token, request.query)),
  );

  app.post(
    '/api/public/manage/:token/cancel',
    sharedPublicGuards(app.publicReadLimiter, app.publicWriteLimiter),
    async (request, reply) => send(reply, await service().cancel(request.params.token, request.body)),
  );

  app.post(
    '/api/public/manage/:token/reschedule',
    sharedPublicGuards(app.publicReadLimiter, app.publicWriteLimiter),
    async (request, reply) => send(reply, await service().reschedule(request.params.token, request.body)),
  );
}
