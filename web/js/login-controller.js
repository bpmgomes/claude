import { validateLogin } from '/shared/validation.js';
import { requestJson, GENERIC_ERROR_MESSAGE } from './api.js';

/**
 * Lógica do login, sem DOM.
 * @param {{ email: string, password: string }} values
 * @param {{ fetchFn: typeof fetch, navigate: (url: string) => void }} deps
 * @returns {Promise<{ ok: true } | { ok: false, fields: Record<string,string>, message: string }>}
 */
export async function submitLogin(values, { fetchFn, navigate }) {
  const check = validateLogin(values);
  if (!check.ok) {
    return { ok: false, fields: check.fields, message: 'Verifique os campos destacados.' };
  }

  const res = await requestJson('/api/auth/login', {
    method: 'POST',
    body: { email: values.email, password: values.password },
    fetchFn,
  });

  if (res.ok && res.status === 200) {
    navigate((res.body && res.body.redirectTo) || '/onboarding');
    return { ok: true };
  }

  if (res.status === 400) {
    return { ok: false, fields: res.error.fields || {}, message: res.error.message };
  }

  if (res.status === 401 || res.status === 429) {
    return { ok: false, fields: {}, message: res.error.message };
  }

  return { ok: false, fields: {}, message: GENERIC_ERROR_MESSAGE };
}

/**
 * Encerra a sessão atual. Navega para /login em qualquer resultado.
 * @param {{ fetchFn: typeof fetch, navigate: (url: string) => void }} deps
 */
export async function logout({ fetchFn, navigate }) {
  await requestJson('/api/auth/logout', { method: 'POST', fetchFn });
  navigate('/login');
}
