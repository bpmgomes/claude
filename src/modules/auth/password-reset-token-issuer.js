// Emissor de tokens de redefinição (AF-03, design 4.3, decisão 12 do Gerente): roda na transação de
// preparo do worker, então a hora de validade começa quando o e-mail sai.
import { newResetToken, resetUrlOf } from './password-reset-token.js';
import { PASSWORD_RESET_TTL_MS } from '../../shared/password-reset.js';

/**
 * @param {{
 *   passwordResetTokensRepository: ReturnType<typeof import('./password-reset-tokens.repository.js').createPasswordResetTokensRepository>,
 *   publicBaseUrl: string,
 *   newToken?: typeof newResetToken,
 * }} deps
 */
export function createPasswordResetTokenIssuer({ passwordResetTokensRepository, publicBaseUrl, newToken = newResetToken }) {
  return {
    /**
     * Na transação do worker: deletePendingForUser e insert (createdAt = agora, expiresAt = agora + 1 h).
     * É o ÚNICO ponto, além da troca de senha, que invalida links pendentes (revisão de segurança,
     * decisão 1): só o link mais recente efetivamente emitido vale.
     * O texto puro só existe no retorno; nunca é gravado nem logado.
     * @param {import('../../db/index.js').Database} tx
     * @param {{ userId: string, nowIso: string }} args
     * @returns {Promise<{ url: string, tokenHash: string }>}
     */
    async issue(tx, { userId, nowIso }) {
      const { token, tokenHash } = newToken();
      await passwordResetTokensRepository.deletePendingForUser(userId, tx);
      await passwordResetTokensRepository.insert(
        { tokenHash, userId, createdAt: nowIso, expiresAt: new Date(Date.parse(nowIso) + PASSWORD_RESET_TTL_MS).toISOString() },
        tx,
      );
      return { url: resetUrlOf(publicBaseUrl, token), tokenHash };
    },
  };
}
