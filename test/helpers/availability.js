// Helpers dos testes de disponibilidade (AF-10). Sem banco.
import { noAppointments } from '../../src/modules/appointments/appointments-port.js';

/** 'HH:MM' -> minutos (24:00 = 1440). */
function minutesOf(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Grade compacta -> WorkingInterval[]: `{ 1: [['09:00', '12:00'], ['13:00', '18:00']] }`.
 * @param {Record<number, Array<[string, string]>>} days
 */
export function weekly(days) {
  const out = [];
  for (const [weekday, intervals] of Object.entries(days)) {
    for (const [start, end] of intervals) {
      out.push({ weekday: Number(weekday), startMinute: minutesOf(start), endMinute: minutesOf(end) });
    }
  }
  return out;
}

/** Segunda a sexta 09:00–12:00 e 13:00–18:00 (igual a WEEK_9_TO_18 da API). */
export const WEEKDAYS_9_TO_18 = weekly(
  Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [['09:00', '12:00'], ['13:00', '18:00']]])),
);

/** Intervalo em ms a partir de dois ISO UTC. */
export function interval(isoStart, isoEnd) {
  return { startMs: Date.parse(isoStart), endMs: Date.parse(isoEnd) };
}

/**
 * Porta de agendamentos falsa (`findBusyByBusiness`), com o resto da porta nula.
 * @param {{ busy?: Record<string, Array<{ startsAt: string, endsAt: string }>>, throws?: Error, result?: unknown }} [options]
 *   `result` substitui o Map devolvido (para testar retorno malformado)
 */
export function fakeAppointments({ busy = {}, throws, result } = {}) {
  const calls = [];
  return {
    ...noAppointments,
    calls,
    async findBusyByBusiness(businessId, filter, fromIso, toIso) {
      calls.push({ businessId, filter, fromIso, toIso });
      if (throws) throw throws;
      if (result !== undefined) return result;
      const map = new Map();
      for (const [id, list] of Object.entries(busy)) {
        if (filter.professionalId === null || filter.professionalId === id) map.set(id, list);
      }
      return map;
    },
  };
}
