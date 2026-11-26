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

/** Erro de limite no formato do @fastify/rate-limit (statusCode 429), tratado pelos errorHandlers. */
function rateLimitedError(ttlInSeconds) {
  const err = new Error(`Rate limit exceeded, retry in ${ttlInSeconds} seconds`);
  err.statusCode = 429;
  return err;
}

/**
 * Limitador por IP COMPARTILHADO entre rotas públicas de leitura do negócio (AF-09 item 3, AF-10
 * critério 25). Criado UMA vez (em buildApp, depois do registro do @fastify/rate-limit) com
 * `app.createRateLimit({ max: bucket.perIp, timeWindow, keyGenerator: publicKeyGenerator })`: um store
 * próprio, e o MESMO hook vai no `onRequest` (ou `preHandler`) de cada rota que divide o contador.
 * É o oposto de createPublicRouteGuards, que dá um contador por rota.
 *
 * Usa `createRateLimit` (e não `app.rateLimit`) porque o handler do plugin marca a requisição como
 * "já limitada" num símbolo comum a todos os seus handlers, e o segundo limitador da mesma rota
 * (o teto de custo do AF-10) seria ignorado. Aqui cada limitador sempre conta.
 *
 * Com `addHeaders` (padrão), define `x-ratelimit-limit`, `x-ratelimit-remaining` e
 * `x-ratelimit-reset` como o plugin. O teto de custo passa `addHeaders: false` para não
 * sobrescrever os do contador compartilhado. `Retry-After` sai sempre no 429.
 * Sem rate limit, devolve null.
 * @param {import('fastify').FastifyInstance} app
 * @param {object} config app.config
 * @param {string} bucket chave em config.rateLimit com { perIp }
 * @param {{ addHeaders?: boolean }} [options]
 * @returns {((request, reply) => Promise<void>) | null}
 */
export function createSharedPublicLimiter(app, config, bucket, { addHeaders = true } = {}) {
  const rl = config.rateLimit;
  if (!rl.enabled) return null;
  const limits = rl[bucket];
  if (!limits) throw new Error(`Bucket de rate limit desconhecido: ${bucket}`);
  const check = app.createRateLimit({ max: limits.perIp, timeWindow: rl.timeWindow, keyGenerator: publicKeyGenerator });
  return async function sharedPublicLimiter(request, reply) {
    const result = await check(request);
    if (result.isAllowed) return;
    if (addHeaders) {
      reply.header('x-ratelimit-limit', result.max);
      reply.header('x-ratelimit-remaining', result.isExceeded ? 0 : result.remaining);
      reply.header('x-ratelimit-reset', result.ttlInSeconds);
    }
    if (!result.isExceeded) return;
    reply.header('retry-after', result.ttlInSeconds);
    throw rateLimitedError(result.ttlInSeconds);
  };
}

/**
 * Guards de rota pública com limitadores já criados (createSharedPublicLimiter). Array novo a cada
 * chamada; nulos (rate limit desligado) são ignorados. `publicRoute: true`: o auth.plugin não lê a
 * sessão.
 * @param {...(Function|null)} limiters
 * @returns {{ onRequest: Function[], config: { publicRoute: true } }}
 */
export function sharedPublicGuards(...limiters) {
  return { onRequest: limiters.filter((fn) => typeof fn === 'function'), config: { publicRoute: true } };
}
