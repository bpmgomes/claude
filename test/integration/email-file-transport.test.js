// AF-18 (critérios 23 e 25): adaptador de arquivo (.eml, só dev/test) e a regra de EMAIL_FILE_DIR.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileMailTransport, emlFileNameOf } from '../../src/modules/email/transports/file.js';
import { resolveEmailConfig, isAllowedFileDir, REPO_ROOT } from '../../src/modules/email/email-config.js';
import { loadConfig } from '../../src/config.js';
import { buildMailMessage, messageIdOf } from '../../src/modules/email/message.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const message = () =>
  buildMailMessage({
    rendered: { subject: 'Assunto', text: 'Olá', html: '<p>Olá</p>', ics: { content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', method: 'PUBLISH' } },
    to: 'ana@example.com',
    from: { name: 'AgendaFácil', address: 'nao-responda@agendafacil.invalid' },
    messageId: messageIdOf(ID, 'agendafacil.invalid'),
    date: new Date('2026-11-26T12:00:00.000Z'),
  });

describe('createFileMailTransport', () => {
  test('grava <messageId>.eml com modo 0o600 em diretório 0o700', async () => {
    const root = await mkdtemp(join(tmpdir(), 'af18-eml-'));
    const dir = join(root, 'emails');
    try {
      const t = createFileMailTransport({ dir });
      const res = await t.send(message());
      assert.equal(res.messageId, `<${ID}@agendafacil.invalid>`);
      const files = await readdir(dir);
      assert.deepEqual(files, [emlFileNameOf(res.messageId)]);
      assert.equal(files[0], `${ID}@agendafacil.invalid.eml`);
      const raw = await readFile(join(dir, files[0]), 'utf8');
      assert.match(raw, /^Auto-Submitted: auto-generated\r\n/m);
      if (process.platform !== 'win32') {
        assert.equal((await stat(dir)).mode & 0o777, 0o700);
        assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('init apaga .eml com mais de 30 dias e mantém os recentes e outros arquivos', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af18-eml-'));
    const now = Date.parse('2026-11-26T12:00:00.000Z');
    try {
      for (const [name, ageDays] of [['velho.eml', 31], ['novo.eml', 29], ['nota.txt', 90]]) {
        const path = join(dir, name);
        await writeFile(path, 'x');
        const t = new Date(now - ageDays * 86_400_000);
        await utimes(path, t, t);
      }
      const removed = await createFileMailTransport({ dir, now: () => new Date(now) }).init();
      assert.equal(removed, 1);
      assert.deepEqual((await readdir(dir)).sort(), ['nota.txt', 'novo.eml']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('emlFileNameOf só com caracteres seguros', () => {
    assert.equal(emlFileNameOf('<a/../b c@x>'), 'a_.._b_c@x.eml');
  });
});

describe('EMAIL_FILE_DIR (critério 25)', () => {
  const resolveFor = (dir) => resolveEmailConfig(loadConfig({ NODE_ENV: 'development', EMAIL_TRANSPORT: 'file', EMAIL_FILE_DIR: dir }));

  test('recusa web/, src/ e a raiz do repositório; aceita data/emails e fora do repositório', () => {
    for (const dir of [join(REPO_ROOT, 'web'), join(REPO_ROOT, 'src'), REPO_ROOT, join(REPO_ROOT, 'test', 'x'), join(REPO_ROOT, 'database')]) {
      assert.throws(() => resolveFor(dir), /EMAIL_FILE_DIR precisa ficar fora do repositório ou dentro de data\//, dir);
      assert.equal(isAllowedFileDir(dir), false, dir);
    }
    assert.equal(resolveFor(join(REPO_ROOT, 'data', 'emails')).fileDir, join(REPO_ROOT, 'data', 'emails'));
    assert.equal(resolveFor(join(tmpdir(), 'af18-fora')).transport, 'file');
    assert.equal(isAllowedFileDir(join(REPO_ROOT, 'data')), true);
    assert.equal(isAllowedFileDir(join(REPO_ROOT, '..', 'outro')), true);
  });
});

describe('EMAIL_FILE_DIR: UPLOADS_DIR e caminho real (I1)', () => {
  test('recusa UPLOADS_DIR e subpastas dele, dentro e fora do repositório', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'af18-up-'));
    try {
      const uploadsDir = join(outside, 'uploads');
      assert.equal(isAllowedFileDir(uploadsDir, { uploadsDir }), false);
      assert.equal(isAllowedFileDir(join(uploadsDir, 'logos'), { uploadsDir }), false);
      assert.equal(isAllowedFileDir(join(uploadsDir, 'emails', 'x'), { uploadsDir }), false);
      assert.equal(isAllowedFileDir(join(outside, 'emails'), { uploadsDir }), true);
      assert.equal(isAllowedFileDir(join(outside, 'uploads-emails'), { uploadsDir }), true, 'prefixo de nome não é subpasta');
      const inRepo = join(REPO_ROOT, 'data', 'uploads');
      assert.equal(isAllowedFileDir(join(inRepo, 'emails'), { uploadsDir: inRepo }), false);
      assert.equal(isAllowedFileDir(join(REPO_ROOT, 'data', 'emails'), { uploadsDir: inRepo }), true);
      // Pelo boot: UPLOADS_DIR vem da configuração.
      const cfg = (dir, up) => resolveEmailConfig(loadConfig({ NODE_ENV: 'development', EMAIL_TRANSPORT: 'file', EMAIL_FILE_DIR: dir, UPLOADS_DIR: up }));
      assert.throws(() => cfg(join(uploadsDir, 'emails'), uploadsDir), /fora de UPLOADS_DIR/);
      assert.equal(cfg(join(outside, 'emails'), uploadsDir).transport, 'file');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('link simbólico fora do repositório que aponta para web/ ou para UPLOADS_DIR é recusado', { skip: process.platform === 'win32' }, async () => {
    const { symlink } = await import('node:fs/promises');
    const outside = await mkdtemp(join(tmpdir(), 'af18-ln-'));
    try {
      const toWeb = join(outside, 'para-web');
      await symlink(join(REPO_ROOT, 'web'), toWeb);
      assert.equal(isAllowedFileDir(toWeb), false);
      assert.equal(isAllowedFileDir(join(toWeb, 'emails')), false, 'subpasta ainda inexistente sob o link');
      const uploadsDir = join(outside, 'uploads');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(uploadsDir);
      const toUploads = join(outside, 'para-uploads');
      await symlink(uploadsDir, toUploads);
      assert.equal(isAllowedFileDir(toUploads, { uploadsDir }), false);
      assert.equal(isAllowedFileDir(join(outside, 'emails-de-verdade')), true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
