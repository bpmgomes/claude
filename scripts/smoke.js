// AF-20 (critério 8, design 5): "build-check" do projeto. Migra um banco temporário, sobe
// `node src/server.js` com configuração de produção e confere que a aplicação responde.
// Uso: `npm run smoke`. `CONFLICTS_TOKEN_SECRET` definido no ambiente é repassado como veio (mesmo
// curto ou vazio); ausente, o script gera um de uso único. `COOKIE_SECURE` também só é repassado se
// vier definido (no CI não vem, então vale o padrão de produção); assim os controles do design 6.2
// (a5 e a6) provam que uma configuração de produção inválida não sobe.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const STAY_ALIVE_MS = 500;
const STOP_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Sobe a aplicação como em produção e confere que ela responde (AF-20, critério 8).
 * @param {{ env?: NodeJS.ProcessEnv, bootTimeoutMs?: number, log?: (msg: string) => void }} [options]
 * @returns {Promise<void>} resolve se tudo passou; rejeita com Error cuja mensagem nunca contém segredos
 */
export async function runSmoke(options = {}) {
  const { env: baseEnv = process.env, bootTimeoutMs = 30_000, log = (msg) => console.log(msg) } = options;
  const dir = await mkdtemp(join(tmpdir(), 'agendafacil-smoke-'));
  let child = null;
  try {
    const port = await freePort();
    const env = childEnv(baseEnv, { dir, port });

    log('smoke: migrando banco temporário');
    const migrate = spawn(process.execPath, ['src/db/migrate.js'], { cwd: ROOT, env, stdio: 'inherit' });
    const migrateCode = await waitExit(migrate, MIGRATE_TIMEOUT_MS);
    if (migrateCode === null) {
      migrate.kill('SIGKILL');
      throw new Error(`migração não terminou em ${MIGRATE_TIMEOUT_MS} ms`);
    }
    if (migrateCode !== 0) throw new Error(`migração falhou (código ${migrateCode})`);

    log(`smoke: subindo o servidor na porta ${port}`);
    child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: 'inherit' });
    const base = `http://127.0.0.1:${port}`;
    const notFound = await waitForBoot(child, `${base}/api/nao-existe`, bootTimeoutMs);
    await assertNotFoundJson(notFound);
    await assertLoginPage(await fetchWithTimeout(`${base}/login`));

    await delay(STAY_ALIVE_MS);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`servidor encerrou depois de responder (código ${child.exitCode ?? child.signalCode})`);
    }

    child.kill('SIGTERM');
    const stopCode = await waitExit(child, STOP_TIMEOUT_MS);
    if (stopCode === null) {
      child.kill('SIGKILL');
      throw new Error(`servidor não encerrou em ${STOP_TIMEOUT_MS} ms após SIGTERM`);
    }
    if (stopCode !== 0) throw new Error(`servidor encerrou com código ${stopCode} após SIGTERM`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Ambiente do servidor: produção, caminhos temporários e porta livre. `COOKIE_SECURE` e
 * `CONFLICTS_TOKEN_SECRET` vêm do ambiente como estão; sem segredo, gera um de uso único.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {{ dir: string, port: number }} opts
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(baseEnv, { dir, port }) {
  const env = { ...baseEnv };
  env.NODE_ENV = 'production';
  env.PORT = String(port);
  env.PUBLIC_BASE_URL = baseEnv.PUBLIC_BASE_URL || 'https://smoke.invalid';
  env.DATABASE_PATH = join(dir, 'db.sqlite');
  env.UPLOADS_DIR = join(dir, 'uploads');
  if (!('CONFLICTS_TOKEN_SECRET' in baseEnv)) env.CONFLICTS_TOKEN_SECRET = randomBytes(32).toString('base64');
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Resolve com o código de saída (ou o sinal), ou `null` se não sair dentro do prazo. */
function waitExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(proc.exitCode ?? proc.signalCode);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? signal);
    });
  });
}

async function waitForBoot(proc, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`servidor encerrou durante a subida (código ${proc.exitCode ?? proc.signalCode})`);
    }
    try {
      return await fetchWithTimeout(url);
    } catch (err) {
      if (!isConnRefused(err)) throw new Error(`falha ao consultar ${url}: ${err.message}`);
    }
    if (Date.now() >= deadline) throw new Error(`servidor não respondeu em ${timeoutMs} ms`);
    await delay(POLL_INTERVAL_MS);
  }
}

function isConnRefused(err) {
  return err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED';
}

function fetchWithTimeout(url) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function assertNotFoundJson(res) {
  if (res.status !== 404) throw new Error(`GET /api/nao-existe: status ${res.status}, esperado 404`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('application/json')) {
    throw new Error(`GET /api/nao-existe: content-type "${type}", esperado application/json`);
  }
  const cache = res.headers.get('cache-control') || '';
  if (cache !== 'no-store') throw new Error(`GET /api/nao-existe: cache-control "${cache}", esperado no-store`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('GET /api/nao-existe: corpo não é JSON válido');
  }
  if (body?.error?.code !== 'NOT_FOUND') {
    throw new Error(`GET /api/nao-existe: error.code ${JSON.stringify(body?.error?.code)}, esperado "NOT_FOUND"`);
  }
}

async function assertLoginPage(res) {
  if (res.status !== 200) throw new Error(`GET /login: status ${res.status}, esperado 200`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('text/html')) throw new Error(`GET /login: content-type "${type}", esperado text/html`);
  await res.arrayBuffer();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CLI: npm run smoke
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = Date.now();
  try {
    await runSmoke();
    console.log(`smoke: ok (${Date.now() - started} ms)`);
  } catch (err) {
    console.error(`smoke: FALHOU: ${err.message}`);
    process.exitCode = 1;
  }
}
