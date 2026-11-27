import { validatePasswordResetRequest, PASSWORD_RESET_MESSAGES as M } from '/shared/password-reset.js';
import { requestJson } from './api.js';

/**
 * Pedido do link de redefinição (AF-03), sem DOM. A confirmação é SEMPRE a constante local
 * `requested`, qualquer que seja a conta (critérios 1, 2 e 41): o corpo do servidor não é lido.
 * @param {{ email: string }} values
 * @param {{ fetchFn: typeof fetch }} deps
 * @returns {Promise<{ ok: true, message: string } | { ok: false, fields: Record<string,string>, message: string }>}
 */
export async function submitForgotPassword(values, { fetchFn }) {
  const check = validatePasswordResetRequest(values);
  if (!check.ok) return { ok: false, fields: check.fields, message: '' };

  const res = await requestJson('/api/auth/password-reset', { method: 'POST', body: { email: values.email }, fetchFn });
  if (res.status === 202) return { ok: true, message: M.requested };
  if (res.status === 400) {
    const fields = res.error && res.error.fields && res.error.fields.email ? { email: M.emailInvalid } : {};
    return { ok: false, fields, message: Object.keys(fields).length ? '' : M.genericError };
  }
  if (res.status === 429) return { ok: false, fields: {}, message: M.tooMany };
  return { ok: false, fields: {}, message: M.genericError };
}
