// Emissor ÚNICO de tokens de gerenciar (AF-18, design 4.3, critério 11; fecha docs/security/AF-12.md
// item 2). Usado pela reserva e pela repetição idempotente (AF-11) e pelo worker de e-mail (AF-18).
import { newManageToken, manageUrlOf } from './manage-token.js';
import { MANAGE_TOKENS_LIVE_MAX } from '../../shared/appointments.js';

/**
 * Emite um token do AF-12 na transação do chamador e aplica o teto de MANAGE_TOKENS_LIVE_MAX (5)
 * tokens VIVOS (expires_at > agora, revogados ou não, porque um revogado ainda abre a página) por
 * agendamento: insert + trimLive na mesma tx. Cancelado: o token já nasce revogado ('cancelled').
 * O texto puro só existe no retorno; nunca é gravado nem logado.
 * @param {{
 *   manageTokensRepository: ReturnType<typeof import('./manage-tokens.repository.js').createManageTokensRepository>,
 *   publicBaseUrl: string,
 *   newToken?: typeof newManageToken,
 *   liveMax?: number,
 * }} deps
 */
export function createManageTokenIssuer({ manageTokensRepository, publicBaseUrl, newToken = newManageToken, liveMax = MANAGE_TOKENS_LIVE_MAX }) {
  return {
    /**
     * @param {import('../../db/index.js').Database} tx
     * @param {{ businessId: string, appointmentId: string, expiresAt: string, status: string, nowIso: string }} args
     * @returns {Promise<{ url: string, tokenHash: string }>}
     */
    async issue(tx, { businessId, appointmentId, expiresAt, status, nowIso }) {
      const { token, tokenHash } = newToken();
      const cancelled = status === 'cancelled';
      await manageTokensRepository.insert(
        {
          tokenHash,
          businessId,
          appointmentId,
          createdAt: nowIso,
          expiresAt,
          revokedAt: cancelled ? nowIso : null,
          revokedReason: cancelled ? 'cancelled' : null,
        },
        tx,
      );
      await manageTokensRepository.trimLive(businessId, appointmentId, { keep: liveMax, nowIso, exceptHash: tokenHash }, tx);
      return { url: manageUrlOf(publicBaseUrl, token), tokenHash };
    },
  };
}
