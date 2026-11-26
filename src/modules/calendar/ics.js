// Gerador mínimo de iCalendar (RFC 5545) para os e-mails do AF-18 (design 4.3, critérios 20 a 22).
// Módulo puro e reutilizável (AF-13). Só UTC (sem VTIMEZONE), sem ATTENDEE, ORGANIZER nem URL: o
// arquivo nunca leva token, link, nome, e-mail ou telefone do cliente.
import { createHash } from 'node:crypto';

export const ICS_PRODID = '-//AgendaFacil//Agendamento//PT-BR';
export const ICS_MAX_LINE_OCTETS = 75;
export const ICS_METHODS = Object.freeze(['PUBLISH', 'CANCEL']);
export const ICS_STATUSES = Object.freeze(['CONFIRMED', 'CANCELLED']);

/**
 * `sha256(rootAppointmentId)` em hex (64) + '@' + hostname de `publicBaseUrl`. Nunca o UUID cru:
 * o UID vai para calendários de terceiros (critério 21).
 * @param {string} rootAppointmentId
 * @param {string} publicBaseUrl
 */
export function icsUidOf(rootAppointmentId, publicBaseUrl) {
  const hash = createHash('sha256').update(String(rootAppointmentId), 'utf8').digest('hex');
  return `${hash}@${new URL(publicBaseUrl).hostname}`;
}

/** 'YYYYMMDDTHHMMSSZ' de um instante em ms. */
export function icsUtc(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/**
 * Valor TEXT (RFC 5545, 3.3.11): escape de `\`, `;`, `,` e quebra de linha (`\n`); demais
 * caracteres de controle e separadores de linha Unicode removidos.
 */
export function escapeIcsText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Dobra uma linha de conteúdo em até 75 octetos por linha física, sem partir um caractere UTF-8
 * (nem um par substituto). Continuação com um espaço, que conta nos 75.
 * @param {string} line
 * @returns {string} linhas físicas unidas por CRLF
 */
export function foldLine(line) {
  const out = [];
  let current = '';
  let currentBytes = 0;
  let limit = ICS_MAX_LINE_OCTETS;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + size > limit) {
      out.push(current);
      current = ' ';
      currentBytes = 1;
      limit = ICS_MAX_LINE_OCTETS;
    }
    current += ch;
    currentBytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

/**
 * VCALENDAR com um VEVENT (critério 20). CRLF em toda linha, inclusive a última.
 * @param {{
 *   method: 'PUBLISH'|'CANCEL', uid: string, sequence: number, dtstampMs: number,
 *   startMs: number, endMs: number, summary: string, location: string, description: string,
 *   status: 'CONFIRMED'|'CANCELLED',
 * }} input
 * @returns {string}
 * @throws {TypeError} método, status ou sequência fora do domínio (erro de programação)
 */
export function buildIcs({ method, uid, sequence, dtstampMs, startMs, endMs, summary, location, description, status }) {
  if (!ICS_METHODS.includes(method)) throw new TypeError('buildIcs: method inválido.');
  if (!ICS_STATUSES.includes(status)) throw new TypeError('buildIcs: status inválido.');
  if (!Number.isInteger(sequence) || sequence < 0) throw new TypeError('buildIcs: sequence inválida.');
  if (typeof uid !== 'string' || !/^[0-9a-f]{64}@[A-Za-z0-9.-]+$/.test(uid)) throw new TypeError('buildIcs: uid inválido.');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(dtstampMs)}`,
    `DTSTART:${icsUtc(startMs)}`,
    `DTEND:${icsUtc(endMs)}`,
    `SEQUENCE:${sequence}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `STATUS:${status}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
