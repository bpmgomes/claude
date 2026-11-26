import { createRouteGuards, createPublicRouteGuards, authOnly } from '../../http/route-guards.js';
import { NotFoundError } from '../../http/errors.js';
import { LOGO_MAX_BYTES } from '../../shared/validation.js';
import { PROFESSIONAL_MESSAGES } from '../../shared/professionals.js';
import { LOGO_FILE_RE, LOGO_CONTENT_TYPES, MEDIA_CACHE_CONTROL } from '../businesses/businesses.routes.js';
import { toOwnerProfessional } from './professionals.repository.js';

/** Nome de arquivo servido: exatamente `<uuid v4>.png`, como o servidor gera (o mesmo do logo). */
export const PHOTO_FILE_RE = LOGO_FILE_RE;

export const PHOTO_CONTENT_TYPES = LOGO_CONTENT_TYPES;

/** Mesmo limite do logo: 2.097.152 bytes, inclusive. */
export const PHOTO_MAX_BYTES = LOGO_MAX_BYTES;

export { MEDIA_CACHE_CONTROL };

const PHOTO_TOO_LARGE = Object.freeze({ code: 'PHOTO_TOO_LARGE', message: PROFESSIONAL_MESSAGES.photoTooLarge });

function withWarnings(payload, warnings) {
  if (Array.isArray(warnings) && warnings.length > 0) payload.warnings = warnings;
  return payload;
}

/**
 * /api/professionals. Leituras: só requireAuth. Mutações: guards próprios por rota
 * (createRouteGuards chamado inline, uma vez por rota), buckets `professionalWrite` e
 * `professionalPhoto`. Os logs de evento saem do serviço (sem o nome).
 */
export default async function professionalsRoutes(app) {
  const { professionalsRepository, storage } = app.services;
  const { config } = app;
  // Resolvido a cada requisição: os testes de API trocam `app.services.professionalsService`
  // por uma instância com porta de agendamentos falsa (design AF-07, seção 7).
  const service = () => app.services.professionalsService;

  app.get('/api/professionals', authOnly(), async (request) => {
    const professionals = await service().list(request.user.id);
    return { professionals: professionals.map(toOwnerProfessional) };
  });

  app.get('/api/professionals/:id', authOnly(), async (request) => {
    const professional = await service().get(request.user.id, request.params.id);
    return { professional: toOwnerProfessional(professional) };
  });

  app.post('/api/professionals', createRouteGuards(config, 'professionalWrite'), async (request, reply) => {
    const { professional, warnings } = await service().create(request.user.id, request.body);
    return reply.status(201).send(withWarnings({ professional: toOwnerProfessional(professional) }, warnings));
  });

  app.patch('/api/professionals/:id', createRouteGuards(config, 'professionalWrite'), async (request) => {
    const { professional, warnings } = await service().update(
      request.user.id,
      request.params.id,
      request.body,
    );
    return withWarnings({ professional: toOwnerProfessional(professional) }, warnings);
  });

  app.delete('/api/professionals/:id', createRouteGuards(config, 'professionalWrite'), async (request, reply) => {
    await service().remove(request.user.id, request.params.id);
    return reply.status(204).send();
  });

  // Foto: sub-plugin encapsulado com parser binário próprio (mesmo contrato do logo).
  await app.register(async (photoApp) => {
    photoApp.removeAllContentTypeParsers();
    photoApp.addContentTypeParser(
      PHOTO_CONTENT_TYPES,
      { parseAs: 'buffer', bodyLimit: PHOTO_MAX_BYTES },
      (request, body, done) => done(null, body),
    );

    const putGuards = createRouteGuards(config, 'professionalPhoto');
    photoApp.put(
      '/api/professionals/:id/photo',
      {
        bodyLimit: PHOTO_MAX_BYTES,
        ...putGuards,
        config: { ...putGuards.config, payloadTooLarge: PHOTO_TOO_LARGE },
      },
      async (request) => {
        const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const professional = await service().setPhoto(request.user.id, request.params.id, buffer);
        return { professional: toOwnerProfessional(professional) };
      },
    );

    photoApp.delete(
      '/api/professionals/:id/photo',
      createRouteGuards(config, 'professionalPhoto'),
      async (request, reply) => {
        await service().removePhoto(request.user.id, request.params.id);
        return reply.status(204).send();
      },
    );
  });

  // Público (usado pelo AF-09). Só entrega arquivo referenciado no banco por profissional ativo.
  // `X-Content-Type-Options: nosniff` vem do helmet (global).
  // Guards públicos próprios (AF-09, critério 19): limite por IP, sem ler a sessão.
  app.get('/media/professionals/:file', createPublicRouteGuards(config, 'publicMedia'), async (request, reply) => {
    const { file } = request.params;
    if (typeof file !== 'string' || !PHOTO_FILE_RE.test(file)) throw new NotFoundError();
    const key = `professionals/${file}`;
    if (!(await professionalsRepository.existsPhotoKey(key))) throw new NotFoundError();
    const body = await storage.get(key);
    if (!body) throw new NotFoundError();
    return reply
      .header('Content-Type', 'image/png')
      .header('Content-Disposition', 'inline; filename="foto.png"')
      .header('Cache-Control', MEDIA_CACHE_CONTROL)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(body);
  });
}
