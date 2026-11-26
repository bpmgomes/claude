// Adaptador de memória (AF-18, design 4.3, critério 23): só para testes e desenvolvimento. Guarda as
// mensagens em lista; falha, lentidão e travamento são injetáveis por `setBehavior`.
import { TransientMailError, PermanentMailError } from '../mail-transport.js';
import { composeMime } from '../mime.js';

/**
 * @typedef {{ mode: 'ok'|'hang'|'delay'|'throwSync'|'reject'|'transient'|'permanent',
 *   delayMs?: number, code?: string, maybeDelivered?: boolean }} MemoryBehavior
 * `setBehavior` aceita um MemoryBehavior ou uma função `(message, callIndex) => MemoryBehavior`.
 */
export function createMemoryMailTransport() {
  /** @type {import('../mail-transport.js').MailMessage[]} */
  const messages = [];
  let behavior = { mode: 'ok' };
  let calls = 0;
  let aborts = 0;
  const hanging = new Set();

  return {
    messages,
    get calls() {
      return calls;
    },
    /** Envios cujo `signal` foi abortado pelo worker (teto ou stop). */
    get aborts() {
      return aborts;
    },

    /** @param {MemoryBehavior|((message: object, index: number) => MemoryBehavior)} b */
    setBehavior(b) {
      behavior = b ?? { mode: 'ok' };
    },

    clear() {
      messages.length = 0;
      calls = 0;
    },

    /** MIME composto da mensagem `i` (o mesmo de file.js), para testes de cabeçalho. */
    raw(i) {
      return composeMime(messages[i]).then((buf) => buf.toString('utf8'));
    },

    send(message, { signal } = {}) {
      const index = calls;
      calls += 1;
      signal?.addEventListener('abort', () => {
        aborts += 1;
      }, { once: true });
      const b = (typeof behavior === 'function' ? behavior(message, index) : behavior) ?? { mode: 'ok' };
      switch (b.mode) {
        case 'throwSync':
          throw Object.assign(new Error('falha síncrona do adaptador'), { code: b.code ?? 'ETEST' });
        case 'reject':
          return Promise.reject(Object.assign(new Error('falha assíncrona do adaptador'), { code: b.code ?? 'ETEST' }));
        case 'transient':
          return Promise.reject(new TransientMailError(b.code ?? 'network', { maybeDelivered: b.maybeDelivered }));
        case 'permanent':
          return Promise.reject(new PermanentMailError(b.code ?? 'smtp_5xx'));
        case 'hang':
          return new Promise((resolve) => hanging.add(resolve));
        case 'delay':
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              messages.push(message);
              resolve({ messageId: message.messageId });
            }, b.delayMs ?? 0);
            timer.unref?.();
          });
        default:
          messages.push(message);
          return Promise.resolve({ messageId: message.messageId });
      }
    },

    async close() {},
  };
}
