import { createSharedPublicLimiter, sharedPublicGuards } from '../../http/route-guards.js';

/** Política de cache do endpoint (decisão 6): nada em cache, nem nos erros. */
export const AVAILABILITY_CACHE_CONTROL = 'no-store';

/**
 * GET /api/public/:slug/availability (design AF-10, 4.1 e 4.3). Pública (`publicRoute`: o
 * auth.plugin não lê a sessão) e sem CSRF por ser GET.
 * - onRequest: o contador por IP compartilhado com `/:slug`, `/:slug/` e o 404 HTML de fallback
 *   (`app.publicReadLimiter`) e, depois, o teto de custo próprio (`publicAvailability`). Uma consulta
 *   consome os dois.
 * - onSend: `Cache-Control: no-store` em toda resposta da rota, inclusive 400, 404, 429 e 503.
 * - errorHandler: o padrão do app (JSON).
 * Nenhum log por consulta (rota pública); os eventos de lentidão e de falha saem do serviço.
 */
export default async function availabilityRoutes(app) {
  const { config } = app;
  const availabilityCostLimiter = createSharedPublicLimiter(app, config, 'publicAvailability', { addHeaders: false });
  // Resolvido a cada requisição: os testes trocam a porta de agendamentos e o relógio.
  const service = () => app.services.availabilityService;

  app.get(
    '/api/public/:slug/availability',
    {
      ...sharedPublicGuards(app.publicReadLimiter, availabilityCostLimiter),
      onSend: async (request, reply, payload) => {
        reply.header('Cache-Control', AVAILABILITY_CACHE_CONTROL);
        return payload;
      },
    },
    async (request) => service().getAvailability(request.params.slug, request.query),
  );
}
