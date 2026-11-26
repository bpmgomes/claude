// Token de gerenciar o agendamento (AF-12, design 4.3). Módulo puro: só `node:crypto`.
import { randomBytes, createHash } from 'node:crypto';
import { MANAGE_TOKEN_BYTES, MANAGE_PATH_PREFIX } from '../../shared/appointments.js';

/**
 * 32 bytes de `randomBytes` em base64url (43 caracteres). Nunca derivado de id, cliente, horário ou
 * contador (critério 4): a única entrada é o gerador.
 * @param {(size: number) => Buffer} [random]
 * @returns {{ token: string, tokenHash: string }}
 */
export function newManageToken(random = randomBytes) {
  const token = Buffer.from(random(MANAGE_TOKEN_BYTES)).toString('base64url');
  return { token, tokenHash: hashManageToken(token) };
}

/** sha256(token, 'utf8') em hex minúsculo, 64 caracteres (critério 5). */
export function hashManageToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** `publicBaseUrl + '/agendamento/' + token`. Nunca o cabeçalho Host (critério 8). */
export function manageUrlOf(publicBaseUrl, token) {
  return `${String(publicBaseUrl ?? '').replace(/\/+$/, '')}${MANAGE_PATH_PREFIX}${token}`;
}

/**
 * `change.version` (design 4.1, decisão 8): base64url(sha256('v1\n' + id + '\n' + status + '\n' +
 * updated_at)), 43 caracteres. Opaca: muda a cada cancelamento e é outra a cada remarcação (o id muda).
 * @param {{ id: string, status: string, updatedAt: string }} row
 */
export function appointmentVersionOf({ id, status, updatedAt }) {
  return createHash('sha256').update(`v1\n${id}\n${status}\n${updatedAt}`, 'utf8').digest('base64url');
}
