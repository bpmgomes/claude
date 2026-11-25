// Lógica da tela de profissionais, sem DOM (testável no Node). O servidor é a autoridade;
// a validação aqui é só para UX.
import {
  validateProfessionalInput,
  PROFESSIONAL_ID_RE,
  PROFESSIONAL_MESSAGES,
} from '/shared/professionals.js';
import { LOGO_MAX_BYTES } from '/shared/validation.js';
import { requestJson, requestBinary, GENERIC_ERROR_MESSAGE } from './api.js';

export const PHOTO_TYPES = Object.freeze(['image/png', 'image/jpeg']);
export const PHOTO_INVALID_MESSAGE = 'Envie uma imagem PNG ou JPG válida.';
export const NOT_BOOKABLE_LABEL = 'Não aparece para clientes';
export const INACTIVE_SUFFIX = '(inativo)';
const CHECK_FIELDS_MESSAGE = 'Verifique os campos destacados.';
const PHOTO_PATH_RE = /^\/media\/professionals\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;
const KNOWN_STATUSES = [400, 401, 404, 409, 413, 415, 422, 429, 503];

function redirectFor(res) {
  if (res.status === 401) return '/login';
  if (res.status === 409 && res.error && res.error.code === 'BUSINESS_REQUIRED') return '/onboarding';
  return undefined;
}

