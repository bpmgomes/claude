// Helpers dos testes do AF-14 (agenda do dono e cancelamento pelo dono).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { insertAppointmentDirect, insertCustomerDirect } from './appointments.js';
import { OWNER_AGENDA_FIELDS, OWNER_AGENDA_DETAIL_FIELDS } from '../../src/modules/agenda/agenda.view.js';

const SAME_ORIGIN = Object.freeze({ 'sec-fetch-site': 'same-origin' });

/** `GET /api/agenda` com a query dada. Resposta crua. */
export function getAgenda(app, cookies, query = {}, { remoteAddress, headers } = {}) {
  const options = { method: 'GET', url: '/api/agenda', query };
  if (cookies) options.cookies = cookies;
  if (remoteAddress) options.remoteAddress = remoteAddress;
  if (headers) options.headers = headers;
  return app.inject(options);
}

/** `GET /api/agenda/appointments/:id`. Resposta crua. */
export function getAgendaAppointment(app, cookies, id, { remoteAddress } = {}) {
  const options = { method: 'GET', url: `/api/agenda/appointments/${id}` };
  if (cookies) options.cookies = cookies;
  if (remoteAddress) options.remoteAddress = remoteAddress;
  return app.inject(options);
}

/**
 * `POST /api/agenda/appointments/:id/cancel` com `sec-fetch-site: same-origin` por padrão. Sem
 * `version` nem `payload`, vai sem corpo. Resposta crua.
 */
export function cancelAgenda(app, cookies, id, { version, headers = {}, payload, remoteAddress } = {}) {
  const options = { method: 'POST', url: `/api/agenda/appointments/${id}/cancel`, headers: { ...SAME_ORIGIN, ...headers } };
  if (cookies) options.cookies = cookies;
  if (payload !== undefined) options.payload = payload;
  else if (version !== undefined) options.payload = { version };
  if (remoteAddress) options.remoteAddress = remoteAddress;
  return app.inject(options);
}

/** Chaves de um objeto, ordenadas. */
const keysOf = (obj) => Object.keys(obj).sort();
const sorted = (list) => [...list].sort();

/**
 * Confere a árvore de chaves de um corpo da lista contra OWNER_AGENDA_FIELDS (critério 6).
 * @returns {{ appointments: number, blocks: number }} quantos itens de cada tipo foram conferidos
 */
export function assertAgendaTree(body) {
  const F = OWNER_AGENDA_FIELDS;
  assert.deepEqual(keysOf(body), sorted(F.root));
  let appointments = 0;
  let blocks = 0;
  for (const day of body.days) {
    assert.deepEqual(keysOf(day), sorted(F.day));
    assert.deepEqual(keysOf(day.counts), sorted(F.counts));
    for (const item of day.items) {
      if (item.type === 'appointment') {
        appointments += 1;
        assert.deepEqual(keysOf(item), sorted(F.appointment));
        assert.deepEqual(keysOf(item.professional), sorted(F.professional));
        if (item.cancelled !== null) assert.deepEqual(keysOf(item.cancelled), sorted(F.cancelled));
      } else {
        assert.equal(item.type, 'block');
        blocks += 1;
        assert.deepEqual(keysOf(item), sorted(F.block));
        if (item.professional !== null) assert.deepEqual(keysOf(item.professional), sorted(F.blockProfessional));
        if (item.reason !== null) assert.deepEqual(keysOf(item.reason), sorted(F.reason));
      }
    }
  }
  return { appointments, blocks };
}

/** Confere a árvore do detalhe (e do 200 do cancelamento, com `outcome`) contra OWNER_AGENDA_DETAIL_FIELDS. */
export function assertDetailTree(body, { withOutcome = false } = {}) {
  const F = OWNER_AGENDA_DETAIL_FIELDS;
  assert.deepEqual(keysOf(body), sorted(withOutcome ? [...F.root, 'outcome'] : F.root));
  const a = body.appointment;
  assert.deepEqual(keysOf(a), sorted(F.appointment));
  assert.deepEqual(keysOf(a.service), sorted(F.service));
  assert.deepEqual(keysOf(a.professional), sorted(F.professional));
  assert.deepEqual(keysOf(a.customer), sorted(F.customer));
  if (a.cancelled !== null) assert.deepEqual(keysOf(a.cancelled), sorted(F.cancelled));
  for (const link of [a.rescheduledFrom, a.rescheduledTo]) if (link !== null) assert.deepEqual(keysOf(link), sorted(F.chainLink));
}

/** Todos os itens de todos os dias. */
export const allItems = (body) => body.days.flatMap((d) => d.items);

/**
 * Serviço cru de 60 min (INSERT direto), para os seeds de volume. @returns {Promise<string>} id
 */
