import { randomBytes } from 'node:crypto';
import { validateLogin, PASSWORD_MAX_BYTES } from '../../shared/validation.js';
import { hashPassword, verifyPassword as defaultVerifyPassword } from './password.js';
import { attemptKey } from './login-attempts.service.js';
import { toPublicUser } from '../accounts/users.repository.js';
import { ValidationError, LoginLockedError, InvalidCredentialsError } from '../../http/errors.js';
import { NEXT_STEP_PATH } from '../businesses/businesses.service.js';

/**
 * Para onde o dono vai depois do login: com negócio, para o próximo passo da
 * configuração (serviços); sem negócio, para o onboarding.
 * @param {{ hasBusiness: boolean }} state
 * @returns {string}
 */
export function resolvePostLoginRedirect({ hasBusiness }) {
  return hasBusiness ? NEXT_STEP_PATH : '/onboarding';
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

export function createAuthService({
  db,
  usersRepository,
  sessionsService,
  loginAttemptsService,
  businessesRepository,
  config,
  // eslint-disable-next-line no-unused-vars
  now = () => new Date(),
  verifyPassword = defaultVerifyPassword,
}) {
  // Hash de referência com o mesmo custo dos hashes reais: o bcrypt roda também
  // quando o e-mail não existe (critério 6).
  const dummyHash = hashPassword(randomBytes(32).toString('hex'), config.bcryptCost);

  return {
    /**
     * @param {unknown} input
     * @param {{ ip: string, previousSessionId?: string|null }} context
     * @returns {Promise<{ user: import('../accounts/users.repository.js').PublicUser, session: { token: string, expiresAt: string }, redirectTo: string }>}
     * @throws {ValidationError|LoginLockedError|InvalidCredentialsError}
     */
    async login(input, { ip, previousSessionId } = {}) {
      const result = validateLogin(input);
      if (!result.ok) throw new ValidationError(result.fields);
      const { email, password } = result.value;

      const key = attemptKey(email, ip);
      const reservation = await loginAttemptsService.reserve(key);
      if (!reservation.allowed) throw new LoginLockedError(reservation.retryAfterSeconds);

      const user = await usersRepository.findByEmail(email);
      let ok = await verifyPassword(password, user ? user.passwordHash : await dummyHash);
      ok = ok && Boolean(user) && byteLength(password) <= PASSWORD_MAX_BYTES;
      if (!ok) throw new InvalidCredentialsError();

      const session = await db.transaction(async (tx) => {
        await loginAttemptsService.clear(key, { conn: tx });
        await sessionsService.revokeSession(previousSessionId, { conn: tx });
        return sessionsService.createSession(user.id, { conn: tx });
      });

      const hasBusiness = Boolean(await businessesRepository.findByOwnerId(user.id));
      return { user: toPublicUser(user), session, redirectTo: resolvePostLoginRedirect({ hasBusiness }) };
    },

    /** Revoga só a sessão atual. Idempotente. */
    async logout(sessionId) {
      await sessionsService.revokeSession(sessionId);
    },
  };
}
