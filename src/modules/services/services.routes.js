import { createRouteGuards, authOnly } from '../../http/route-guards.js';
import { SERVICE_ID_RE } from '../../shared/services.js';
import { toOwnerService } from './services.repository.js';

// O regex mora em src/shared/services.js porque o front também confere o id antes de montar a URL.
export { SERVICE_ID_RE };

/**
 * /api/services. Não há DELETE (decisão 8): cai no not-found handler (404) sem tocar no banco.
 * Leituras: só requireAuth. Mutações: guards próprios por rota, bucket `serviceWrite`
 * (createRouteGuards chamado inline, uma vez por rota).
 */
export default async function servicesRoutes(app) {
  const { servicesService } = app.services;
  const { config } = app;

  const logEvent = (request, event, service, extra = {}) =>
    request.log.info({ event, userId: request.user.id, businessId: service.businessId, serviceId: service.id, ...extra });

  app.get('/api/services', authOnly(), async (request) => {
    const services = await servicesService.list(request.user.id, request.query);
    return { services: services.map(toOwnerService) };
  });

  app.get('/api/services/:id', authOnly(), async (request) => {
    const service = await servicesService.get(request.user.id, request.params.id);
    return { service: toOwnerService(service) };
  });

  app.post('/api/services', createRouteGuards(config, 'serviceWrite'), async (request, reply) => {
    const service = await servicesService.create(request.user.id, request.body);
    logEvent(request, 'service_created', service);
    return reply.status(201).send({ service: toOwnerService(service) });
  });

  app.patch('/api/services/:id', createRouteGuards(config, 'serviceWrite'), async (request) => {
    const service = await servicesService.update(request.user.id, request.params.id, request.body);
    logEvent(request, 'service_updated', service);
    return { service: toOwnerService(service) };
  });

  app.post('/api/services/:id/deactivate', createRouteGuards(config, 'serviceWrite'), async (request) => {
    const { service, futureAppointmentsCount } = await servicesService.deactivate(request.user.id, request.params.id);
    logEvent(request, 'service_deactivated', service, { futureAppointmentsCount });
    return { service: toOwnerService(service), futureAppointmentsCount };
  });

  app.post('/api/services/:id/reactivate', createRouteGuards(config, 'serviceWrite'), async (request) => {
    const { service } = await servicesService.reactivate(request.user.id, request.params.id);
    logEvent(request, 'service_reactivated', service);
    return { service: toOwnerService(service) };
  });
}
