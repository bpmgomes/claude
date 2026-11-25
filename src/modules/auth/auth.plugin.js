import { UnauthorizedError } from '../../http/errors.js';
import { toPublicUser } from '../accounts/users.repository.js';

export const SESSION_COOKIE = 'af_session';

/**
 * Plugin de autenticação. Encapsulamento desligado (equivalente a fastify-plugin),
 * para que o decorator e o hook valham para todas as rotas do app.
 */
async function authPlugin(app) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  app.addHook('onRequest', async (request) => {
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
