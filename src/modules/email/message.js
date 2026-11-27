// Montagem da mensagem (AF-18, design 4.3, critérios 9, 18 e 19). Módulo puro: cabeçalhos sem
// CR/LF/NUL, um destinatário só, endereço com regra própria e mais estrita que a do AF-04.
import { domainToASCII } from 'node:url';
import { PermanentMailError } from './mail-transport.js';

export const ADDRESS_MAX = 254;
export const LOCAL_PART_MAX = 64;
export const DOMAIN_MAX = 253;
export const SUBJECT_MAX_CODE_POINTS = 250;
export const FROM_NAME_MAX = 64;

/** Proibidos na parte local, além de espaço e controles (design 4.3). */
const LOCAL_FORBIDDEN = new Set(['"', '(', ')', ',', ':', ';', '<', '>', '[', '\\', ']', '%', '@']);
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Domínio como digitado: letras (inclusive IDN), marcas, dígitos, ponto e hífen. Nada mais. */
const RAW_DOMAIN_RE = /^[\p{L}\p{M}\p{N}.-]+$/u;

/**
 * Texto de cabeçalho: \p{Cc}, \p{Cf} e U+2028/U+2029 viram espaço, brancos são juntados e as pontas
 * aparadas. Com `maxCodePoints`, corta e termina em "…".
 * @param {unknown} value
 * @param {number} [maxCodePoints]
 * @returns {string}
 */
export function headerText(value, maxCodePoints) {
  const clean = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!maxCodePoints) return clean;
  const chars = [...clean];
  if (chars.length <= maxCodePoints) return clean;
  return `${chars.slice(0, Math.max(maxCodePoints - 1, 0)).join('').trimEnd()}…`;
}

/**
 * Endereço normalizado para envio (domínio em ASCII/punycode), ou null. Regra (design 4.3, decisão
 * 4 do Gerente): string de até 254; exatamente um '@'; parte local de 1 a 64 caracteres ASCII
 * imprimíveis, sem espaço nem `"(),:;<>[\]%`, sem ponto nas pontas nem dois seguidos; domínio
 * convertido por `domainToASCII` e no formato de nome de host com TLD.
 * @param {unknown} value
 * @returns {string|null}
 */
export function toSafeAddress(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > ADDRESS_MAX) return null;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > LOCAL_PART_MAX) return null;
  for (const ch of local) {
    const code = ch.codePointAt(0);
    if (code < 0x21 || code > 0x7e || LOCAL_FORBIDDEN.has(ch)) return null;
  }
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (domain.length === 0 || domain.length > DOMAIN_MAX || !RAW_DOMAIN_RE.test(domain)) return null;
  const ascii = domainToASCII(domain);
  if (!ascii || ascii.length > DOMAIN_MAX) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l)) || !TLD_RE.test(labels[labels.length - 1])) return null;
  const address = `${local}@${ascii}`;
  return address.length <= ADDRESS_MAX ? address : null;
}

/** @param {unknown} value @returns {boolean} */
export function isSafeAddress(value) {
  return toSafeAddress(value) !== null;
}

/** `<${outboxId}@${messageIdDomain}>`; o domínio é o do EMAIL_FROM (critério 9). */
export function messageIdOf(outboxId, messageIdDomain) {
  return `<${outboxId}@${messageIdDomain}>`;
}

/**
 * MailMessage completa (critérios 18 e 19). Recusa (PermanentMailError 'invalid_header') destinatário
 * ou remetente que não passam em `toSafeAddress` (defesa; o worker já conferiu o destinatário antes
 * de emitir token). Nunca Cc, Bcc nem Reply-To.
 * @param {{
 *   rendered: { subject: string, text: string, html: string, ics?: { content: string, method: string } },
 *   to: string, from: { name: string, address: string }, messageId: string, date: Date,
 * }} input
 * @returns {import('./mail-transport.js').MailMessage}
 */
export function buildMailMessage({ rendered, to, from, messageId, date }) {
  const address = toSafeAddress(to);
  const fromAddress = toSafeAddress(from?.address);
  if (!address || !fromAddress) throw new PermanentMailError('invalid_header');
  if (typeof messageId !== 'string' || !/^<[0-9a-f-]{36}@[A-Za-z0-9.-]+>$/.test(messageId)) {
    throw new PermanentMailError('invalid_header');
  }
  // AF-03: e-mails de conta não têm .ics (anexos vazios); o de agendamento não muda.
  const attachments = [];
  if (rendered.ics) {
    const method = rendered.ics.method === 'CANCEL' ? 'CANCEL' : 'PUBLISH';
    attachments.push({
      filename: 'agendamento.ics',
      content: rendered.ics.content,
      contentType: `text/calendar; charset=UTF-8; method=${method}`,
    });
  }
  return {
    from: { name: headerText(from.name, FROM_NAME_MAX), address: fromAddress },
    to: address,
    subject: headerText(rendered.subject, SUBJECT_MAX_CODE_POINTS),
    text: rendered.text,
    html: rendered.html,
    attachments,
    headers: { 'Auto-Submitted': 'auto-generated' },
    messageId,
    date,
  };
}
