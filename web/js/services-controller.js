// Lógica da tela de serviços, sem DOM (testável no Node). O servidor é a autoridade;
// a validação aqui é só para UX.
import {
  validateServiceInput,
  validateStatusFilter,
  formatDuration,
  formatServicePrice,
  SERVICE_ID_RE,
  SERVICE_MESSAGES,
} from '/shared/services.js';
import { requestJson, GENERIC_ERROR_MESSAGE } from './api.js';

const CHECK_FIELDS_MESSAGE = 'Verifique os campos destacados.';

function redirectFor(res) {
  if (res.status === 401) return '/login';
  if (res.status === 409 && res.error && res.error.code === 'BUSINESS_REQUIRED') return '/onboarding';
  return undefined;
}

function failure(res) {
  const known = [400, 401, 404, 409, 413, 415, 429].includes(res.status);
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

const notFound = () => ({ ok: false, status: 404, fields: {}, message: SERVICE_MESSAGES.notFound });

/**
 * GET /api/services?status=...
 * @param {'all'|'active'|'inactive'} [status]
 * @returns {Promise<{ ok: true, services: object[] } | { ok: false, status: number, message: string, redirectTo?: string }>}
 */
export async function loadServices(status, { fetchFn }) {
  const filter = validateStatusFilter(status);
  if (!filter.ok) return { ok: false, status: 400, message: filter.message };
  const res = await requestJson(`/api/services?status=${encodeURIComponent(filter.value)}`, { fetchFn });
  if (res.ok && res.body && Array.isArray(res.body.services)) return { ok: true, services: res.body.services };
  const { status: code, message, redirectTo } = failure(res);
  const result = { ok: false, status: code, message };
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

/**
 * Monta o corpo a partir do formulário: duração do `<select>` vira número; com
 * "Sob consulta" o preço é omitido.
 * @param {{ name: string, durationMinutes: string, price: string, priceOnRequest: boolean }} values
 */
export function buildServiceBody(values) {
  const body = { name: values.name };
  const duration = values.durationMinutes;
  body.durationMinutes = duration === '' || duration === undefined || duration === null ? null : Number(duration);
  if (values.priceOnRequest) {
    body.priceOnRequest = true;
  } else {
    body.priceOnRequest = false;
    body.price = values.price;
  }
  return body;
}

/**
 * Cria (POST) ou edita (PATCH) um serviço. Erros locais não chamam o servidor.
 * @param {{ name: string, durationMinutes: string, price: string, priceOnRequest: boolean }} values
 * @param {{ mode: 'create'|'update', id?: string, fetchFn: typeof fetch }} deps
 * @returns {Promise<{ ok: true, service: object }
 *   | { ok: false, status?: number, fields: Record<string,string>, message: string, redirectTo?: string }>}
 */
export async function submitService(values, { mode = 'create', id, fetchFn }) {
  const update = mode === 'update';
  if (update && (typeof id !== 'string' || !SERVICE_ID_RE.test(id))) return notFound();

  const body = buildServiceBody(values);
  const check = validateServiceInput(body);
  if (!check.ok) return { ok: false, fields: check.fields, message: CHECK_FIELDS_MESSAGE };

  const url = update ? `/api/services/${id}` : '/api/services';
  const res = await requestJson(url, { method: update ? 'PATCH' : 'POST', body, fetchFn });
  if (res.ok && res.body && res.body.service) return { ok: true, service: res.body.service };
  return failure(res);
}

/**
 * Desativa ou reativa.
 * @returns {Promise<{ ok: true, service: object, futureAppointmentsCount?: number|null }
 *   | { ok: false, status?: number, fields: Record<string,string>, message: string, redirectTo?: string }>}
 */
export async function setServiceActive(id, active, { fetchFn }) {
  if (typeof id !== 'string' || !SERVICE_ID_RE.test(id)) return notFound();
  const action = active ? 'reactivate' : 'deactivate';
  const res = await requestJson(`/api/services/${id}/${action}`, { method: 'POST', fetchFn });
  if (res.ok && res.body && res.body.service) {
    const result = { ok: true, service: res.body.service };
    if (!active && 'futureAppointmentsCount' in res.body) result.futureAppointmentsCount = res.body.futureAppointmentsCount;
    return result;
  }
  return failure(res);
}

/** Rótulos de exibição (preço em pt-BR, duração legível, estado). */
export function describeService(service) {
  return {
    durationLabel: formatDuration(service.durationMinutes),
    priceLabel: formatServicePrice(service),
    stateLabel: service.active ? 'Ativo' : 'Desativado',
  };
}

/**
 * Aviso depois de desativar. `null` (falha ao verificar) tem mensagem própria.
 * @param {number|null} count
 * @returns {string|null}
 */
export function deactivationNotice(count) {
  if (count === null) return 'Não foi possível verificar os agendamentos futuros deste serviço.';
  if (!Number.isInteger(count) || count <= 0) return null;
  if (count === 1) return '1 agendamento futuro continua marcado.';
  return `${count} agendamentos futuros continuam marcados.`;
}
