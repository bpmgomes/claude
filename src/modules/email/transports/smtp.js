// Adaptador SMTP genérico (AF-18, design 4.3, critério 24). Configurado só por variáveis de ambiente
// (src/modules/email/email-config.js); nunca há envio real em teste (o teste usa um servidor falso
// em processo). TLS obrigatório (implícito com `secure`, senão STARTTLS exigido) com validação de
// certificado; NÃO existe parâmetro que desligue a verificação: chaves extras são ignoradas.
//
// Usa a conexão SMTP do nodemailer diretamente (uma por mensagem, sem pool) para saber em que fase a
// falha aconteceu: falha de rede ou timeout depois de iniciado o envelope pode ter sido entregue
// (`maybeDelivered`), e o worker então não apaga o token do e-mail.
import { isIP } from 'node:net';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { TransientMailError, PermanentMailError } from '../mail-transport.js';
import { composeMime, envelopeOf } from '../mime.js';
import { SMTP_TIMEOUTS } from '../email-rules.js';

const TLS_ORIGINAL_CODE_RE = /CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|ERR_SSL|HOSTNAME|ALTNAME|EPROTO/i;
const NETWORK_CODES = Object.freeze(['ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EPROTOCOL', 'ESTREAM']);

/**
 * Classifica um erro do nodemailer (`code`, `responseCode`, `command`) em TransientMailError ou
 * PermanentMailError (tabela do design 4.3). Nada do erro original (mensagem, resposta do servidor,
 * endereço) passa para o resultado.
 * @param {any} err
 * @param {'connect'|'auth'|'send'} phase
 * @returns {TransientMailError|PermanentMailError}
 */
export function classifySmtpError(err, phase) {
  const code = String(err?.code ?? '');
  const original = String(err?.originalCode ?? '');
  const command = String(err?.command ?? '').toUpperCase();
  const rc = Number(err?.responseCode) || 0;
  const inSend = phase === 'send';

  if (code === 'EAUTH' || command.startsWith('AUTH')) return new TransientMailError('smtp_auth');
  if (code === 'ETLS' || command === 'STARTTLS' || TLS_ORIGINAL_CODE_RE.test(original) || TLS_ORIGINAL_CODE_RE.test(code)) {
    return new TransientMailError('tls');
  }
  if (rc >= 400 && rc < 500) return new TransientMailError('smtp_4xx');
  if (rc >= 500 && rc < 600) {
    if (command === 'RCPT TO') return new PermanentMailError('recipient_rejected');
    if (command === 'DATA') return new PermanentMailError('smtp_5xx');
    // MAIL FROM, EHLO/HELO, saudação: configuração do remetente/servidor, igual para todas as mensagens.
    return new TransientMailError('smtp_sender');
  }
  if (code === 'ETIMEDOUT' || original === 'ETIMEDOUT') return new TransientMailError('timeout', { maybeDelivered: inSend });
  if (NETWORK_CODES.includes(code) || NETWORK_CODES.includes(original)) {
    return new TransientMailError('network', { maybeDelivered: inSend });
  }
  return new TransientMailError('unknown', { maybeDelivered: inSend });
}

/**
 * @param {{ host: string, port: number, secure: boolean, user?: string|null, password?: string|null,
 *   timeouts?: { connectionMs: number, greetingMs: number, socketMs: number }, ca?: string|Buffer }} options
 *   `ca` só por código (testes, certificado de fixture); nunca por variável de ambiente.
 * @returns {import('../mail-transport.js').MailTransport}
 */
export function createSmtpTransport({ host, port, secure, user = null, password = null, timeouts = SMTP_TIMEOUTS, ca } = {}) {
  const tls = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  if (!isIP(host)) tls.servername = host;
  if (ca) tls.ca = ca;
  // Objeto fechado: só estas chaves chegam ao nodemailer (rejectUnauthorized, ignoreTLS etc. de quem
  // chama são ignorados).
  const options = Object.freeze({
    host,
    port,
    secure: Boolean(secure),
    requireTLS: !secure,
    ignoreTLS: false,
    opportunisticTLS: false,
    tls: Object.freeze(tls),
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    logger: false,
    debug: false,
  });
  const auth = user ? { user, pass: password ?? '' } : null;
  /** Conexões abertas: `close()` (no stop do worker) encerra todas (B3). */
  const live = new Set();

  return {
    /**
     * @param {import('../mail-transport.js').MailMessage} message
     * @param {{ signal?: AbortSignal }} [options] abortar fecha a conexão na hora (teto do worker, stop)
     */
    async send(message, { signal } = {}) {
      if (signal?.aborted) throw new TransientMailError('send_timeout');
      const raw = await composeMime(message);
      return new Promise((resolve, reject) => {
        // Cópias: o nodemailer pode anotar o objeto de opções.
        const conn = new SMTPConnection({ ...options, tls: { ...options.tls } });
        live.add(conn);
        let phase = 'connect';
        let done = false;
        const onAbort = () => {
          if (done) return;
          done = true;
          cleanup();
          closeQuietly(conn);
          reject(new TransientMailError('send_timeout', { maybeDelivered: phase === 'send' }));
        };
        const cleanup = () => {
          live.delete(conn);
          signal?.removeEventListener('abort', onAbort);
        };
        const finish = (err) => {
          if (done) return;
          done = true;
          cleanup();
          if (err) {
            try {
              conn.close();
            } catch {
              // conexão já encerrada
            }
            reject(classifySmtpError(err, phase));
            return;
          }
          try {
            conn.quit();
          } catch {
            // conexão já encerrada
          }
          resolve({ messageId: message.messageId });
        };
        // `on`, não `once`: depois de fechada pelo abort, a conexão ainda pode emitir erro (absorvido).
        conn.on('error', (err) => finish(err));
        conn.once('end', () => finish(Object.assign(new Error('closed'), { code: 'ECONNECTION' })));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) return onAbort();
        const deliver = () => {
          phase = 'send';
          conn.send(envelopeOf(message), raw, (err) => finish(err || null));
        };
        conn.connect((err) => {
          if (err) return finish(err);
          if (!auth) return deliver();
          phase = 'auth';
          conn.login(auth, (loginErr) => (loginErr ? finish(loginErr) : deliver()));
        });
      });
    },

    /** Encerra as conexões ainda abertas (envio abandonado pelo worker). */
    async close() {
      for (const conn of live) closeQuietly(conn);
      live.clear();
    },

    /** Conexões abertas (testes). */
    get openConnections() {
      return live.size;
    },
  };
}

function closeQuietly(conn) {
  try {
    conn.close();
  } catch {
    // conexão já encerrada
  }
}
