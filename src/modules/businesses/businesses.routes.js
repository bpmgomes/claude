import { createRouteGuards, createPublicRouteGuards, authOnly } from '../../http/route-guards.js';
import { NotFoundError, InvalidImageError, ImageBusyError } from '../../http/errors.js';
import { LOGO_MAX_BYTES } from '../../shared/validation.js';
import { toOwnerBusiness } from './businesses.repository.js';
import { NEXT_STEP_PATH } from './businesses.service.js';

/** Nome de arquivo servido: exatamente `<uuid v4>.png`, como o servidor gera. */
export const LOGO_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;

export const LOGO_CONTENT_TYPES = Object.freeze(['application/octet-stream', 'image/png', 'image/jpeg']);

/**
 * Cache de `/media/*` (logo e foto): 1 dia, sem `immutable` (design AF-07, decisão 8;
 * fecha AF-05 item 4). Cada upload gera uma URL nova.
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=86400';

const LOGO_TOO_LARGE = Object.freeze({ code: 'LOGO_TOO_LARGE', message: 'O logo deve ter no máximo 2 MB.' });

export default async function businessesRoutes(app) {
  const { businessesService, businessesRepository, storage } = app.services;
  const { config } = app;
  const serialize = (business) => toOwnerBusiness(business, { publicBaseUrl: config.publicBaseUrl });

  // Guards próprios por rota (createRouteGuards chamado inline em cada uma): contadores
  // de IP e de usuário não são divididos entre rotas (AF-05 item 1, design AF-06 seção 2).
  app.get('/api/business', authOnly(), async (request) => {
    const business = await businessesService.getForOwner(request.user.id);
    return { business: serialize(business) };
  });

  app.post('/api/business', createRouteGuards(config, 'businessWrite'), async (request, reply) => {
    const business = await businessesService.create(request.user.id, request.body);
    request.log.info({ event: 'business_created', userId: request.user.id, businessId: business.id });
    return reply.status(201).send({ business: serialize(business), redirectTo: NEXT_STEP_PATH });
  });

  app.patch('/api/business', createRouteGuards(config, 'businessWrite'), async (request) => {
    const business = await businessesService.update(request.user.id, request.body);
    request.log.info({ event: 'business_updated', userId: request.user.id, businessId: business.id });
    return { business: serialize(business) };
  });

  app.get('/api/business/slug-availability', createRouteGuards(config, 'businessWrite'), async (request) => {
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

    const putGuards = createRouteGuards(config, 'logoUpload');
    logoApp.put(
      '/api/business/logo',
      {
        bodyLimit: LOGO_MAX_BYTES,
        ...putGuards,
        config: { ...putGuards.config, payloadTooLarge: LOGO_TOO_LARGE },
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
          } else if (err instanceof ImageBusyError) {
            request.log.warn({ event: 'image_busy', userId: request.user.id });
          }
          throw err;
        }
      },
    );

    logoApp.delete('/api/business/logo', createRouteGuards(config, 'logoUpload'), async (request, reply) => {
      await businessesService.removeLogo(request.user.id);
      return reply.status(204).send();
    });
  });

  // Público (usado pelo AF-09). Só entrega arquivo referenciado no banco; nada é interpretado.
  // `X-Content-Type-Options: nosniff` vem do helmet (global).
  // Guards públicos próprios (AF-09, critério 19): limite por IP, sem ler a sessão.
  app.get('/media/logos/:file', createPublicRouteGuards(config, 'publicMedia'), async (request, reply) => {
    const { file } = request.params;
    if (typeof file !== 'string' || !LOGO_FILE_RE.test(file)) throw new NotFoundError();
    const key = `logos/${file}`;
    if (!(await businessesRepository.existsLogoKey(key))) throw new NotFoundError();
    const body = await storage.get(key);
    if (!body) throw new NotFoundError();
    return reply
      .header('Content-Type', 'image/png')
      .header('Content-Disposition', 'inline; filename="logo.png"')
      .header('Cache-Control', MEDIA_CACHE_CONTROL)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(body);
  });
}
