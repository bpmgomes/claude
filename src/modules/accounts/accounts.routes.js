import { SESSION_COOKIE, requireAuth } from '../auth/auth.plugin.js';

const DAY_SECONDS = 24 * 60 * 60;

export default async function accountsRoutes(app) {
  const { accountsService } = app.services;
  const { config } = app;

  const signupRateLimit = config.rateLimit.enabled
    ? { rateLimit: { max: config.rateLimit.signupMax, timeWindow: config.rateLimit.timeWindow } }
    : {};

  app.post('/api/accounts', { config: signupRateLimit }, async (request, reply) => {
    const { user, session } = await accountsService.signup(request.body);
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: config.cookieSecure,
      maxAge: config.sessionTtlDays * DAY_SECONDS,
    });
    return reply.status(201).send({ user, redirectTo: '/onboarding' });
  });

  app.get('/api/me', { preHandler: requireAuth }, async (request) => {
    return { user: request.user };
  });
}
