import { requireAuth } from '../modules/auth/auth.plugin.js';
import { createUserRateLimit } from './user-rate-limit.js';
import { rateLimitKey } from './ip-key.js';

/**
 * Hooks e config de UMA rota para um bucket de `config.rateLimit` (ex.: 'businessWrite').
 *
 * Cada chamada devolve objetos novos: array `onRequest`, limitador por usuário e `config`.
 * Nunca reaproveite o retorno entre rotas: o @fastify/rate-limit faz push no array
 * `onRequest` (o Fastify copia as opções da rota de forma rasa) e só executa o primeiro
 * handler que encontrar, então rotas que dividem o array dividem também o balde de IP.
 * Não congelar o retorno (Object.freeze quebraria o push do plugin).
 *
 * Cada rota tem seus próprios contadores, por IP e por usuário, com os valores do bucket;
 * o bucket é só a configuração (design AF-06, decisão 12). Uma rota GET registrada com
 * estes guards gera também a rota HEAD automática do Fastify com as mesmas opções, e o
 * HEAD divide o contador com o GET da mesma URL (mesmo recurso, aceitável).
 *
 * Ordem no onRequest: requireAuth (401), limite por usuário e, depois (adicionado pelo
 * @fastify/rate-limit), limite por IP. O corpo ainda não foi lido em nenhum deles.
 *
 * @param {object} config app.config
 * @param {string} bucket chave em config.rateLimit com { perUser, perIp }
 * @returns {{ onRequest: Function[], config: { rateLimit?: { max: number, timeWindow: string|number } } }}
 */
export function createRouteGuards(config, bucket) {
  const rl = config.rateLimit;
  if (!rl.enabled) return { onRequest: [requireAuth], config: {} };
  const limits = rl[bucket];
  if (!limits) throw new Error(`Bucket de rate limit desconhecido: ${bucket}`);
  const userLimit = createUserRateLimit({ max: limits.perUser, timeWindow: rl.timeWindow });
  return {
    onRequest: [requireAuth, userLimit],
    config: { rateLimit: { max: limits.perIp, timeWindow: rl.timeWindow } },
  };
}

/** Só autenticação, sem limite (leituras). Array novo a cada chamada. */
export function authOnly() {
  return { onRequest: [requireAuth] };
}

/** keyGenerator das rotas públicas: IP com IPv6 agrupado no /64. */
export const publicKeyGenerator = (request) => rateLimitKey(request.ip);

/**
 * Guards de UMA rota pública (design AF-09, 4.3): sem requireAuth, sem limite por usuário,
 * limite por IP com chave `rateLimitKey` e `publicRoute: true` (o auth.plugin não lê a sessão).
 * Objetos novos a cada chamada, pelo mesmo motivo de createRouteGuards: nunca reaproveite o
 * retorno entre rotas.
 * @param {object} config app.config
 * @param {string} bucket chave em config.rateLimit com { perIp }
 * @returns {{ onRequest: Function[], config: { publicRoute: true, rateLimit?: { max: number, timeWindow: string|number, keyGenerator: Function } } }}
 */
export function createPublicRouteGuards(config, bucket) {
  const rl = config.rateLimit;
  if (!rl.enabled) return { onRequest: [], config: { publicRoute: true } };
  const limits = rl[bucket];
  if (!limits) throw new Error(`Bucket de rate limit desconhecido: ${bucket}`);
  return {
    onRequest: [],
    config: {
      publicRoute: true,
      rateLimit: { max: limits.perIp, timeWindow: rl.timeWindow, keyGenerator: publicKeyGenerator },
    },
  };
}
