// AF-14 (design 6.1, critérios 11 e 25): varreduras de src/. Toda chamada de cancelIfConfirmed passa
// a origem do cancelamento; só enqueue-email.js enfileira, em .js e .sql (a mesma regex do teste do
// AF-18 em email-outbox.repository.test.js, de test/helpers/outbox-scan.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOX_INSERT_RE } from '../helpers/outbox-scan.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

async function sources(dir = SRC, out = [], ext = /\.js$/) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await sources(path, out, ext);
    else if (ext.test(entry.name)) out.push({ path: relative(SRC, path), text: await readFile(path, 'utf8') });
  }
  return out;
}

/** Texto dos argumentos de cada chamada `.name(` (até o parêntese que fecha). */
function callsOf(text, name) {
  const calls = [];
  const re = new RegExp(`\\.${name}\\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
    }
    calls.push(text.slice(m.index + m[0].length, i - 1));
  }
  return calls;
}

test('toda chamada de cancelIfConfirmed em src/ passa cancelledBy', async () => {
  const found = [];
  for (const { path, text } of await sources()) {
    for (const args of callsOf(text, 'cancelIfConfirmed')) found.push({ path, ok: /\bcancelledBy\s*:/.test(args) });
  }
  assert.ok(found.length >= 3, JSON.stringify(found));
  assert.deepEqual(found.filter((f) => !f.ok), []);
  const paths = new Set(found.map((f) => f.path));
  assert.ok(paths.has(join('modules', 'agenda', 'agenda.service.js')));
  assert.ok(paths.has(join('modules', 'appointments', 'manage.service.js')));
});

test('só enqueue-email.js tem INSERT INTO email_outbox nos .js e .sql de src/', async () => {
  const all = await sources(SRC, [], /\.(js|sql)$/);
  assert.ok(all.some((s) => s.path.endsWith('014_owner_cancellation.sql')), 'as migrações entram na varredura');
  const found = all.filter(({ text }) => OUTBOX_INSERT_RE.test(text)).map((s) => s.path);
  assert.deepEqual(found, [join('modules', 'email', 'enqueue-email.js')]);
});

test('a regex da varredura pega o nome com aspas e não acusa email_outbox_new', () => {
  for (const hit of [
    'INSERT INTO email_outbox (id) VALUES (?)',
    'INSERT INTO "email_outbox" (id) VALUES (?)',
    'insert into `email_outbox`(id)',
    'INSERT  INTO\n  [email_outbox] (id)',
    'INSERT INTO email_outbox\n(id)',
    "INSERT INTO 'email_outbox' (id)",
    'INSERT OR IGNORE INTO email_outbox (id)',
    'insert or replace into email_outbox(id)',
    'INSERT INTO main.email_outbox (id)',
    'INSERT INTO "main"."email_outbox" (id)',
    'REPLACE INTO email_outbox (id)',
  ]) {
    assert.match(hit, OUTBOX_INSERT_RE, hit);
  }
  for (const miss of [
    'INSERT INTO email_outbox_new (id) SELECT id FROM email_outbox',
    'INSERT INTO "email_outbox_new" (id)',
    'INSERT INTO email_outboxes (id)',
    'INSERT OR IGNORE INTO email_outbox_new (id)',
    'INSERT INTO main.email_outbox_new (id)',
    'SELECT * FROM email_outbox',
  ]) {
    assert.doesNotMatch(miss, OUTBOX_INSERT_RE, miss);
  }
});

test('o código novo do AF-14 não importa o motor de disponibilidade', async () => {
  for (const { path, text } of await sources()) {
    if (path.includes(join('modules', 'agenda')) || path.endsWith(join('shared', 'agenda.js'))) {
      assert.doesNotMatch(text, /availability-engine/, path);
    }
  }
});
