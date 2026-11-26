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
 *   findConflictsForBlock(businessId: string,
 *                         block: { professionalId: string|null, startsAt: string, endsAt: string },
 *                         limit: number,
 *                         conn: import('../../db/index.js').Database)
 *     : Promise<{ total: number,
 *                 items: Array<{ id: string, startsAt: string, endsAt: string, serviceName: string,
 *                                professionalId: string, professionalName: string, customerName: string }>,
 *                 versionKey: string }>,
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
 *
 * findConflictsForBlock (AF-16, critérios 9 a 11) roda DENTRO da transação de criação do bloqueio:
 * usa só `conn`, como countFutureByProfessional. Conflito = não cancelado E starts_at < block.endsAt
 * E ends_at > block.startsAt (intersecção, inclusive o atendimento em andamento), do profissional
 * (ou de todos os ativos, se professionalId for null). `items` vem ordenado por starts_at, id, com
 * até `limit` itens; `total` é o total real. `versionKey` é opaco e muda sempre que o CONJUNTO muda
 * (sugestão para o AF-11: sha256 dos ids ordenados, ou COUNT + MAX(updated_at)).
 */

/** Implementação nula até o AF-11: nunca há agendamentos. @type {AppointmentsPort} */
export const noAppointments = Object.freeze({
  countFutureByService: async () => 0,
  countFutureByProfessional: async () => 0,
  countFutureOutsideHours: async () => 0,
  findConflictsForBlock: async () => ({ total: 0, items: [], versionKey: '' }),
});
