// Porta de envio de e-mail (AF-18, design 4.3, critério 23). Os adaptadores ficam em ./transports/.
import { EMAIL_TRANSIENT_CODES, EMAIL_PERMANENT_CODES } from './email-rules.js';

/**
 * @typedef {{
 *   from: { name: string, address: string }, to: string,          // um destinatário, sem nome
 *   subject: string, text: string, html: string,
 *   attachments: Array<{ filename: 'agendamento.ics', content: string, contentType: string }>,
 *   headers: { 'Auto-Submitted': 'auto-generated' },
 *   messageId: string, date: Date,
 * }} MailMessage
 * @typedef {{ send(message: MailMessage, options?: { signal?: AbortSignal }): Promise<{ messageId: string }>,
 *   close?(): Promise<void> }} MailTransport
 * `signal`: o worker aborta no teto de envio e no stop; o adaptador deve encerrar o envio (B3).
 */

const TRANSIENT_MESSAGE = 'Falha temporária no envio de e-mail.';
const PERMANENT_MESSAGE = 'Falha permanente no envio de e-mail.';

/**
 * Falha que vale tentar de novo. Mensagem fixa e SEM `cause`: nada do servidor (endereço, resposta
 * SMTP) fica no objeto. `maybeDelivered`: a falha pode ter acontecido depois de o servidor aceitar a
 * mensagem (queda ou timeout durante ou depois do DATA, ou o teto rígido do worker).
 */
export class TransientMailError extends Error {
  /** @param {string} code um de EMAIL_TRANSIENT_CODES @param {{ maybeDelivered?: boolean }} [options] */
  constructor(code, { maybeDelivered = false } = {}) {
    super(TRANSIENT_MESSAGE);
    this.name = 'TransientMailError';
    this.code = EMAIL_TRANSIENT_CODES.includes(code) ? code : 'unknown';
    this.maybeDelivered = Boolean(maybeDelivered);
  }
}

/** Falha que não melhora com nova tentativa. Mensagem fixa e sem `cause`. */
export class PermanentMailError extends Error {
  /** @param {string} code um de EMAIL_PERMANENT_CODES */
  constructor(code) {
    super(PERMANENT_MESSAGE);
    this.name = 'PermanentMailError';
    this.code = EMAIL_PERMANENT_CODES.includes(code) ? code : 'smtp_5xx';
    this.maybeDelivered = false;
  }
}
