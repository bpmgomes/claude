import { sharedPublicGuards } from '../../http/route-guards.js';

/**
 * POST /api/public/:slug/appointments (AF-11, design 4.1). Pública (`publicRoute`: o auth.plugin não
 * lê nem renova a sessão do dono); CSRF pelo hook global de Fetch Metadata e `Origin`; corpo JSON de
 * até 16 KB (413/415 pelos padrões do app); `Cache-Control: no-store` pelo hook global de `/api/*`.
 * - onRequest: o contador por IP compartilhado com as leituras públicas (`app.publicReadLimiter`) e,
 *   depois, o teto de escrita `publicBooking` (`app.publicWriteLimiter`, criado no buildApp e
 *   COMPARTILHADO com cancelar e remarcar do AF-12, critério 33). Uma reserva consome os dois; um POST
 *   de outra origem dá 403 antes (o CSRF é `onRequest` global) e não consome contador.
 * Sem log por requisição (rota pública); os eventos saem do serviço.
 */
export default async function appointmentsRoutes(app) {
  // Resolvido a cada requisição: os testes trocam relógio, porta de eventos e porta de agendamentos.
  const service = () => app.services.appointmentsService;

  app.post(
    '/api/public/:slug/appointments',
    sharedPublicGuards(app.publicReadLimiter, app.publicWriteLimiter),
    async (request, reply) => {
      const { status, body } = await service().book(request.params.slug, request.body, {
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply.status(status).send(body);
    },
  );
}
