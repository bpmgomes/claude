/**
 * Porta para os agendamentos. O AF-11 implementa a porta com o repositório real neste
 * módulo (src/modules/appointments/) e passa a instância em `buildApp`.
 *
 * - AF-06 (decisão 1): ao desativar um serviço, a resposta informa quantos agendamentos
 *   futuros continuam marcados (`countFutureByService`).
 * - AF-07 (critérios 17 e 19): a remoção de um profissional é bloqueada se houver
 *   agendamentos futuros (`countFutureByProfessional`).
 * - AF-08 (critério 20, decisão 4): ao gravar a grade de horários, a resposta informa quantos
 *   agendamentos futuros ficaram fora do novo expediente (`countFutureOutsideHours`). Só avisa,
 *   nunca cancela nem bloqueia.
 *
 * @typedef {{
 *   countFutureByService(businessId: string, serviceId: string, nowIso: string): Promise<number>,
 *   countFutureByProfessional(businessId: string, professionalId: string, nowIso: string,
 *                             conn: import('../../db/index.js').Database): Promise<number>,
 *   countFutureOutsideHours(businessId: string, professionalId: string, nowIso: string): Promise<number>,
 * }} AppointmentsPort
 *
 * countFutureByProfessional roda DENTRO da transação de remoção: deve usar só `conn`, nunca o
 * `db` global (no SQLite, o adapter enfileira e a chamada travaria esperando a própria transação).
 * Futuro = não cancelado e com início > nowIso (critério 17).
 *
 * countFutureOutsideHours é chamado DEPOIS do commit da grade, com o `db` global (sem `conn`), como
 * countFutureByService. Futuro = não cancelado, início > nowIso e fora da grade ATUAL do profissional
 * (lida pelo AF-11 com workingHoursRepository.findWeeklyByBusiness, ou findWeekly com no máximo
FIND_WEEKLY_IDS_MAX ids, e convertida no fuso do negócio).
 */

/** Implementação nula até o AF-11: nunca há agendamentos. @type {AppointmentsPort} */
export const noAppointments = Object.freeze({
  countFutureByService: async () => 0,
  countFutureByProfessional: async () => 0,
  countFutureOutsideHours: async () => 0,
});
