import { validatePasswordReset, readResetToken, PASSWORD_RESET_MESSAGES as M, PASSWORD_RESET_REDIRECT } from '/shared/password-reset.js';
import { requestJson } from './api.js';

export { readResetToken };

/** Campos da tela de redefinição. */
export const RESET_FIELDS = Object.freeze(['password', 'passwordConfirmation']);

/**
 * Redefinição (AF-03), sem DOM. Valida com `validatePasswordReset`, que usa a MESMA
 * `validatePassword` do cadastro (critério 15). O token vai só no corpo do POST (critério 13).
 * @param {{ token: string|null, password: string, passwordConfirmation: string }} values
 * @param {{ fetchFn: typeof fetch, navigate: (url: string) => void }} deps
 * @returns {Promise<{ ok: true } | { ok: false, linkInvalid: true }
 *   | { ok: false, fields: Record<string,string>, message: string }>}
 */
export async function submitResetPassword({ token, password, passwordConfirmation }, { fetchFn, navigate }) {
  if (typeof token !== 'string' || token === '') return { ok: false, linkInvalid: true };
  const check = validatePasswordReset({ password, passwordConfirmation });
  if (!check.ok) return { ok: false, fields: check.fields, message: '' };

  const res = await requestJson('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { token, password, passwordConfirmation },
    fetchFn,
  });
  if (res.ok && res.status === 200) {
    const target = res.body && res.body.redirectTo === PASSWORD_RESET_REDIRECT ? res.body.redirectTo : PASSWORD_RESET_REDIRECT;
    navigate(target);
    return { ok: true };
  }
  if (res.status === 400 && res.error && res.error.code === 'PASSWORD_RESET_LINK_INVALID') return { ok: false, linkInvalid: true };
  if (res.status === 400) {
    const fields = {};
    const server = (res.error && res.error.fields) || {};
    // Só textos conhecidos: a tela nunca mostra texto arbitrário do servidor.
    for (const field of RESET_FIELDS) if (typeof server[field] === 'string') fields[field] = server[field];
    return { ok: false, fields, message: Object.keys(fields).length ? '' : M.genericError };
  }
  if (res.status === 429) return { ok: false, fields: {}, message: M.tooMany };
  return { ok: false, fields: {}, message: M.genericError };
}
