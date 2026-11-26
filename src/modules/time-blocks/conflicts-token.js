// Token de confirmação dos conflitos de um bloqueio (AF-16 item 1, tratado no AF-11, critério 36).
// HMAC-SHA256 com segredo do servidor sobre (usuário, negócio, alvo, período, versionKey, prazo):
// um token só vale para quem o recebeu, para o mesmo alvo e período, para a mesma lista de
// conflitos e por até 10 minutos. Comparação em tempo constante.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONFLICTS_TOKEN_TTL_SECONDS = 600;
/** 'v1.<exp em segundos Unix, 10 dígitos>.<base64url de 32 bytes>' = 57 caracteres. */
export const CONFLICTS_TOKEN_RE = /^v1\.\d{10}\.[A-Za-z0-9_-]{43}$/;
export const CONFLICTS_TOKEN_LENGTH = 57;
/** Teto conferido antes do regex (entrada longa nunca chega a ele). */
export const CONFLICTS_TOKEN_MAX_LENGTH = 64;

/** Indireção para o teste espionar a comparação em tempo constante. */
export const crypto = { timingSafeEqual };

function payloadOf({ userId, businessId, professionalId, startsAt, endsAt, versionKey }, exp) {
  return JSON.stringify(['v1', userId, businessId, professionalId ?? '*', startsAt, endsAt, versionKey, exp]);
}

function macOf(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * @param {string} secret
 * @param {{ userId: string, businessId: string, professionalId: string|null, startsAt: string, endsAt: string, versionKey: string }} claims
 * @param {number} nowMs
 * @returns {string}
 */
export function signConflictsToken(secret, claims, nowMs) {
  const exp = Math.floor(nowMs / 1000) + CONFLICTS_TOKEN_TTL_SECONDS;
  return `v1.${exp}.${macOf(secret, payloadOf(claims, exp))}`;
}

/**
 * true só se o formato, o prazo (exp > agora) e o MAC conferem. Nunca lança.
 * @param {string} secret
 * @param {unknown} token
 * @param {{ userId: string, businessId: string, professionalId: string|null, startsAt: string, endsAt: string, versionKey: string }} claims
 * @param {number} nowMs
 * @returns {boolean}
 */
export function verifyConflictsToken(secret, token, claims, nowMs) {
  if (typeof token !== 'string' || token.length > CONFLICTS_TOKEN_MAX_LENGTH) return false;
  if (token.length !== CONFLICTS_TOKEN_LENGTH || !CONFLICTS_TOKEN_RE.test(token)) return false;
  const exp = Number(token.slice(3, 13));
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs) return false;
  const expected = Buffer.from(macOf(secret, payloadOf(claims, exp)), 'utf8');
  const sent = Buffer.from(token.slice(14), 'utf8');
  if (expected.length !== sent.length) return false;
  return crypto.timingSafeEqual(expected, sent);
}
