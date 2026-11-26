/**
 * Porta de eventos do agendamento (AF-11, critério 44, decisão 10).
 *
 * Chamada DEPOIS do COMMIT, sem await: falha ou lentidão não mudam o 201 nem desfazem nada. Só ids:
 * o AF-18 lê nome, e-mail e dados do agendamento pelo repositório (`findById` e `customers`).
 * Risco: evento perdido se o processo cair entre o commit e a chamada. Recomendação para o AF-18:
 * tabela outbox gravada NA MESMA transação do agendamento (migração própria), com um worker que
 * entrega e marca como enviado.
 *
 * @typedef {{ confirmed(event: { appointmentId: string, businessId: string }): Promise<void> }} AppointmentEventsPort
 */

/** Implementação nula (padrão). @type {AppointmentEventsPort} */
export const noAppointmentEvents = Object.freeze({ confirmed: async () => {} });
