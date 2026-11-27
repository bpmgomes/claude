import { randomUUID } from 'node:crypto';
import { validateSignup } from '../../shared/validation.js';
import { hashPassword } from '../auth/password.js';
import { toPublicUser } from './users.repository.js';
import { UniqueViolationError } from '../../db/errors.js';
import { ValidationError, ConflictError } from '../../http/errors.js';

const EMAIL_TAKEN_MESSAGE = 'Este e-mail já está cadastrado.';

export function createAccountsService({ db, usersRepository, sessionsService, config, now = () => new Date() }) { // utc
  return {
    /**
     * Revoga a sessão anterior ativa (se houver) na mesma transação que cria a nova.
     * @param {unknown} input
     * @param {{ previousSessionId?: string|null }} [options]
     * @returns {Promise<{ user: import('./users.repository.js').PublicUser, session: { token: string, expiresAt: string } }>}
     * @throws {ValidationError|ConflictError}
     */
    async signup(input, { previousSessionId } = {}) {
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
          await sessionsService.revokeSession(previousSessionId, { conn: tx });
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