export async function insertServiceDirect(conn, businessId, { name = 'Corte', durationMinutes = 60 } = {}) {
  const id = randomUUID();
  await conn.run(
    `INSERT INTO services (id, business_id, name, name_key, duration_minutes, price_cents, price_on_request, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 5000, 0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [id, businessId, name, `${name.toLowerCase()} ${id}`, durationMinutes],
  );
  return id;
}

/** Profissional cru (INSERT direto). @returns {Promise<string>} id */
export async function insertProfessionalDirect(conn, businessId, name) {
  const id = randomUUID();
  await conn.run(
    `INSERT INTO professionals (id, business_id, name, name_key, photo_key, removed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [id, businessId, name, name.toLowerCase()],
  );
  return id;
}

/**
 * Semana de agendamentos sem sobreposição (via insertAppointmentDirect): `perDay` por profissional e
 * por dia, de 15 em 15 min a partir de `firstStartUtc` de cada dia, nos `days` (datas UTC do início).
 * @returns {Promise<{ professionals: string[], ids: string[] }>}
 */
export async function seedWeek(conn, { businessId, serviceId, days, perDay, professionals = 1, firstHourUtc = 11, durationMinutes = 15 }) {
  const pros = [];
  for (let i = 0; i < professionals; i++) pros.push(await insertProfessionalDirect(conn, businessId, `Prof ${String(i).padStart(2, '0')}`));
  const customerId = await insertCustomerDirect(conn, businessId);
  const ids = [];
  for (const day of days) {
    for (const professionalId of pros) {
      for (let k = 0; k < perDay; k++) {
        const startMs = Date.parse(`${day}T${String(firstHourUtc).padStart(2, '0')}:00:00.000Z`) + k * durationMinutes * 60_000;
        ids.push(
          await insertAppointmentDirect(conn, {
            businessId,
            professionalId,
            customerId,
            serviceId,
            startsAt: new Date(startMs).toISOString(),
            durationMinutes,
          }),
        );
      }
    }
  }
  return { professionals: pros, ids };
}

/**
 * Todas as tabelas do banco despejadas (linhas em JSON, por rowid), para "nada mais é alterado".
 * @returns {Promise<Record<string, string>>}
 */
export async function snapshotTables(db) {
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out = {};
  for (const { name } of tables) out[name] = JSON.stringify(await db.all(`SELECT * FROM "${name}" ORDER BY rowid`));
  return out;
}

/** Nomes das tabelas que diferem entre dois snapshots. */
export function changedTables(before, after) {
  return Object.keys({ ...before, ...after })
    .filter((name) => before[name] !== after[name])
    .sort();
}

/** Quinta 26/11/2026, 09:00 em São Paulo (o relógio base do AF-12 e do AF-18). */
export const AGENDA_NOW = '2026-11-26T12:00:00.000Z';
/** São Paulo é UTC−3 o ano todo desde 2019: hora local 'YYYY-MM-DDTHH:MM' -> ISO UTC. */
export const spUtc = (local) => new Date(Date.parse(`${local}:00.000Z`) + 3 * 3_600_000).toISOString();

/**
 * App de teste do AF-14 com relógio controlável e um negócio pronto: serviço de 60 min e dois
 * profissionais (Ana Souza e Bia Lima) com grade 9h-18h (seg-sex).
 * @returns {Promise<{ app, logs, clock, cookies, business, service, pros: object[] }>}
 */
export async function agendaApp(overrides = {}) {
  const { buildTestApp } = await import('./test-app.js');
  const { createClock } = await import('./clock.js');
  const { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } = await import('./session.js');
  const clock = overrides.clock ?? createClock(AGENDA_NOW);
  const { clock: _c, ownerEmail = 'ana@x.com', businessName = 'Salão da Ana', ...rest } = overrides;
  const { app, logs } = await buildTestApp({ now: clock.now, ...rest });
  const cookies = await signupAndLogin(app, { email: ownerEmail });
  const business = await createBusinessFor(app, cookies, { name: businessName });
  const service = await createService(app, cookies, { name: 'Corte', durationMinutes: 60, price: '50' });
  const pros = [];
  for (const name of ['Ana Souza', 'Bia Lima']) {
    const p = await createProfessional(app, cookies, { name, serviceIds: [service.id] });
    const res = await putHours(app, cookies, p.id, WEEK_9_TO_18);
    if (res.statusCode !== 200) throw new Error(`grade: ${res.body}`);
    pros.push(p);
  }
  return { app, logs, clock, cookies, business, service, pros };
}

/** Segundo negócio no mesmo app (isolamento). */
export async function secondBusiness(app, { email = 'outro@x.com', name = 'Outro Negócio' } = {}) {
  const { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } = await import('./session.js');
  const cookies = await signupAndLogin(app, { email });
  const business = await createBusinessFor(app, cookies, { name });
  const service = await createService(app, cookies, { name: 'Escova', durationMinutes: 60, price: '40' });
  const p = await createProfessional(app, cookies, { name: 'Caio Prado', serviceIds: [service.id] });
  const res = await putHours(app, cookies, p.id, WEEK_9_TO_18);
  if (res.statusCode !== 200) throw new Error(`grade: ${res.body}`);
  return { cookies, business, service, pros: [p] };
}

let bookingSeq = 0;
/**
 * Reserva real pela rota pública (AF-11), com cliente único. @returns {Promise<{ id: string, token: string, customer: object }>}
 */
export async function bookReal(app, ctx, { start, professional = 0, customer } = {}) {
  const { bookingBody } = await import('./appointments.js');
  const { bookWithLink } = await import('./manage.js');
  const { hashManageToken } = await import('../../src/modules/appointments/manage-token.js');
  bookingSeq += 1;
  const c = customer ?? {
    name: `Cliente ${bookingSeq}`,
    phone: `1198${String(1000000 + bookingSeq * 53).padStart(7, '0')}`,
    email: `agenda${bookingSeq}@example.com`,
  };
  const n = bookingSeq;
  const { token } = await bookWithLink(
    app,
    ctx.business.slug,
    bookingBody({ serviceId: ctx.service.id, professionalId: ctx.pros[professional].id, start, customer: c }),
    { remoteAddress: `10.9.${Math.trunc(n / 250)}.${(n % 250) + 1}` },
  );
  const row = await app.db.get('SELECT appointment_id FROM appointment_manage_tokens WHERE token_hash = ?', [hashManageToken(token)]);
  return { id: row.appointment_id, token, customer: c };
}

/** `version` da agenda (o mesmo hash do AF-12) direto do banco. */
export async function agendaVersionOf(app, businessId, id) {
  const { appointmentVersionOf } = await import('../../src/modules/appointments/manage-token.js');
  const row = await app.services.appointmentsRepository.findById(id, businessId);
  return appointmentVersionOf(row);
}
