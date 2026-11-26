// Servidor real (HTTP em 127.0.0.1) para os scripts de navegador (perf e E2E) do AF-09.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.js';
import { createMemoryStorage } from '../../src/storage/memory.js';

/**
 * Sobe o app com banco em diretório temporário, storage em memória, cookie sem Secure e rate
 * limit LIGADO com os padrões. `seed(app)` roda antes do listen (via inject).
 * @template T
 * @param {{ seed?: (app: import('fastify').FastifyInstance) => Promise<T>, overrides?: object }} [options]
 * @returns {Promise<{ app: import('fastify').FastifyInstance, baseUrl: string, data: T, close: () => Promise<void> }>}
 */
export async function startServer({ seed, overrides = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agendafacil-browser-'));
  const app = await buildApp({
    databasePath: join(dir, 'db.sqlite'),
    storage: createMemoryStorage(),
    cookieSecure: false,
    bcryptCost: 4,
    logLevel: 'warn',
    publicBaseUrl: 'http://127.0.0.1',
    ...overrides,
  });
  let data;
  try {
    data = seed ? await seed(app) : undefined;
    await app.listen({ host: '127.0.0.1', port: 0 });
  } catch (err) {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const { port } = app.server.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    data,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
