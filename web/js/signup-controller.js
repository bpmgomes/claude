import { validateSignup } from '/shared/validation.js';
import { requestJson, GENERIC_ERROR_MESSAGE } from './api.js';

/**
 * Lógica do cadastro, sem DOM.
 * @param {{ name: string, email: string, password: string }} values
 * @param {{ fetchFn: typeof fetch, navigate: (url: string) => void }} deps
 * @returns {Promise<{ ok: true } | { ok: false, fields: Record<string,string>, message: string }>}
 */
export async function submitSignup(values, { fetchFn, navigate }) {
  const check = validateSignup(values);
  if (!check.ok) {
    return { ok: false, fields: check.fields, message: 'Verifique os campos destacados.' };
  }

  const res = await requestJson('/api/accounts', {
    method: 'POST',
    body: { name: values.name, email: values.email, password: values.password },
    fetchFn,
  });

  if (res.ok && res.status === 201) {
    navigate((res.body && res.body.redirectTo) || '/onboarding');
    return { ok: true };
  }

  if (res.status === 400 || res.status === 409) {
    return { ok: false, fields: res.error.fields || {}, message: res.error.message };
  }

  if (res.status === 429) {
    return { ok: false, fields: {}, message: res.error.message };
  }

  return { ok: false, fields: {}, message: GENERIC_ERROR_MESSAGE };
}
