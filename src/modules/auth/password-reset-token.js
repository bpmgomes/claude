// Token de redefinição de senha (AF-03, design 4.3). Mesmo formato do AF-12 (32 bytes de
// `randomBytes` em base64url, SHA-256 hex), sem importar do módulo de agendamentos.
import { randomBytes, createHash } from 'node:crypto';
import { PASSWORD_RESET_TOKEN_BYTES, PASSWORD_RESET_PATH, PASSWORD_RESET_FRAGMENT_KEY } from '../../shared/password-reset.js';

/**
 * 32 bytes de `randomBytes` em base64url (43 caracteres, critério 8). A única entrada é o gerador.
 * @param {(size: number) => Buffer} [random]
 * @returns {{ token: string, tokenHash: string }}
 */
export function newResetToken(random = randomBytes) {
  const token = Buffer.from(random(PASSWORD_RESET_TOKEN_BYTES)).toString('base64url');
  return { token, tokenHash: hashResetToken(token) };
}

/** sha256(token, 'utf8') em hex minúsculo, 64 caracteres. */
export function hashResetToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Prefixo do link: `publicBaseUrl + '/redefinir-senha#token='`. Nunca o cabeçalho Host. */
export function resetUrlPrefix(publicBaseUrl) {
  return `${String(publicBaseUrl ?? '').replace(/\/+$/, '')}${PASSWORD_RESET_PATH}#${PASSWORD_RESET_FRAGMENT_KEY}=`;
}

/** Link do e-mail: o token vai no FRAGMENTO (decisão 2), que nunca chega ao servidor. */
export function resetUrlOf(publicBaseUrl, token) {
  return `${resetUrlPrefix(publicBaseUrl)}${token}`;
}
