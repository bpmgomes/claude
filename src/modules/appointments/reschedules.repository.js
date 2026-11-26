/**
 * Cadeia de remarcações (AF-12, decisão 7): um elo por agendamento remarcado. A PK em
 * `previous_appointment_id` impede, no banco, remarcar duas vezes o mesmo agendamento.
 * @param {import('../../db/index.js').Database} db
 */
export function createReschedulesRepository(db) {
  return {
    /**
     * `sequence` do elo que CRIOU este agendamento (1 = primeira remarcação), ou 0 se ele não veio de
     * uma remarcação.
     * @returns {Promise<number>}
     */
    async sequenceOf(appointmentId, businessId, conn = db) {
      const row = await conn.get(
        'SELECT sequence FROM appointment_reschedules WHERE appointment_id = ? AND business_id = ?',
        [appointmentId, businessId],
      );
      return row ? Number(row.sequence) : 0;
    },

    /**
     * Agendamento criado pela remarcação de `previousAppointmentId` (o próximo da cadeia), ou null.
     * @returns {Promise<string|null>}
     */
    async nextOf(previousAppointmentId, businessId, conn = db) {
      const row = await conn.get(
        'SELECT appointment_id FROM appointment_reschedules WHERE previous_appointment_id = ? AND business_id = ?',
        [previousAppointmentId, businessId],
      );
      return row ? row.appointment_id : null;
    },

    /**
     * Agendamento que foi remarcado para criar `appointmentId` (o anterior da cadeia), ou null
     * (AF-18: raiz da cadeia para o UID do .ics).
     * @returns {Promise<string|null>}
     */
    async previousOf(appointmentId, businessId, conn = db) {
      const row = await conn.get(
        'SELECT previous_appointment_id FROM appointment_reschedules WHERE appointment_id = ? AND business_id = ?',
        [appointmentId, businessId],
      );
      return row ? row.previous_appointment_id : null;
    },

    /**
     * @throws {import('../../db/errors.js').UniqueViolationError}
     *   `appointment_reschedules_previous_appointment_id_unique` (o antigo já foi remarcado) ou
     *   `appointment_reschedules_appointment_id_unique`
     */
    async insert({ businessId, previousAppointmentId, appointmentId, sequence, createdAt }, conn = db) {
      await conn.run(
        `INSERT INTO appointment_reschedules (business_id, previous_appointment_id, appointment_id, sequence, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [businessId, previousAppointmentId, appointmentId, sequence, createdAt],
      );
    },
  };
}
