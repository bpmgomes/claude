// MIME das mensagens (AF-18, design 4.3) pelo nodemailer, sem rede: o único mapeamento
// MailMessage -> opções do nodemailer, compartilhado pelos três adaptadores.
import nodemailer from 'nodemailer';

let composer = null;

function streamComposer() {
  if (!composer) {
    composer = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'windows',
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  }
  return composer;
}

/**
 * Opções do nodemailer. `to` como objeto `{ name: '', address }` (nunca uma string com nome, para o
 * analisador de endereços não interpretar nada); sem `cc`, `bcc` nem `replyTo`; anexos só como
 * string, sem `path` nem `href`.
 * @param {import('./mail-transport.js').MailMessage} message
 */
export function toNodemailerOptions(message) {
  return {
    from: { name: message.from.name, address: message.from.address },
    to: [{ name: '', address: message.to }],
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: message.attachments.map((a) => ({
      filename: a.filename,
      content: String(a.content),
      contentType: a.contentType,
    })),
    headers: { ...message.headers },
    messageId: message.messageId,
    date: message.date,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** Envelope SMTP: o remetente do sistema e o único destinatário. */
export function envelopeOf(message) {
  return { from: message.from.address, to: [message.to] };
}

/**
 * MIME completo, com CRLF.
 * @param {import('./mail-transport.js').MailMessage} message
 * @returns {Promise<Buffer>}
 */
export async function composeMime(message) {
  const info = await streamComposer().sendMail(toNodemailerOptions(message));
  return info.message;
}
