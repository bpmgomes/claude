import { randomUUID } from 'node:crypto';
import { validateSignup } from '../../shared/validation.js';
import { hashPassword } from '../auth/password.js';
import { toPublicUser } from './users.repository.js';
import { UniqueViolationError } from '../../db/errors.js';
import { ValidationError, ConflictError } from '../../http/errors.js';

const EMAIL_TAKEN_MESSAGE = 'Este e-mail já está cadastrado.';

export function createAccountsService({ db, usersRepository, sessionsService, config, now = () => new Date() }) {
  return {
    /**
     * @returns {Promise<{ user: import('./users.repository.js').PublicUser, session: { token: string, expiresAt: string } }>}
     * @throws {ValidationError|ConflictError}
     */
    async signup(input) {
      const result = validateSignup(input);
      if (!result.ok) throw new ValidationError(result.fields);
      const { name, email, password } = result.value;

      const passwordHash = await hashPassword(password, config.bcryptCost);

      try {
        return await db.transaction(async (tx) => {
          const user = await usersRepository.insert(
            { id: randomUUID(), name, email, passwordHash, createdAt: now().toISOString() },
            tx,
          );
          const session = await sessionsService.createSession(user.id, { conn: tx });
          return { user: toPublicUser(user), session };
        });
      } catch (err) {
        if (err instanceof UniqueViolationError && err.constraint === 'users_email_unique') {
          throw new ConflictError('EMAIL_TAKEN', EMAIL_TAKEN_MESSAGE, { email: EMAIL_TAKEN_MESSAGE });
        }
        throw err;
      }
    },
  };
}
