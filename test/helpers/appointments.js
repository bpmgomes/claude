// Helpers dos testes do AF-11 (agendamento do cliente final).
import { randomUUID } from 'node:crypto';
import { validCustomer } from './customers.js';

let seq = 0;

/**
 * Corpo do POST público, com `validCustomer` do AF-04 e um e-mail único por chamada.
 * @param {{ serviceId?: string, professionalId?: string, start?: string, customer?: object }} [overrides]
 */
export function bookingBody(overrides = {}) {
  seq += 1;
  const { customer, ...rest } = overrides;
  return {
    serviceId: rest.serviceId,
    professionalId: 'any',
    start: '2026-11-27T10:00',
    ...rest,
    customer: { ...validCustomer({ email: `cliente${seq}-${Date.now()}@example.com` }), ...(customer || {}) },
  };
}

/**
 * `POST /api/public/:slug/appointments`, com `sec-fetch-site: same-origin` por padrão. Resposta crua.
 * @param {{ headers?: object, remoteAddress?: string, cookies?: object }} [options]
 */
export function postAppointment(app, slug, body, { headers = {}, remoteAddress, cookies } = {}) {
  const options = {
    method: 'POST',
    url: `/api/public/${slug}/appointments`,
    headers: { 'sec-fetch-site': 'same-origin', ...headers },
    payload: body,
  };
  if (remoteAddress) options.remoteAddress = remoteAddress;
  if (cookies) options.cookies = cookies;
  return app.inject(options);
}

/** COUNT(*) de agendamentos com um filtro simples por coluna (`{ professional_id: x, status: 'confirmed' }`). */
export async function countAppointments(db, where = {}) {
  const keys = Object.keys(where);
  const sql = `SELECT COUNT(*) AS n FROM appointments${keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : ''}`;
  return Number((await db.get(sql, keys.map((k) => where[k]))).n);
}

/**
 * INSERT cru em `appointments`, sem passar pelo serviço (critério 21). `row` em camelCase; o que
 * faltar é preenchido com valores válidos. `endsAt` padrão = `startsAt` + `durationMinutes`.
 * @returns {Promise<string>} id
 */
export async function insertAppointmentDirect(conn, row) {
  const durationMinutes = row.durationMinutes ?? 60;
  const startsAt = row.startsAt;
  const endsAt = row.endsAt ?? new Date(Date.parse(startsAt) + durationMinutes * 60_000).toISOString();
  const id = row.id ?? randomUUID();
  const createdAt = row.createdAt ?? '2026-11-26T12:00:00.000Z';
  const status = row.status ?? 'confirmed';
  await conn.run(
    `INSERT INTO appointments
       (id, business_id, professional_id, customer_id, service_id, service_name, duration_minutes, price_cents,
        customer_name, customer_phone, starts_at, ends_at, status, created_at, updated_at, cancelled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.businessId,
      row.professionalId,
      row.customerId,
      row.serviceId,
      row.serviceName ?? 'Corte',
      durationMinutes,
      row.priceCents === undefined ? 5000 : row.priceCents,
      row.customerName ?? 'Cliente Direto',
      row.customerPhone ?? '21987654321',
      startsAt,
      endsAt,
      status,
      createdAt,
      row.updatedAt ?? createdAt,
      row.cancelledAt === undefined ? (status === 'cancelled' ? createdAt : null) : row.cancelledAt,
    ],
  );
  return id;
}

/** Cancela direto no banco (o AF-12 fará pela interface). */
export async function cancelDirect(db, id, nowIso = '2026-11-26T12:30:00.000Z') {
  await db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [
    nowIso,
    nowIso,
    id,
  ]);
}

/** Cliente cru (para os INSERTs diretos). @returns {Promise<string>} id */
export async function insertCustomerDirect(conn, businessId, { email = `direto-${randomUUID()}@x.com`, phone = '11912345678' } = {}) {
  const id = randomUUID();
  await conn.run(
    `INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at)
     VALUES (?, ?, 'Cliente Direto', ?, ?, '2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z')`,
    [id, businessId, phone, email],
  );
  return id;
}

/**
 * Porta real de agendamentos (AF-11) sobre um `db` cru, para os testes de serviço que antes usavam
 * `noAppointments` como "sem agendamentos" (critério 31).
 */
export async function realAppointmentsPort(db) {
  const { createAppointmentsRepository } = await import('../../src/modules/appointments/appointments.repository.js');
  const { createAppointmentsPort } = await import('../../src/modules/appointments/appointments-port.js');
  const { createWorkingHoursRepository } = await import('../../src/modules/working-hours/working-hours.repository.js');
  return createAppointmentsPort({
    appointmentsRepository: createAppointmentsRepository(db),
    workingHoursRepository: createWorkingHoursRepository(db),
  });
}

/**
 * Agendamento real (tabela `appointments`) para um profissional e um serviço existentes. Cria o
 * serviço (60 min) e o cliente quando não são passados. @returns {Promise<{ id: string, serviceId: string }>}
 */
export async function seedRealAppointment(conn, { businessId, professionalId, serviceId, startsAt, durationMinutes = 60, status }) {
  let sid = serviceId;
  if (!sid) {
    sid = randomUUID();
    await conn.run(
      `INSERT INTO services (id, business_id, name, name_key, duration_minutes, price_cents, price_on_request, active, created_at, updated_at)
       VALUES (?, ?, 'Corte', ?, ?, 5000, 0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [sid, businessId, `corte ${sid}`, durationMinutes],
    );
  }
  const customerId = await insertCustomerDirect(conn, businessId);
  const id = await insertAppointmentDirect(conn, { businessId, professionalId, customerId, serviceId: sid, startsAt, durationMinutes, status });
  return { id, serviceId: sid };
}
