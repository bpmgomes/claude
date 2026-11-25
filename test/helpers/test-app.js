import { Writable } from 'node:stream';
import { buildApp } from '../../src/app.js';
import { createMemoryStorage } from '../../src/storage/memory.js';

/**
 * Monta um app isolado: banco :memory:, bcrypt custo 4, sem rate limit, logs capturados,
 * storage em memória e `publicBaseUrl` fixo.
 * @returns {Promise<{ app: import('fastify').FastifyInstance, logs: () => string, storage: ReturnType<typeof createMemoryStorage> }>}
 */
export async function buildTestApp(overrides = {}) {
  const chunks = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const options = {
    databasePath: ':memory:',
    bcryptCost: 4,
    cookieSecure: false,
    rateLimit: { enabled: false },
    logLevel: 'trace',
    logStream,
    publicBaseUrl: 'https://agendafacil.app',
    ...overrides,
  };
  if (!('storage' in overrides)) options.storage = createMemoryStorage();
  const app = await buildApp(options);
  return { app, logs: () => chunks.join(''), storage: options.storage };
}
