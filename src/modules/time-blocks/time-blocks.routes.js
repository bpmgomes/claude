import { createRouteGuards } from '../../http/route-guards.js';

/**
 * /api/time-blocks (design AF-16, 4.1). Todas as rotas têm guards próprios (createRouteGuards
 * chamado inline, uma vez por rota): a listagem com o bucket `timeBlockRead` (limite por usuário,
 * critério 22) e o POST e o DELETE com instâncias próprias de `timeBlockWrite`. CSRF pelo hook
 * global. O negócio vem sempre da sessão; os logs de evento saem do serviço (sem motivo nem nomes).
 */
export default async function timeBlocksRoutes(app) {
  const { config } = app;
  // Resolvido a cada requisição: os testes trocam `app.services.timeBlocksService` por uma
  // instância com porta de agendamentos falsa (design AF-16, 4.3).
  const service = () => app.services.timeBlocksService;

  app.get('/api/time-blocks', createRouteGuards(config, 'timeBlockRead'), async (request) =>
    service().list(request.user.id, request.query),
  );

  app.post('/api/time-blocks', createRouteGuards(config, 'timeBlockWrite'), async (request, reply) => {
    const { timeBlock, acknowledgedConflictsCount, warnings } = await service().create(request.user.id, request.body);
    const payload = { timeBlock, acknowledgedConflictsCount };
    if (Array.isArray(warnings) && warnings.length > 0) payload.warnings = warnings;
    return reply.status(201).send(payload);
  });

  app.delete('/api/time-blocks/:id', createRouteGuards(config, 'timeBlockWrite'), async (request, reply) => {
    await service().remove(request.user.id, request.params.id);
    return reply.status(204).send();
  });
}
