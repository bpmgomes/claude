import { Writable } from 'node:stream';
import { buildApp } from '../../src/app.js';

/**
 * Monta um app isolado: banco :memory:, bcrypt custo 4, sem rate limit e logs capturados.
 * @returns {Promise<{ app: import('fastify').FastifyInstance, logs: () => string }>}
 */
export async function buildTestApp(overrides = {}) {
  const chunks = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const app = await buildApp({
    databasePath: ':memory:',
    bcryptCost: 4,
    cookieSecure: false,
    rateLimit: { enabled: false },
    logLevel: 'trace',
    logStream,
    ...overrides,
  });
  return { app, logs: () => chunks.join('') };
}
