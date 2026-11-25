/**
 * Porta para os agendamentos. O AF-11 implementa a porta com o repositório real neste
 * módulo (src/modules/appointments/) e passa a instância em `buildApp`.
 *
 * - AF-06 (decisão 1): ao desativar um serviço, a resposta informa quantos agendamentos
 *   futuros continuam marcados (`countFutureByService`).
 * - AF-07 (critérios 17 e 19): a remoção de um profissional é bloqueada se houver
 *   agendamentos futuros (`countFutureByProfessional`).
 *
 * @typedef {{
 *   countFutureByService(businessId: string, serviceId: string, nowIso: string): Promise<number>,
 *   countFutureByProfessional(businessId: string, professionalId: string, nowIso: string,
 *                             conn: import('../../db/index.js').Database): Promise<number>,
 * }} AppointmentsPort
 *
 * countFutureByProfessional roda DENTRO da transação de remoção: deve usar só `conn`, nunca o
 * `db` global (no SQLite, o adapter enfileira e a chamada travaria esperando a própria transação).
 * Futuro = não cancelado e com início > nowIso (critério 17).
 */

/** Implementação nula até o AF-11: nunca há agendamentos. @type {AppointmentsPort} */
export const noAppointments = Object.freeze({
  countFutureByService: async () => 0,
  countFutureByProfessional: async () => 0,
});
