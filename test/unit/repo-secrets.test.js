// AF-18 (critério 24): nenhuma credencial no repositório; .env.example só com nomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'data', '.git']);
// Montado por partes para este arquivo não casar com o próprio padrão.
const ASSIGNMENT_RE = new RegExp(`${'SMTP_'}PASSWORD=[^\\s'"\`)\\]|,;]`);
const TEXT_EXT = /\.(js|mjs|cjs|json|md|yml|yaml|html|css|sql|txt|example|svg|pem)$|^\.env/;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && TEXT_EXT.test(entry.name)) yield path;
  }
}

async function repoFiles() {
  const out = [];
  for await (const f of walk(ROOT)) if ((await stat(f)).size < 2_000_000) out.push(f);
  return out;
}

test('.env.example: só NOME=, sem valor', async () => {
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /^[A-Z][A-Z0-9_]*=$/, line);
  for (const name of ['EMAIL_TRANSPORT', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD']) {
    assert.ok(lines.includes(`${name}=`), name);
  }
});

test('nenhum arquivo do repositório tem SMTP_PASSWORD= seguido de valor', async () => {
  // O padrão pega uma atribuição real e ignora o nome sozinho.
  assert.equal(ASSIGNMENT_RE.test(`${'SMTP_'}PASSWORD=hunter2`), true);
  assert.equal(ASSIGNMENT_RE.test(`${'SMTP_'}PASSWORD=\n`), false);
  const offenders = [];
  for (const file of await repoFiles()) {
    const text = await readFile(file, 'utf8');
    // Atribuição de ambiente: NOME=valor, sem espaço (`SMTP_PASSWORD=` sozinho ou em código/texto não conta).
    if (ASSIGNMENT_RE.test(text)) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

test('com SMTP_PASSWORD no ambiente, nenhum arquivo contém o valor', async (t) => {
  const value = process.env.SMTP_PASSWORD;
  if (!value || value.length < 6) return t.skip('SMTP_PASSWORD ausente no ambiente');
  for (const file of await repoFiles()) {
    assert.equal((await readFile(file, 'utf8')).includes(value), false, relative(ROOT, file));
  }
});
