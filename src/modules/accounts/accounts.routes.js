import { setSessionCookie, requireAuth } from '../auth/auth.plugin.js';

export default async function accountsRoutes(app) {
  const { accountsService } = app.services;
  const { config } = app;

  const signupRateLimit = config.rateLimit.enabled
    ? { rateLimit: { max: config.rateLimit.signupMax, timeWindow: config.rateLimit.timeWindow } }
    : {};

  app.post('/api/accounts', { config: signupRateLimit }, async (request, reply) => {
    const { user, session } = await accountsService.signup(request.body, {
      previousSessionId: request.sessionId,
    });
    setSessionCookie(reply, session.token, config);
    return reply.status(201).send({ user, redirectTo: '/onboarding' });
  });

  app.get('/api/me', { preHandler: requireAuth }, async (request) => {
    return { user: request.user };
  });
}
