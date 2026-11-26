// Leitura das camadas do motor de disponibilidade (grade, bloqueios e ocupados), extraída do
// availability.service.js (AF-11, 4.3) para ser usada também pela reserva, dentro da transação.

/** Falha da porta de agendamentos: os chamadores escolhem o 503 (AVAILABILITY_ ou BOOKING_UNAVAILABLE). */
export class BusyUnavailableError extends Error {
  constructor(options) {
    super('Leitura de agendamentos indisponível.', options);
    this.name = 'BusyUnavailableError';
  }
}

const toMsIntervals = (list) =>
  (Array.isArray(list) ? list : []).map((i) => ({ startMs: Date.parse(i.startsAt), endMs: Date.parse(i.endsAt) }));

async function readBusy(appointments, businessId, professionalId, fromIso, toIso, conn, excludeAppointmentId) {
  // Sem o filtro do AF-12, a porta recebe exatamente `{ professionalId }`, como antes.
  const filter = excludeAppointmentId ? { professionalId, excludeAppointmentId } : { professionalId };
  let busy;
  try {
    busy = await appointments.findBusyByBusiness(businessId, filter, fromIso, toIso, conn);
  } catch (err) {
    throw new BusyUnavailableError({ cause: err });
  }
  if (!(busy instanceof Map)) {
    throw new BusyUnavailableError({ cause: new TypeError('findBusyByBusiness deve devolver um Map.') });
  }
  return busy;
}

/**
 * Grade, bloqueios e ocupados dos elegíveis, uma consulta por camada, todas em `conn` (critério 24).
 * Com `specificId`, só ele; sem, todos os elegíveis, com os bloqueios de "todos" aplicados a cada um.
 * @param {{
 *   workingHoursRepository: ReturnType<typeof import('../working-hours/working-hours.repository.js').createWorkingHoursRepository>,
 *   timeBlocksRepository: ReturnType<typeof import('../time-blocks/time-blocks.repository.js').createTimeBlocksRepository>,
 *   appointments: import('../appointments/appointments-port.js').AppointmentsPort,
 * }} deps
 * @param {string} businessId
 * @param {Array<{ id: string }>} eligible
 * @param {string|null} specificId
 * @param {string} fromIso
 * @param {string} toIso
 * @param {import('../../db/index.js').Database} [conn]
 * @param {{ excludeAppointmentId?: string|null }} [options] AF-12: agendamento que não ocupa (remarcar)
 * @returns {Promise<import('./availability-engine.js').EngineProfessional[]>}
 * @throws {BusyUnavailableError} se findBusyByBusiness falhar ou não devolver um Map (com `cause`)
 */
export async function readLayers(
  { workingHoursRepository, timeBlocksRepository, appointments },
  businessId,
  eligible,
  specificId,
  fromIso,
  toIso,
  conn,
  { excludeAppointmentId = null } = {},
) {
  if (eligible.length === 0) return [];
  if (specificId) {
    const weekly = await workingHoursRepository.findByProfessional(businessId, specificId, conn);
    const blocks = await timeBlocksRepository.findApplicable(businessId, specificId, fromIso, toIso, conn);
    const busy = await readBusy(appointments, businessId, specificId, fromIso, toIso, conn, excludeAppointmentId);
    return [{ id: specificId, weekly, blocks: toMsIntervals(blocks), appointments: toMsIntervals(busy.get(specificId)) }];
  }
  const weeklyById = await workingHoursRepository.findWeeklyByBusiness(businessId, conn);
  const blocks = await timeBlocksRepository.findApplicableByBusiness(businessId, fromIso, toIso, conn);
  const busy = await readBusy(appointments, businessId, null, fromIso, toIso, conn, excludeAppointmentId);
  // Os bloqueios de "todos" valem para todo ativo, inclusive criado depois (AF-16, critério 9).
  const forAll = toMsIntervals(blocks.all);
  return eligible.map((p) => ({
    id: p.id,
    weekly: weeklyById.get(p.id) ?? [],
    blocks: [...forAll, ...toMsIntervals(blocks.byProfessional.get(p.id))],
    appointments: toMsIntervals(busy.get(p.id)),
  }));
}
