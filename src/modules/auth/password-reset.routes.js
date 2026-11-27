import { clearSessionCookie } from './auth.plugin.js';
import { PASSWORD_RESET_MESSAGES, PASSWORD_RESET_REDIRECT, PASSWORD_RESET_PATH } from '../../shared/password-reset.js';
import { AuthRateLimitedError } from '../../http/errors.js';

/** Corpo do 202 (decisão 1): constante, serializada uma vez, igual em todos os caminhos (critério 2). */
export const PASSWORD_RESET_RESPONSE = Object.freeze({ message: PASSWORD_RESET_MESSAGES.requested });
const RESPONSE_JSON = JSON.stringify(PASSWORD_RESET_RESPONSE);
export const FORGOT_PASSWORD_PATH = '/esqueci-senha';
export const PASSWORD_RESET_PAGE_CACHE_CONTROL = 'no-store';

/**
 * Recuperação de senha (AF-03, design 4.1). Plugin encapsulado: o `onSend` daqui vale só para estas
 * rotas, inclusive erros. Todas públicas (`publicRoute`: a sessão não é lida nem renovada, então a
 * resposta não depende do cookie). CSRF global do AF-02 (Sec-Fetch-Site + Origin) e só JSON (415).
 * Sem @fastify/rate-limit: os limites são os persistidos (`passwordReset`). Logs só com os eventos de
 * 4.5 (nunca e-mail, token, link, senha, hash nem IP).
 * @param {import('fastify').FastifyInstance} app
 * @param {{ pages: { forgot: string, reset: string } }} options HTML lido no boot
 */
export default async function passwordResetRoutes(app, { pages }) {
  // Resolvido a cada requisição: os testes trocam dependências do serviço.
  const service = () => app.services.passwordResetService;
  const publicRoute = { config: { publicRoute: true } };

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex');
    return payload;
  });

  const page = (html) => async (request, reply) =>
    reply.header('Cache-Control', PASSWORD_RESET_PAGE_CACHE_CONTROL).type('text/html; charset=utf-8').send(html);
  app.get(FORGOT_PASSWORD_PATH, publicRoute, page(pages.forgot));
  app.get(PASSWORD_RESET_PATH, publicRoute, page(pages.reset));

  app.post('/api/auth/password-reset', publicRoute, async (request, reply) => {
    let result;
    try {
      result = await service().request(request.body, { ip: request.ip });
    } catch (err) {
      if (err instanceof AuthRateLimitedError) request.log.info({ event: 'password_reset_rate_limited', scope: 'request_ip' });
      throw err;
    }
    const entry = { event: 'password_reset_requested', outcome: result.outcome };
    if (result.userId) entry.userId = result.userId;
    request.log.info(entry);
    return reply.status(202).type('application/json; charset=utf-8').send(RESPONSE_JSON);
  });

  app.post('/api/auth/password-reset/confirm', publicRoute, async (request, reply) => {
    let result;
    try {
      result = await service().confirm(request.body, { ip: request.ip });
    } catch (err) {
      if (err instanceof AuthRateLimitedError) request.log.info({ event: 'password_reset_rate_limited', scope: 'confirm_ip' });
      else if (err && typeof err.reason === 'string') request.log.info({ event: 'password_reset_rejected', reason: err.reason });
      throw err;
    }
    request.log.info({ event: 'password_reset_completed', userId: result.userId });
    clearSessionCookie(reply, app.config);
    return reply.status(200).send({ message: PASSWORD_RESET_MESSAGES.changed, redirectTo: PASSWORD_RESET_REDIRECT });
  });
}
