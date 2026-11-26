import { UnauthorizedError } from '../../http/errors.js';
import { toPublicUser } from '../accounts/users.repository.js';

export const SESSION_COOKIE = 'af_session';

const DAY_SECONDS = 24 * 60 * 60;

function cookieOptions(config) {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure: config.cookieSecure };
}

/**
 * Define o cookie de sessão. O Max-Age é o teto absoluto da sessão: quem
 * decide a validade real (inatividade) é o servidor.
 */
export function setSessionCookie(reply, token, config) {
  reply.setCookie(SESSION_COOKIE, token, {
    ...cookieOptions(config),
    maxAge: config.sessionAbsoluteTtlDays * DAY_SECONDS,
  });
}

/** Remove o cookie de sessão no cliente. */
export function clearSessionCookie(reply, config) {
  reply.setCookie(SESSION_COOKIE, '', { ...cookieOptions(config), maxAge: 0 });
}

/**
 * Plugin de autenticação. Encapsulamento desligado (equivalente a fastify-plugin),
 * para que o decorator e o hook valham para todas as rotas do app.
 */
async function authPlugin(app) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  app.addHook('onRequest', async (request) => {
    // Rotas públicas (AF-09, critério 22): a sessão do dono não é lida nem tocada.
    if (request.routeOptions?.config?.publicRoute === true) return;
    // Nenhum 404 precisa do usuário: o fallback (HTML ou JSON) não lê nem renova a sessão (AF-09 item 4).
    if (request.is404 === true) return;
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return;
    const { sessionsService, usersRepository } = app.services;
    const session = await sessionsService.resolveSession(token);
    if (!session) return;
    const user = await usersRepository.findById(session.userId);
    if (!user) return;
    request.user = toPublicUser(user);
    request.sessionId = session.sessionId;
  });
}
authPlugin[Symbol.for('skip-override')] = true;
authPlugin[Symbol.for('fastify.display-name')] = 'auth-plugin';

export default authPlugin;

/** preHandler para rotas protegidas. */
export async function requireAuth(request) {
  if (!request.user) throw new UnauthorizedError();
}
