import { ImageBusyError } from '../http/errors.js';

/**
 * Semáforo com fila curta, por processo (design AF-07, 4.2; fecha AF-05 item 2).
 * Dividido entre logo e foto: uma instância em buildApp.
 *
 * - há vaga -> executa;
 * - senão, fila com menos de `queueMax` itens -> espera a vez (ordem de chegada);
 * - senão -> ImageBusyError na hora.
 * Quem espera na fila mais de `queueTimeoutMs` sai da fila com ImageBusyError.
 * A vaga é liberada no finally (sucesso, InvalidImageError ou erro inesperado).
 *
 * @param {{ concurrency: number, queueMax: number, queueTimeoutMs: number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} options
 *   `timers` só para testes (relógio controlado).
 * @returns {{ run<T>(task: () => Promise<T>): Promise<T>, stats(): { active: number, queued: number } }}
 */
export function createImageLimiter({ concurrency, queueMax, queueTimeoutMs, timers = globalThis }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency inválido');
  if (!Number.isInteger(queueMax) || queueMax < 0) throw new Error('queueMax inválido');
  if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0) throw new Error('queueTimeoutMs inválido');

  let active = 0;
  /** @type {Array<{ start: () => void, timer: unknown }>} */
  const queue = [];

  async function execute(task) {
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      next();
    }
  }

  function next() {
    while (active < concurrency && queue.length > 0) {
      const entry = queue.shift();
      timers.clearTimeout(entry.timer);
      entry.start();
    }
  }

  return {
    run(task) {
      if (active < concurrency && queue.length === 0) return execute(task);
      if (queue.length >= queueMax) return Promise.reject(new ImageBusyError());
      return new Promise((resolve, reject) => {
        const entry = {
          start: () => execute(task).then(resolve, reject),
          timer: null,
        };
        entry.timer = timers.setTimeout(() => {
          const index = queue.indexOf(entry);
          if (index === -1) return;
          queue.splice(index, 1);
          reject(new ImageBusyError());
        }, queueTimeoutMs);
        queue.push(entry);
      });
    },
    stats() {
      return { active, queued: queue.length };
    },
  };
}

/** Sem limite: padrão nos construtores dos serviços (testes unitários). */
export const unlimitedImageLimiter = Object.freeze({
  run: (task) => task(),
  stats: () => ({ active: 0, queued: 0 }),
});
