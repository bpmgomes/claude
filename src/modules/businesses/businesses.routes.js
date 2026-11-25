import { requireAuth } from '../auth/auth.plugin.js';
import { createUserRateLimit } from '../../http/user-rate-limit.js';
import { NotFoundError, InvalidImageError } from '../../http/errors.js';
import { LOGO_MAX_BYTES } from '../../shared/validation.js';
import { toOwnerBusiness } from './businesses.repository.js';
import { NEXT_STEP_PATH } from './businesses.service.js';

/** Nome de arquivo servido: exatamente `<uuid v4>.png`, como o servidor gera. */
export const LOGO_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;

export const LOGO_CONTENT_TYPES = Object.freeze(['application/octet-stream', 'image/png', 'image/jpeg']);

const LOGO_TOO_LARGE = Object.freeze({ code: 'LOGO_TOO_LARGE', message: 'O logo deve ter no máximo 2 MB.' });

/**
 * Hooks e config de rota para um bucket de limite (`businessWrite` ou `logoUpload`).
 * Ordem no onRequest: requireAuth (401), limite por usuário e, depois (adicionado pelo
 * @fastify/rate-limit), limite por IP. O corpo ainda não foi lido em nenhum deles.
 */
function guardsFor(config, bucket) {
  const rl = config.rateLimit;
  if (!rl.enabled) return { onRequest: [requireAuth], config: {} };
  const userLimit = createUserRateLimit({ max: rl[bucket].perUser, timeWindow: rl.timeWindow });
  return {
    onRequest: [requireAuth, userLimit],
    config: { rateLimit: { max: rl[bucket].perIp, timeWindow: rl.timeWindow } },
  };
}

export default async function businessesRoutes(app) {
  const { businessesService, businessesRepository, storage } = app.services;
  const { config } = app;
  const serialize = (business) => toOwnerBusiness(business, { publicBaseUrl: config.publicBaseUrl });

  const write = guardsFor(config, 'businessWrite');
  const logo = guardsFor(config, 'logoUpload');

  app.get('/api/business', { onRequest: requireAuth }, async (request) => {
    const business = await businessesService.getForOwner(request.user.id);
    return { business: serialize(business) };
  });

  app.post('/api/business', write, async (request, reply) => {
    const business = await businessesService.create(request.user.id, request.body);
    request.log.info({ event: 'business_created', userId: request.user.id, businessId: business.id });
    return reply.status(201).send({ business: serialize(business), redirectTo: NEXT_STEP_PATH });
  });

  app.patch('/api/business', write, async (request) => {
    const business = await businessesService.update(request.user.id, request.body);
    request.log.info({ event: 'business_updated', userId: request.user.id, businessId: business.id });
    return { business: serialize(business) };
  });

  app.get('/api/business/slug-availability', write, async (request) => {
    const query = request.query || {};
    return businessesService.checkSlug(request.user.id, query.slug);
  });

  // Logo: sub-plugin encapsulado, o único lugar que aceita corpo binário.
  await app.register(async (logoApp) => {
    logoApp.removeAllContentTypeParsers();
    logoApp.addContentTypeParser(
      LOGO_CONTENT_TYPES,
      { parseAs: 'buffer', bodyLimit: LOGO_MAX_BYTES },
      (request, body, done) => done(null, body),
    );

    logoApp.put(
      '/api/business/logo',
      {
        bodyLimit: LOGO_MAX_BYTES,
        onRequest: logo.onRequest,
        config: { ...logo.config, payloadTooLarge: LOGO_TOO_LARGE },
      },
      async (request) => {
        const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        try {
          const business = await businessesService.setLogo(request.user.id, buffer);
          request.log.info({ event: 'logo_updated', userId: request.user.id, businessId: business.id });
          return { business: serialize(business) };
        } catch (err) {
          if (err instanceof InvalidImageError) {
            request.log.info({ event: 'logo_rejected', reason: err.reason || 'invalid' });
          }
          throw err;
        }
      },
    );

    logoApp.delete('/api/business/logo', logo, async (request, reply) => {
      await businessesService.removeLogo(request.user.id);
      return reply.status(204).send();
    });
  });

  // Público (usado pelo AF-09). Só entrega arquivo referenciado no banco; nada é interpretado.
  // `X-Content-Type-Options: nosniff` vem do helmet (global).
  app.get('/media/logos/:file', async (request, reply) => {
    const { file } = request.params;
    if (typeof file !== 'string' || !LOGO_FILE_RE.test(file)) throw new NotFoundError();
    const key = `logos/${file}`;
    if (!(await businessesRepository.existsLogoKey(key))) throw new NotFoundError();
    const body = await storage.get(key);
    if (!body) throw new NotFoundError();
    return reply
      .header('Content-Type', 'image/png')
      .header('Content-Disposition', 'inline; filename="logo.png"')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(body);
  });
}
