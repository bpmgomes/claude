/**
 * Porta de eventos do agendamento (AF-11, critério 44, decisão 10; AF-12, critérios 38 e 39; AF-18,
 * critério 5 e decisão 3 do design).
 *
 * Chamada DEPOIS do COMMIT, sem await: falha ou lentidão não mudam a resposta nem desfazem nada. Só
 * ids. Desde o AF-18 o e-mail NÃO depende da porta: a linha da fila (`email_outbox`) nasce NA
 * transação, por `enqueueEmail` (src/modules/email/enqueue-email.js), e a porta só ACORDA o worker
 * (otimização de latência, não garantia de entrega). O evento perdido numa queda entre o COMMIT e a
 * chamada deixa de importar: a linha já está gravada.
 *
 * Eventos:
 * - `confirmed` (AF-11): reserva nova (não na repetição idempotente).
 * - `cancelled` (AF-12): cancelado pelo link do cliente (não na repetição).
 * - `rescheduled` (AF-12): o antigo foi cancelado e o novo criado na mesma transação.
 *
 * Nenhum evento leva `manageUrl` (AF-18): o worker emite um token novo do AF-12 na hora do envio, e
 * o token em claro não circula em memória fora da resposta 201.
 *
 * @typedef {{
 *   confirmed(event: { appointmentId: string, businessId: string }): Promise<void>,
 *   cancelled?(event: { appointmentId: string, businessId: string }): Promise<void>,
 *   rescheduled?(event: { previousAppointmentId: string, appointmentId: string, businessId: string }): Promise<void>,
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

/**
 * Porta que repassa cada evento a todas as portas, isoladamente: a falha (síncrona ou assíncrona) ou
 * a ausência do método em uma não impede as outras. A promessa devolvida rejeita com o primeiro erro
 * (para o `appointment_event_failed` do emitAfterCommit) só depois de todas terem sido chamadas.
 * @param {...(AppointmentEventsPort|null|undefined)} ports
 * @returns {AppointmentEventsPort}
 */
export function combineAppointmentEvents(...ports) {
  const list = ports.filter(Boolean);
  const fanOut = (name) => async (event) => {
    const results = await Promise.allSettled(
      list.map(async (port) => {
        if (typeof port[name] === 'function') await port[name](event);
      }),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  };
  return Object.freeze({
    confirmed: fanOut('confirmed'),
    cancelled: fanOut('cancelled'),
    rescheduled: fanOut('rescheduled'),
  });
}
