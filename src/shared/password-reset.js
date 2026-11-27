// Regras e textos da recuperação de senha (AF-03, design 4.2). Módulo puro, servido ao navegador como
// /shared/password-reset.js. Fora do grafo da página pública: só as telas de conta o importam.
import { MESSAGES, normalizeEmail, validateEmail, validatePassword } from './validation.js';

export const PASSWORD_RESET_TOKEN_BYTES = 32; // 43 caracteres base64url
export const PASSWORD_RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const PASSWORD_RESET_TTL_MS = 3_600_000; // 1 h; vale enquanto agora < expires_at
export const PASSWORD_RESET_PATH = '/redefinir-senha';
export const PASSWORD_RESET_FRAGMENT_KEY = 'token'; // /redefinir-senha#token=...
export const PASSWORD_RESET_SUCCESS_QUERY = 'senha-alterada';
/** Para onde a tela vai depois da troca (decisão 3: sem login automático). */
export const PASSWORD_RESET_REDIRECT = `/login?${PASSWORD_RESET_SUCCESS_QUERY}=1`;

/** Textos fixos (critério 36). Nenhum interpola dado do usuário. */
export const PASSWORD_RESET_MESSAGES = Object.freeze({
  requestTitle: 'Redefinir senha',
  emailLabel: 'E-mail',
  submitRequest: 'Enviar link',
  requested: 'Se este e-mail estiver cadastrado, enviaremos um link para redefinir a senha. O link vale por 1 hora.',
  emailInvalid: MESSAGES.emailInvalid,
  linkInvalid: 'Link inválido ou expirado. Peça um novo link.',
  requestNewLink: 'Pedir um novo link',
  resetTitle: 'Criar nova senha',
  passwordLabel: 'Nova senha',
  confirmationLabel: 'Confirme a nova senha',
  submitReset: 'Salvar nova senha',
  passwordMismatch: 'As senhas não coincidem.',
  changed: 'Senha alterada. Entre com a nova senha.',
  tooMany: 'Muitas tentativas. Tente novamente mais tarde.',
  forgotLink: 'Esqueci minha senha',
  genericError: 'Não foi possível concluir agora. Tente novamente.',
});

/**
 * Lê o token de `location.hash` ('#token=...'); null se ausente ou fora do formato. Sem DOM.
 * @param {unknown} hash
 * @returns {string|null}
 */
export function readResetToken(hash) {
  if (typeof hash !== 'string') return null;
  const prefix = `#${PASSWORD_RESET_FRAGMENT_KEY}=`;
  if (!hash.startsWith(prefix)) return null;
  const token = hash.slice(prefix.length);
  return PASSWORD_RESET_TOKEN_RE.test(token) ? token : null;
}

/**
 * Pedido: e-mail normalizado como no AF-01; qualquer erro de e-mail vira `emailInvalid` (critério 5).
 * @param {unknown} input
 * @returns {{ ok: true, value: { email: string } } | { ok: false, fields: { email: string } }}
 */
export function validatePasswordResetRequest(input) {
  const src = input && typeof input === 'object' ? input : {};
  if (typeof src.email !== 'string' || validateEmail(src.email) !== null) {
    return { ok: false, fields: { email: PASSWORD_RESET_MESSAGES.emailInvalid } };
  }
  return { ok: true, value: { email: normalizeEmail(src.email) } };
}

/**
 * Redefinição: `password` pela validatePassword do cadastro (a MESMA função, critério 15);
 * `passwordConfirmation` só se a chave existir (critério 17). Não olha o token (regra do servidor).
 * @param {unknown} input
 * @returns {{ ok: true, value: { password: string } } | { ok: false, fields: Record<string, string> }}
 */
export function validatePasswordReset(input) {
  const src = input && typeof input === 'object' ? input : {};
  const fields = {};
  const passwordError = validatePassword(src.password);
  if (passwordError) fields.password = passwordError;
  if (Object.prototype.hasOwnProperty.call(src, 'passwordConfirmation') && src.passwordConfirmation !== src.password) {
    fields.passwordConfirmation = PASSWORD_RESET_MESSAGES.passwordMismatch;
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { password: src.password } };
}
