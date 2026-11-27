import { RateLimitedError } from './errors.js';

const UNITS = {
  ms: 1,
  s: 1000, sec: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

/**
 * '1 minute' / '30 seconds' / número (ms) -> ms.
 * @param {number|string} value
 * @returns {number}
 */
export function parseTimeWindow(value) {
  if (Number.isFinite(value) && value > 0) return Math.trunc(value);
  const match = String(value).trim().toLowerCase().match(/^(\d+)\s*([a-z]+)$/);
  if (match && UNITS[match[2]]) return Number(match[1]) * UNITS[match[2]];
  throw new Error(`timeWindow inválido: ${value}`);
}

/**
 * Limitador de janela fixa por usuário autenticado (hook `onRequest`).
 *
 * Plano B do design AF-05 (6.5): o decorator `fastify.rateLimit()` do @fastify/rate-limit
 * marca a requisição com o mesmo símbolo (`rateLimitRan`) usado pelo limite por IP da rota,
 * então quando os dois rodam na mesma rota o segundo é ignorado. Este limitador é
 * independente e deve ser usado depois do `requireAuth`.
 *
 * @param {{ max: number, timeWindow: number|string, now?: () => number }} options
 * @returns {((request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>) & { size: () => number }}
 */
export function createUserRateLimit({ max, timeWindow, now = Date.now }) { // utc
  const windowMs = parseTimeWindow(timeWindow);
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  let nextSweepAt = 0;

  function sweep(current) {
    if (current < nextSweepAt) return;
    for (const [key, bucket] of buckets) if (bucket.resetAt <= current) buckets.delete(key);
    nextSweepAt = current + windowMs;
  }

  const hook = async (request) => {
    if (!request.user) return; // requireAuth roda antes e já respondeu 401
    const current = now();
    sweep(current);
    const key = `user:${request.user.id}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      throw new RateLimitedError(Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)));
    }
  };
  hook.size = () => buckets.size;
  return hook;
}
