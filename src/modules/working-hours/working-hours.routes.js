import { createRouteGuards, authOnly } from '../../http/route-guards.js';
import { HOURS_MESSAGES } from '../../shared/working-hours.js';

export const APPOINTMENTS_OUTSIDE_WARNING = Object.freeze({
  code: 'HOURS_APPOINTMENTS_OUTSIDE',
  message: HOURS_MESSAGES.appointmentsOutside,
});

/**
 * /api/professionals/:id/hours. Leitura: só requireAuth. Gravação: guards próprios da rota
 * (createRouteGuards chamado inline), bucket `hoursWrite`. CSRF pelo hook global.
 * Os logs de evento saem do serviço (sem horários nem nome).
 */
export default async function workingHoursRoutes(app) {
  const { config } = app;
  // Resolvido a cada requisição: os testes trocam `app.services.workingHoursService` por uma
  // instância com porta de agendamentos falsa (design AF-08, 4.3).
  const service = () => app.services.workingHoursService;

  app.get('/api/professionals/:id/hours', authOnly(), async (request) => {
    const hours = await service().get(request.user.id, request.params.id);
    return { hours };
  });

  app.put('/api/professionals/:id/hours', createRouteGuards(config, 'hoursWrite'), async (request) => {
    const { hours, affectedAppointmentsCount } = await service().replace(
      request.user.id,
      request.params.id,
      request.body,
    );
    const payload = { hours, affectedAppointmentsCount };
    if (Number.isInteger(affectedAppointmentsCount) && affectedAppointmentsCount > 0) {
      payload.warnings = [{ ...APPOINTMENTS_OUTSIDE_WARNING }];
    }
    return payload;
  });
}