function failure(res) {
  const known = KNOWN_STATUSES.includes(res.status);
  const result = {
    ok: false,
    status: res.status,
    fields: (known && res.error && res.error.fields) || {},
    message: known && res.error ? res.error.message : GENERIC_ERROR_MESSAGE,
  };
  const redirectTo = redirectFor(res);
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

const validId = (id) => typeof id === 'string' && PROFESSIONAL_ID_RE.test(id);
const notFound = () => ({ ok: false, status: 404, fields: {}, message: PROFESSIONAL_MESSAGES.notFound });

/**
 * GET /api/professionals.
 * @returns {Promise<{ ok: true, professionals: object[] } | { ok: false, status: number, message: string, redirectTo?: string }>}
 */
export async function loadProfessionals({ fetchFn }) {
  const res = await requestJson('/api/professionals', { fetchFn });
  if (res.ok && res.body && Array.isArray(res.body.professionals)) {
    return { ok: true, professionals: res.body.professionals };
  }
  const { status, message, redirectTo } = failure(res);
  const result = { ok: false, status, message };
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

/**
 * GET /api/services?status=all: opções de serviço do formulário.
 * `hasActive` false orienta o dono a cadastrar serviços (critério 30).
 * @returns {Promise<{ ok: true, services: object[], hasActive: boolean }
 *   | { ok: false, status: number, message: string, redirectTo?: string }>}
 */
export async function loadServiceOptions({ fetchFn }) {
  const res = await requestJson('/api/services?status=all', { fetchFn });
  if (res.ok && res.body && Array.isArray(res.body.services)) {
    const { services } = res.body;
    return { ok: true, services, hasActive: services.some((s) => s && s.active) };
  }
  const { status, message, redirectTo } = failure(res);
  const result = { ok: false, status, message };
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

/**
 * Cria (POST) ou edita (PATCH) um profissional. Erros locais não chamam o servidor.
 * @param {{ name: string, serviceIds: string[] }} values
 * @param {{ mode: 'create'|'update', id?: string, fetchFn: typeof fetch }} deps
 * @returns {Promise<{ ok: true, professional: object, warnings: object[] }
 *   | { ok: false, status?: number, fields: Record<string,string>, message: string, redirectTo?: string }>}
 */
export async function submitProfessional(values, { mode = 'create', id, fetchFn }) {
  const update = mode === 'update';
  if (update && !validId(id)) return notFound();
  const body = { name: values ? values.name : undefined, serviceIds: (values && values.serviceIds) || [] };
  const check = validateProfessionalInput(body);
  if (!check.ok) return { ok: false, fields: check.fields, message: CHECK_FIELDS_MESSAGE };

  const url = update ? `/api/professionals/${id}` : '/api/professionals';
  const res = await requestJson(url, { method: update ? 'PATCH' : 'POST', body, fetchFn });
  if (res.ok && res.body && res.body.professional) {
    const warnings = Array.isArray(res.body.warnings) ? res.body.warnings : [];
    return { ok: true, professional: res.body.professional, warnings };
  }
  return failure(res);
}

/**
 * Envia a foto como corpo binário. Tamanho e tipo checados aqui só para UX.
 * @param {string} id
 * @param {{ size: number, type: string }} file (File/Blob)
 * @returns {Promise<{ ok: true, professional: object } | { ok: false, status?: number, message: string, redirectTo?: string }>}
 */
export async function uploadPhoto(id, file, { fetchFn }) {
  if (!validId(id)) return { ok: false, status: 404, message: PROFESSIONAL_MESSAGES.notFound };
  if (!file || typeof file.size !== 'number') return { ok: false, message: PHOTO_INVALID_MESSAGE };
  if (file.size > LOGO_MAX_BYTES) return { ok: false, message: PROFESSIONAL_MESSAGES.photoTooLarge };
  if (!PHOTO_TYPES.includes(file.type)) return { ok: false, message: PHOTO_INVALID_MESSAGE };

  const res = await requestBinary(`/api/professionals/${id}/photo`, { method: 'PUT', body: file, fetchFn });
  if (res.ok && res.body && res.body.professional) return { ok: true, professional: res.body.professional };
  const { status, message, redirectTo } = failure(res);
  const result = { ok: false, status, message };
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

/** Remove a foto (idempotente no servidor). */
export async function removePhoto(id, { fetchFn }) {
  if (!validId(id)) return { ok: false, status: 404, message: PROFESSIONAL_MESSAGES.notFound };
  const res = await requestJson(`/api/professionals/${id}/photo`, { method: 'DELETE', fetchFn });
  if (res.ok) return { ok: true };
  const { status, message, redirectTo } = failure(res);
  const result = { ok: false, status, message };
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

/**
 * Remove o profissional. 404 = já removido (a tela recarrega a lista); 409 = agendamentos futuros.
 * @returns {Promise<{ ok: true, alreadyRemoved?: true }
 *   | { ok: false, status: 409, blocked: true, count: number, message: string }
 *   | { ok: false, status?: number, message: string, redirectTo?: string }>}
 */
export async function removeProfessional(id, { fetchFn }) {
  if (!validId(id)) return { ok: false, status: 404, message: PROFESSIONAL_MESSAGES.notFound };
  const res = await requestJson(`/api/professionals/${id}`, { method: 'DELETE', fetchFn });
  if (res.ok) return { ok: true };
  if (res.status === 404 && res.error && res.error.code === 'PROFESSIONAL_NOT_FOUND') {
    return { ok: true, alreadyRemoved: true };
  }
  if (res.status === 409 && res.error && res.error.code === 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS') {
    const raw = res.error.futureAppointmentsCount;
    const count = Number.isInteger(raw) && raw > 0 ? raw : 0;
    return { ok: false, status: 409, blocked: true, count, message: removalBlockedMessage(count) };
  }
  const { status, message, redirectTo } = failure(res);
  const result = { ok: false, status, message };
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

/** `photoUrl` só é usado se for um caminho `/media/professionals/<uuid>.png` do próprio site. */
export function safePhotoUrl(url) {
  return typeof url === 'string' && PHOTO_PATH_RE.test(url) ? url : null;
}

/**
 * Opções de serviço do formulário: ativos e desativados já vinculados (com "(inativo)"),
 * na ordem do AF-06 (ativos primeiro; a lista do servidor já vem ordenada).
 * @param {Array<{ id: string, name: string, active: boolean }>} services
 * @param {Array<string|{ id: string }>} linked IDs (ou serviços) vinculados ao profissional
 * @returns {Array<{ id: string, name: string, label: string, active: boolean, checked: boolean }>}
 */
export function serviceChoices(services, linked = []) {
  const linkedIds = new Set((linked || []).map((s) => (typeof s === 'string' ? s : s && s.id)));
  const list = Array.isArray(services) ? services : [];
  const visible = list.filter((s) => s && (s.active || linkedIds.has(s.id)));
  const active = visible.filter((s) => s.active);
  const inactive = visible.filter((s) => !s.active);
  return [...active, ...inactive].map((s) => ({
    id: s.id,
    name: s.name,
    label: s.active ? s.name : `${s.name} ${INACTIVE_SUFFIX}`,
    active: Boolean(s.active),
    checked: linkedIds.has(s.id),
  }));
}

/**
 * Mensagem quando a remoção é bloqueada (critério 29).
 * @param {number} count
 */
export function removalBlockedMessage(count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  const amount = n === 1 ? '1 agendamento futuro' : `${n} agendamentos futuros`;
  return `Este profissional tem ${amount}. Realoque ou cancele esses agendamentos antes de remover.`;
}

/**
 * Rótulos de exibição na lista.
 * @param {{ services?: Array<{ name: string, active: boolean }>, bookable?: boolean }} professional
 * @returns {{ servicesLabel: string, bookableLabel: string|null }}
 */
export function describeProfessional(professional) {
  const services = (professional && professional.services) || [];
  const servicesLabel =
    services.length === 0
      ? 'Nenhum serviço'
      : services.map((s) => (s.active ? s.name : `${s.name} ${INACTIVE_SUFFIX}`)).join(', ');
  return { servicesLabel, bookableLabel: professional && professional.bookable ? null : NOT_BOOKABLE_LABEL };
}
