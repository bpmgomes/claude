/**
 * Porta de eventos do agendamento (AF-11, critério 44, decisão 10; AF-12, critérios 38 e 39).
 *
 * Chamada DEPOIS do COMMIT, sem await: falha ou lentidão não mudam a resposta nem desfazem nada. Só ids
 * (e o link): o AF-18 lê nome, e-mail e dados do agendamento pelo repositório (`findById` e `customers`).
 * Risco: evento perdido se o processo cair entre o commit e a chamada. Recomendação para o AF-18:
 * tabela outbox gravada NA MESMA transação do agendamento (migração própria), com um worker que
 * entrega e marca como enviado.
 *
 * Eventos:
 * - `confirmed` (AF-11): reserva nova. Desde o AF-12, leva também `manageUrl`.
 * - `cancelled` (AF-12): cancelado pelo link do cliente. Só ids.
 * - `rescheduled` (AF-12): o antigo foi cancelado e o novo criado na mesma transação; `manageUrl` é o
 *   MESMO link (o token acompanha a remarcação, decisão 4).
 *
 * `manageUrl` leva o token em claro SÓ EM MEMÓRIA (decisão 2). Como guardá-lo numa fila (outbox) é do
 * AF-18 (recomendação: cifrado com chave do servidor e apagado depois do envio ou em 24 h); o AF-12
 * nunca o grava em claro. Nenhum log pode receber o payload (o redact cobre `manageUrl`). O e-mail
 * repete a política de prazo (`formatChangePolicy`, com o valor do negócio no envio).
 *
 * @typedef {{
 *   confirmed(event: { appointmentId: string, businessId: string, manageUrl: string }): Promise<void>,
 *   cancelled?(event: { appointmentId: string, businessId: string }): Promise<void>,
 *   rescheduled?(event: { previousAppointmentId: string, appointmentId: string, businessId: string,
 *     manageUrl: string }): Promise<void>,
 * }} AppointmentEventsPort
 */

const noopLog = { warn() {} };

/** Implementação nula (padrão). @type {AppointmentEventsPort} */
export const noAppointmentEvents = Object.freeze({
  confirmed: async () => {},
  cancelled: async () => {},
  rescheduled: async () => {},
});

/**
 * Depois do COMMIT, sem await (queueMicrotask + try/catch). Método ausente na porta: ignorado (as
 * portas dos testes do AF-11 só têm `confirmed`). Falha síncrona ou assíncrona: log
 * `appointment_event_failed` só com `eventName`, `appointmentId`, `errCode` e `errName`.
 * @param {AppointmentEventsPort|undefined} port
 * @param {'confirmed'|'cancelled'|'rescheduled'} name
 * @param {{ appointmentId: string }} event
 * @param {{ warn: Function }} [log]
 */
export function emitAfterCommit(port, name, event, log = noopLog) {
  const failed = (err) =>
    log.warn({
      event: 'appointment_event_failed',
      eventName: name,
      appointmentId: event?.appointmentId,
      errCode: err?.code,
      errName: err?.name,
    });
  try {
    queueMicrotask(() => {
      const fn = port && typeof port[name] === 'function' ? port[name] : null;
      if (!fn) return;
      let pending;
      try {
        pending = fn.call(port, event);
      } catch (err) {
        failed(err);
        return;
      }
      Promise.resolve(pending).catch(failed);
    });
  } catch (err) {
    failed(err);
  }
}
