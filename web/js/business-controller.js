import { validateBusinessInput, LOGO_MAX_BYTES } from '/shared/validation.js';
import { slugify, validateSlug } from '/shared/slug.js';
import { requestJson, requestBinary, GENERIC_ERROR_MESSAGE } from './api.js';

export const LOGO_TYPES = Object.freeze(['image/png', 'image/jpeg']);
export const LOGO_TOO_LARGE_MESSAGE = 'O logo deve ter no máximo 2 MB.';
export const LOGO_INVALID_MESSAGE = 'Envie uma imagem PNG ou JPG válida.';
const CHECK_FIELDS_MESSAGE = 'Verifique os campos destacados.';
const FIELDS = ['name', 'address', 'phone', 'slug', 'cancellationLeadMinutes'];
const LOGO_PATH_RE = /^\/media\/logos\/[0-9a-f-]{36}\.png$/;

/**
 * Valor do campo de antecedência (AF-12): `/^\d{1,4}$/` vira número; outra entrada passa como está,
 * para cair em `leadNotInteger` na validação local (a mesma do servidor).
 */
export function toLeadMinutes(raw) {
  if (typeof raw === 'string' && /^\d{1,4}$/.test(raw)) return Number(raw);
  return raw;
}

/** Slug sugerido a partir do nome, para pré-preencher o campo. */
export function suggestSlugFromName(name) {
  return slugify(name);
}

/** `logoUrl` só é usado se for um caminho `/media/logos/<uuid>.png` do próprio site. */
export function safeLogoUrl(url) {
  return typeof url === 'string' && LOGO_PATH_RE.test(url) ? url : null;
}

/** `publicUrl` só vira link se for http(s) absoluto. */
export function safePublicUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function failure(res) {
  if (res.status === 400 || res.status === 409) {
    const result = { ok: false, status: res.status, fields: res.error.fields || {}, message: res.error.message };
    if (typeof res.error.suggestion === 'string') result.suggestion = res.error.suggestion;
    return result;
  }
  if (res.status === 401 || res.status === 404 || res.status === 413 || res.status === 415 ||
      res.status === 422 || res.status === 429) {
    return { ok: false, status: res.status, fields: {}, message: res.error.message };
  }
  return { ok: false, status: res.status, fields: {}, message: GENERIC_ERROR_MESSAGE };
}

/**
 * Cria (POST) ou edita (PATCH) o negócio. Valida antes; o servidor é a autoridade.
 * @param {{ name?: string, address?: string, phone?: string, slug?: string,
 *   cancellationLeadMinutes?: string|number }} input  o prazo (AF-12) vai como número
 * @param {{ mode: 'create'|'update', fetchFn: typeof fetch }} deps
 * @returns {Promise<{ ok: true, business: object, redirectTo?: string }
 *   | { ok: false, status?: number, fields: Record<string,string>, message: string, suggestion?: string }>}
 */
export async function submitBusiness(input, { mode = 'create', fetchFn }) {
  const partial = mode === 'update';
  const values = { ...input };
  if (values.cancellationLeadMinutes !== undefined) values.cancellationLeadMinutes = toLeadMinutes(values.cancellationLeadMinutes);
  const check = validateBusinessInput(values, { partial });
  const fields = check.ok ? {} : { ...check.fields };
  const slugGiven = values.slug !== undefined && values.slug !== null && values.slug !== '';
  if (!partial && !slugGiven && !fields.name) {
    const generated = validateSlug(slugify(values.name));
    if (!generated.ok) fields.slug = generated.message;
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields, message: CHECK_FIELDS_MESSAGE };

  const body = {};
  for (const key of FIELDS) if (values[key] !== undefined) body[key] = values[key];

  const res = await requestJson('/api/business', { method: partial ? 'PATCH' : 'POST', body, fetchFn });
  if (res.ok && res.body && res.body.business) {
    const result = { ok: true, business: res.body.business };
    if (typeof res.body.redirectTo === 'string') result.redirectTo = res.body.redirectTo;
    return result;
  }
  return failure(res);
}

/**
 * Checagem de disponibilidade. Slug inválido localmente não chama o servidor.
 * @returns {Promise<{ ok: true, slug: string, available: boolean, reason?: string, message?: string, suggestion?: string }
 *   | { ok: false, status: number, message: string }>}
 */
export async function checkSlugAvailability(slug, { fetchFn }) {
  const local = validateSlug(slug);
  if (!local.ok) return { ok: true, slug: String(slug ?? ''), available: false, reason: local.reason, message: local.message };
  const res = await requestJson(`/api/business/slug-availability?slug=${encodeURIComponent(local.value)}`, { fetchFn });
  if (res.ok && res.body && typeof res.body.available === 'boolean') return { ok: true, ...res.body };
  return { ok: false, status: res.status, message: res.status === 429 ? res.error.message : GENERIC_ERROR_MESSAGE };
}

/**
 * Envia o logo como corpo binário. Tamanho e tipo checados aqui só para UX.
 * @param {{ size: number, type: string }} file (File/Blob)
 * @returns {Promise<{ ok: true, business: object } | { ok: false, status?: number, message: string }>}
 */
export async function uploadLogo(file, { fetchFn }) {
  if (!file || typeof file.size !== 'number') return { ok: false, message: LOGO_INVALID_MESSAGE };
  if (file.size > LOGO_MAX_BYTES) return { ok: false, message: LOGO_TOO_LARGE_MESSAGE };
  if (!LOGO_TYPES.includes(file.type)) return { ok: false, message: LOGO_INVALID_MESSAGE };

  const res = await requestBinary('/api/business/logo', { method: 'PUT', body: file, fetchFn });
  if (res.ok && res.body && res.body.business) return { ok: true, business: res.body.business };
  const { status, message } = failure(res);
  return { ok: false, status, message };
}

/** Remove o logo. */
export async function removeLogo({ fetchFn }) {
  const res = await requestJson('/api/business/logo', { method: 'DELETE', fetchFn });
  if (res.ok) return { ok: true };
  const { status, message } = failure(res);
  return { ok: false, status, message };
}

/** GET /api/business. */
export async function loadBusiness({ fetchFn }) {
  const res = await requestJson('/api/business', { fetchFn });
  if (res.ok && res.body && res.body.business) return { ok: true, status: res.status, business: res.body.business };
  return { ok: false, status: res.status, message: res.status === 0 ? GENERIC_ERROR_MESSAGE : res.error.message };
}
