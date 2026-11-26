import { createRouteGuards } from '../../http/route-guards.js';

/**
 * /api/agenda (design AF-14, 4.1). Todas as rotas exigem sessão e têm guards próprios
 * (createRouteGuards chamado inline, uma vez por rota): a lista e o detalhe com instâncias próprias
 * de `agendaRead`, o cancelamento com `agendaCancel`. CSRF pelo hook global. O negócio vem sempre da
 * sessão; `businessId` na query, no corpo ou no caminho é ignorado. Não há rota de exportação.
 */
export default async function agendaRoutes(app) {
  const { config } = app;
  // Resolvido a cada requisição: os testes trocam `app.services.agendaService` por uma instância
  // com repositórios falsos (atomicidade e 503).
  const service = () => app.services.agendaService;

  app.get('/api/agenda', createRouteGuards(config, 'agendaRead'), async (request) =>
    service().list(request.user.id, request.query),
  );

  app.get('/api/agenda/appointments/:id', createRouteGuards(config, 'agendaRead'), async (request) =>
    service().detail(request.user.id, request.params.id),
  );

  app.post('/api/agenda/appointments/:id/cancel', createRouteGuards(config, 'agendaCancel'), async (request) =>
    service().cancel(request.user.id, request.params.id, request.body),
  );
}
