/**
 * Porta para os agendamentos (decisão 1 do AF-06): ao desativar um serviço, a resposta
 * informa quantos agendamentos futuros continuam marcados. O AF-11 implementa a porta
 * com o repositório real e passa a instância em `buildApp`.
 *
 * @typedef {{ countFutureByService(businessId: string, serviceId: string, nowIso: string): Promise<number> }} AppointmentsPort
 */

/** Implementação nula até o AF-11: nunca há agendamentos. @type {AppointmentsPort} */
export const noAppointments = Object.freeze({ countFutureByService: async () => 0 });
