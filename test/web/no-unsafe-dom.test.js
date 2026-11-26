import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS_DIR = join(ROOT, 'web', 'js');
const FORBIDDEN = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write'];

test('web/js/*.js não usa APIs de DOM inseguras (critério 14)', async () => {
  const files = (await readdir(JS_DIR)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0);
  const offenders = [];
  for (const file of files) {
    const src = await readFile(join(JS_DIR, file), 'utf8');
    for (const word of FORBIDDEN) if (src.includes(word)) offenders.push(`${file}: ${word}`);
  }
  assert.deepEqual(offenders, []);
});

test('HTML não tem script nem estilo inline (CSP)', async () => {
  const expected = ['cadastro.html', 'onboarding.html', 'login.html', 'negocio.html', 'servicos.html', 'profissionais.html', 'horarios.html', 'bloqueios.html', 'agenda.html'];
  const all = (await readdir(join(ROOT, 'web'))).filter((f) => f.endsWith('.html'));
  for (const file of expected) assert.ok(all.includes(file), file);
  for (const file of all) {
    const html = await readFile(join(ROOT, 'web', file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${file}: script inline`);
    assert.doesNotMatch(html, /<style/, `${file}: style inline`);
    assert.doesNotMatch(html, /\sstyle=/, `${file}: atributo style`);
    assert.doesNotMatch(html, /\son[a-z]+=/, `${file}: handler inline`);
  }
});
