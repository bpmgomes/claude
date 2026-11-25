import { requireAuth } from '../modules/auth/auth.plugin.js';
import { createUserRateLimit } from './user-rate-limit.js';

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
