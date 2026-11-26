// AF-20 (critério 8, design 5): o smoke sobe `src/server.js` como em produção e falha quando a
// configuração de produção é inválida, sem ecoar segredos.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../../scripts/smoke.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOOD_SECRET = 'a'.repeat(44);

/** Roda a CLI do smoke com o ambiente dado e devolve código de saída e saída combinada. */
function runCli(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['scripts/smoke.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', (chunk) => { output += chunk; });
    proc.stderr.on('data', (chunk) => { output += chunk; });
    proc.once('error', reject);
    proc.once('exit', (code) => resolve({ code, output }));
  });
}

function baseEnv(extra = {}) {
  const env = { ...process.env, LOG_LEVEL: 'warn', ...extra };
  for (const key of Object.keys(extra)) if (extra[key] === undefined) delete env[key];
  return env;
}

describe('childEnv', () => {
  const opts = { dir: '/tmp/x', port: 4321 };

  test('força produção, porta e caminhos temporários', () => {
    const env = childEnv({ NODE_ENV: 'test', PORT: '3000', DATABASE_PATH: './data/db' }, opts);
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.PORT, '4321');
    assert.equal(env.DATABASE_PATH, join('/tmp/x', 'db.sqlite'));
    assert.equal(env.UPLOADS_DIR, join('/tmp/x', 'uploads'));
    assert.equal(env.PUBLIC_BASE_URL, 'https://smoke.invalid');
  });

  test('mantém PUBLIC_BASE_URL do ambiente', () => {
    assert.equal(childEnv({ PUBLIC_BASE_URL: 'https://x.example' }, opts).PUBLIC_BASE_URL, 'https://x.example');
  });

  test('gera um segredo de 44 caracteres quando ausente, novo a cada chamada', () => {
    const a = childEnv({}, opts).CONFLICTS_TOKEN_SECRET;
    const b = childEnv({}, opts).CONFLICTS_TOKEN_SECRET;
    assert.equal(a.length, 44);
    assert.notEqual(a, b);
  });

  test('repassa o segredo definido como veio, mesmo curto ou vazio', () => {
    assert.equal(childEnv({ CONFLICTS_TOKEN_SECRET: 'curto' }, opts).CONFLICTS_TOKEN_SECRET, 'curto');
    assert.equal(childEnv({ CONFLICTS_TOKEN_SECRET: '' }, opts).CONFLICTS_TOKEN_SECRET, '');
  });

  test('não define COOKIE_SECURE quando ausente e não altera o objeto de entrada', () => {
    const input = Object.freeze({ NODE_ENV: 'development' });
    const env = childEnv(input, opts);
    assert.equal('COOKIE_SECURE' in env, false);
    assert.equal(input.NODE_ENV, 'development');
  });
});

describe('CLI npm run smoke', () => {
  test('sobe, responde e encerra com 0', async () => {
    const { code, output } = await runCli(baseEnv({ CONFLICTS_TOKEN_SECRET: GOOD_SECRET, COOKIE_SECURE: undefined }));
    assert.equal(code, 0, output);
    assert.match(output, /smoke: ok \(\d+ ms\)/);
    assert.equal(output.includes(GOOD_SECRET), false);
  });

  test('sem CONFLICTS_TOKEN_SECRET no ambiente, gera um e sobe', async () => {
    const { code, output } = await runCli(baseEnv({ CONFLICTS_TOKEN_SECRET: undefined, COOKIE_SECURE: undefined }));
    assert.equal(code, 0, output);
  });

  test('segredo curto: falha na subida sem ecoar o valor', async () => {
    const secret = 'curto-xyz';
    const { code, output } = await runCli(baseEnv({ CONFLICTS_TOKEN_SECRET: secret, COOKIE_SECURE: undefined }));
    assert.equal(code, 1, output);
    assert.match(output, /smoke: FALHOU: servidor encerrou durante a subida/);
    assert.match(output, /pelo menos 32 caracteres/);
    assert.equal(output.includes(secret), false);
  });

  test('segredo vazio em produção: falha', async () => {
    const { code, output } = await runCli(baseEnv({ CONFLICTS_TOKEN_SECRET: '', COOKIE_SECURE: undefined }));
    assert.equal(code, 1, output);
    assert.match(output, /obrigatório fora de development e test/);
  });

  test('COOKIE_SECURE=false em produção: falha', async () => {
    const { code, output } = await runCli(baseEnv({ CONFLICTS_TOKEN_SECRET: GOOD_SECRET, COOKIE_SECURE: 'false' }));
    assert.equal(code, 1, output);
    assert.match(output, /smoke: FALHOU/);
    assert.match(output, /COOKIE_SECURE=false/);
  });
});
