import { setSessionCookie, clearSessionCookie } from './auth.plugin.js';
import { InvalidCredentialsError } from '../../http/errors.js';

export default async function authRoutes(app) {
  const { authService } = app.services;
  const { config } = app;

  const loginRateLimit = config.rateLimit.enabled
    ? { rateLimit: { max: config.rateLimit.loginMax, timeWindow: config.rateLimit.timeWindow } }
    : {};

  app.post('/api/auth/login', { config: loginRateLimit }, async (request, reply) => {
    let result;
    try {
      result = await authService.login(request.body, {
        ip: request.ip,
        previousSessionId: request.sessionId,
      });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) request.log.info({ event: 'login_failed' });
      throw err;
    }
    const { user, session, redirectTo } = result;
    request.log.info({ event: 'login_succeeded', userId: user.id });
    setSessionCookie(reply, session.token, config);
    return reply.status(200).send({ user, redirectTo });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await authService.logout(request.sessionId);
    clearSessionCookie(reply, config);
    return reply.status(204).send();
  });
}
