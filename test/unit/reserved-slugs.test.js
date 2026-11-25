import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_SLUGS } from '../../src/shared/slug.js';
import { PAGES } from '../../src/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('todo diretório e todo .html de web/ estão em RESERVED_SLUGS (critério 19)', async () => {
  const entries = await readdir(join(ROOT, 'web'), { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory() || e.name.endsWith('.html'))
    .map((e) => e.name.replace(/\.html$/, ''));
  assert.ok(names.length > 0);
  const missing = names.filter((n) => !RESERVED_SLUGS.has(n));
  assert.deepEqual(missing, []);
});

test('prefixos do app (shared, media, api) e páginas registradas estão em RESERVED_SLUGS', () => {
  const pages = Object.keys(PAGES).map((p) => p.slice(1));
  for (const expected of ['login', 'cadastro', 'onboarding', 'negocio', 'servicos']) {
    assert.ok(pages.includes(expected), expected);
  }
  const missing = ['shared', 'media', 'api', ...pages].filter((n) => !RESERVED_SLUGS.has(n));
  assert.deepEqual(missing, []);
});
