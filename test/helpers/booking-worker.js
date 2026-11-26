// Processo filho do teste de concorrência entre processos (AF-11, critério 19): sobe o app sobre
// o arquivo SQLite recebido em argv[2], com relógio fixo (argv[3]), escuta em 127.0.0.1 numa porta
// livre e informa a porta ao pai por IPC. Encerra quando o pai manda 'stop' ou desconecta.
import { buildApp } from '../../src/app.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { TEST_CONFLICTS_TOKEN_SECRET } from './test-app.js';

const [databasePath, nowIso] = process.argv.slice(2);
const at = Date.parse(nowIso);

const app = await buildApp({
  databasePath,
  bcryptCost: 4,
  cookieSecure: false,
  rateLimit: { enabled: false },
  logLevel: 'silent',
  publicBaseUrl: 'https://agendafacil.app',
  conflictsTokenSecret: TEST_CONFLICTS_TOKEN_SECRET,
  storage: createMemoryStorage(),
  now: () => new Date(at),
});
await app.listen({ host: '127.0.0.1', port: 0 });

async function stop() {
  await app.close();
  process.exit(0);
}
process.on('message', (msg) => {
  if (msg === 'stop') stop();
});
process.on('disconnect', stop);
process.send({ port: app.server.address().port });
