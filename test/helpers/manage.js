// Helpers dos testes do AF-12 (gerenciar o agendamento pelo link).
import { postAppointment } from './appointments.js';

const SAME_ORIGIN = Object.freeze({ 'sec-fetch-site': 'same-origin' });

/** Token do `manage.url` de um 201 (ou null). */
export function tokenOfUrl(url) {
  const match = /\/agendamento\/([A-Za-z0-9_-]{43})$/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

/**
 * POST do AF-11 que devolve o token do link.
 * @returns {Promise<{ res: object, body: object, token: string|null, url: string|null }>}
 */
export async function bookWithLink(app, slug, body, opts = {}) {
  const res = await postAppointment(app, slug, body, opts);
  if (res.statusCode !== 201) throw new Error(`reserva falhou: ${res.statusCode} ${res.body}`);
  const json = res.json();
  return { res, body: json, url: json.manage?.url ?? null, token: tokenOfUrl(json.manage?.url) };
}

function withAddress(options, remoteAddress) {
  if (remoteAddress) options.remoteAddress = remoteAddress;
  return options;
}

/** GET do resumo. */
export function getManage(app, token, { remoteAddress, cookies } = {}) {
  const options = withAddress({ method: 'GET', url: `/api/public/manage/${token}` }, remoteAddress);
  if (cookies) options.cookies = cookies;
  return app.inject(options);
}

/** POST cancel; sem `version`, vai sem corpo. */
export function cancelManage(app, token, { version, headers = {}, remoteAddress, payload } = {}) {
  const options = { method: 'POST', url: `/api/public/manage/${token}/cancel`, headers: { ...SAME_ORIGIN, ...headers } };
  if (payload !== undefined) options.payload = payload;
  else if (version !== undefined) options.payload = { version };
  return app.inject(withAddress(options, remoteAddress));
}

/** POST reschedule com o corpo dado. */
export function rescheduleManage(app, token, body, { headers = {}, remoteAddress } = {}) {
  return app.inject(
    withAddress(
      { method: 'POST', url: `/api/public/manage/${token}/reschedule`, headers: { ...SAME_ORIGIN, ...headers }, payload: body },
      remoteAddress,
    ),
  );
}

/** GET dos horários para remarcar. */
export function manageAvailability(app, token, query = {}, { remoteAddress } = {}) {
  return app.inject(withAddress({ method: 'GET', url: `/api/public/manage/${token}/availability`, query, headers: { ...SAME_ORIGIN } }, remoteAddress));
}

/** `change.version` atual do link. */
export async function versionOf(app, token) {
  const res = await getManage(app, token);
  if (res.statusCode !== 200) throw new Error(`GET manage falhou: ${res.statusCode} ${res.body}`);
  return res.json().change.version;
}

/** Linhas de appointment_manage_tokens do agendamento. */
export function tokensOf(db, appointmentId) {
  return db.all('SELECT * FROM appointment_manage_tokens WHERE appointment_id = ? ORDER BY created_at, token_hash', [appointmentId]);
}

/** Todas as tabelas (de sqlite_master) despejadas em texto: nada do token em claro pode aparecer. */
export async function everyColumnText(db) {
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  const out = [];
  for (const { name } of tables) {
    const rows = await db.all(`SELECT * FROM "${name}"`);
    out.push(JSON.stringify(rows));
  }
  return out.join('\n');
}
