// Validação compartilhada entre backend e browser. Módulo puro, sem imports.

export const NAME_MAX = 100;
export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX_BYTES = 72; // limite do bcrypt

export const MESSAGES = Object.freeze({
  nameRequired: 'Informe seu nome.',
  nameTooLong: 'O nome deve ter no máximo 100 caracteres.',
  nameInvalid: 'O nome contém caracteres inválidos.',
  emailRequired: 'Informe seu e-mail.',
  emailInvalid: 'Informe um e-mail válido.',
  passwordRequirement: 'A senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.',
  passwordTooLong: 'A senha deve ter no máximo 72 caracteres.',
});

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @returns {string} */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/** @returns {string|null} */
export function validateName(raw) {
  if (typeof raw !== 'string') return MESSAGES.nameRequired;
  const name = raw.trim();
  if (name.length === 0) return MESSAGES.nameRequired;
  if ([...name].length > NAME_MAX) return MESSAGES.nameTooLong;
  if (CONTROL_CHARS.test(name)) return MESSAGES.nameInvalid;
  return null;
}

/** @returns {string|null} */
export function validateEmail(raw) {
  const email = normalizeEmail(raw);
  if (email.length === 0) return MESSAGES.emailRequired;
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return MESSAGES.emailInvalid;
  return null;
}

/** @returns {string|null} */
export function validatePassword(raw) {
  if (typeof raw !== 'string') return MESSAGES.passwordRequirement;
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES) return MESSAGES.passwordTooLong;
  if ([...raw].length < PASSWORD_MIN || !/\p{L}/u.test(raw) || !/\d/.test(raw)) {
    return MESSAGES.passwordRequirement;
  }
  return null;
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: { name: string, email: string, password: string } }
 *         | { ok: false, fields: Record<string, string> }}
 */
export function validateSignup(input) {
  const src = input && typeof input === 'object' ? input : {};
  const fields = {};
  const nameError = validateName(src.name);
  if (nameError) fields.name = nameError;
  const emailError = validateEmail(src.email);
  if (emailError) fields.email = emailError;
  const passwordError = validatePassword(src.password);
  if (passwordError) fields.password = passwordError;

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: { name: src.name.trim(), email: normalizeEmail(src.email), password: src.password },
  };
}
