/**
 * Tokens de gerenciar (AF-12, design 4.3). Só o hash é gravado. Todo acesso filtra por
 * `business_id`, exceto a busca pelo hash, que é a ORIGEM do `business_id`. `conn` é a conexão ou
 * a transação do chamador (padrão: o `db` global).
 *
 * `revoked_reason`: `cancelled` (cancelado pelo link). `rescheduled` está no CHECK (critério 5), mas
 * nenhum fluxo do AF-12 o grava: remarcar MOVE o token (decisão 4). Fica reservado para um futuro
 * "trocar o link".
 *
 * @typedef {{ businessId: string, appointmentId: string, expiresAt: string, revokedAt: string|null,
 *   revokedReason: string|null }} ManageTokenRow
 * @param {import('../../db/index.js').Database} db
 */
export function createManageTokensRepository(db) {
  return {
    async insert(
      { tokenHash, businessId, appointmentId, createdAt, expiresAt, revokedAt = null, revokedReason = null },
      conn = db,
    ) {
      await conn.run(
        `INSERT INTO appointment_manage_tokens
           (token_hash, business_id, appointment_id, created_at, expires_at, revoked_at, revoked_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tokenHash, businessId, appointmentId, createdAt, expiresAt, revokedAt, revokedReason],
      );
    },

    /**
     * Token vivo (`expires_at > agora`), revogado ou não. Uma consulta só, a mesma para inexistente e
     * vencido (critério 35).
     * @returns {Promise<ManageTokenRow|undefined>}
     */
    async findLiveByHash(tokenHash, nowIso, conn = db) {
      const row = await conn.get(
        `SELECT business_id, appointment_id, expires_at, revoked_at, revoked_reason FROM appointment_manage_tokens
          WHERE token_hash = ? AND expires_at > ?`,
        [tokenHash, nowIso],
      );
      if (!row) return undefined;
      return {
        businessId: row.business_id,
        appointmentId: row.appointment_id,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at ?? null,
        revokedReason: row.revoked_reason ?? null,
      };
    },

    /** Revoga todos os tokens ainda não revogados do agendamento. @returns {Promise<{ changes: number }>} */
    async revokeForAppointment(businessId, appointmentId, reason, nowIso, conn = db) {
      return conn.run(
        `UPDATE appointment_manage_tokens SET revoked_at = ?, revoked_reason = ?
          WHERE business_id = ? AND appointment_id = ? AND revoked_at IS NULL`,
        [nowIso, reason, businessId, appointmentId],
      );
    },

    /**
     * Aponta os tokens não revogados do antigo para o novo agendamento (decisão 4), com
     * `expires_at` = `ends_at` do novo. @returns {Promise<{ changes: number }>}
     */
    async moveToAppointment(businessId, fromAppointmentId, toAppointmentId, expiresAt, conn = db) {
      return conn.run(
        `UPDATE appointment_manage_tokens SET appointment_id = ?, expires_at = ?
          WHERE business_id = ? AND appointment_id = ? AND revoked_at IS NULL`,
        [toAppointmentId, expiresAt, businessId, fromAppointmentId],
      );
    },

    /**
     * Teto de tokens VIVOS por agendamento (AF-18, critério 11; docs/security/AF-12.md item 2): apaga
     * os vivos (`expires_at > agora`, revogados ou não) além dos `keep` mais novos, contando o
     * `exceptHash` (o recém-emitido, sempre mantido). Apagar, e não revogar: um revogado ainda abriria
     * a página como "cancelado" (AF-18, decisão 2). `rowid` desempata tokens do mesmo milissegundo.
     * @returns {Promise<{ changes: number }>}
     */
    async trimLive(businessId, appointmentId, { keep, nowIso, exceptHash }, conn = db) {
      return conn.run(
        `DELETE FROM appointment_manage_tokens WHERE rowid IN (
           SELECT rowid FROM appointment_manage_tokens
            WHERE business_id = ? AND appointment_id = ? AND expires_at > ? AND token_hash <> ?
            ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
        [businessId, appointmentId, nowIso, exceptHash, Math.max(keep - 1, 0)],
      );
    },

    /** Apaga um token pelo hash, do negócio (token de um envio de e-mail que falhou, AF-18 5.3). */
    async deleteByHash(businessId, tokenHash, conn = db) {
      return conn.run('DELETE FROM appointment_manage_tokens WHERE business_id = ? AND token_hash = ?', [businessId, tokenHash]);
    },

    /** Um lote dos vencidos até `cutoffIso`, do negócio (purga oportunista). @returns {Promise<{ changes: number }>} */
    async purgeExpired(businessId, cutoffIso, { batch = 500 } = {}, conn = db) {
      return conn.run(
        `DELETE FROM appointment_manage_tokens WHERE rowid IN (
           SELECT rowid FROM appointment_manage_tokens WHERE business_id = ? AND expires_at <= ? LIMIT ?)`,
        [businessId, cutoffIso, batch],
      );
    },

    /**
     * Purga global (boot), em lotes de `batch` até não sobrar vencido (lição do AF-16 item 3).
     * @returns {Promise<number>} linhas apagadas
     */
    async purgeExpiredAll(cutoffIso, { batch = 500 } = {}, conn = db) {
      let total = 0;
      for (;;) {
        const { changes } = await conn.run(
          `DELETE FROM appointment_manage_tokens WHERE rowid IN (
             SELECT rowid FROM appointment_manage_tokens WHERE expires_at <= ? LIMIT ?)`,
          [cutoffIso, batch],
        );
        total += changes;
        if (changes === 0 || changes < batch) return total;
      }
    },
  };
}
