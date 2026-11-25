import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalDiskStorage } from '../../src/storage/local-disk.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { assertValidKey, createStorage } from '../../src/storage/index.js';

const BAD_KEYS = [
  '../x.png',
  'logos/../../etc/passwd',
  'logos/a.png',
  '/abs.png',
  'logos\\x.png',
  '',
  null,
  // AF-07
  `professionals/../logos/${'0'.repeat(36)}.png`,
  `professional/${'0'.repeat(36)}.png`,
  `professionals/${'0'.repeat(36)}.jpg`,
];

async function listAll(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

describe('LocalDiskStorage (critério 13)', () => {
  let base;
  let root;
  let storage;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'af-storage-'));
    root = join(base, 'uploads');
    storage = new LocalDiskStorage({ root });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('put/get/delete e nenhum .tmp sobra', async () => {
    const key = `logos/${randomUUID()}.png`;
    await storage.put(key, Buffer.from('abc'));
    assert.deepEqual(await storage.get(key), Buffer.from('abc'));
    const files = await listAll(root);
    assert.deepEqual(files, [join(root, key)]);
    assert.equal((await stat(join(root, key))).mode & 0o777 & ~0o640, 0);

    await storage.put(key, Buffer.from('def'));
    assert.deepEqual(await storage.get(key), Buffer.from('def'));

    await storage.delete(key);
    assert.equal(await storage.get(key), null);
    await storage.delete(key); // idempotente
    assert.deepEqual(await listAll(root), []);
  });

  test('get inexistente -> null', async () => {
    assert.equal(await storage.get(`logos/${randomUUID()}.png`), null);
  });

  test('chaves inválidas lançam e nada é criado fora do root', async () => {
    for (const key of BAD_KEYS) {
      await assert.rejects(storage.put(key, Buffer.from('x')), /inválida/, String(key));
      await assert.rejects(storage.get(key), /inválida/, String(key));
      await assert.rejects(storage.delete(key), /inválida/, String(key));
    }
    assert.deepEqual(await listAll(base), []);
  });

  test('createStorage usa config.uploadsDir', async () => {
    const s = createStorage({ uploadsDir: root });
    const key = `logos/${randomUUID()}.png`;
    await s.put(key, Buffer.from('x'));
    assert.deepEqual(await listAll(root), [join(root, key)]);
  });
});

describe('createMemoryStorage', () => {
  test('put/get/delete com cópia dos bytes', async () => {
    const storage = createMemoryStorage();
    const key = `logos/${randomUUID()}.png`;
    const body = Buffer.from('abc');
    await storage.put(key, body);
    body[0] = 0;
    assert.deepEqual(await storage.get(key), Buffer.from('abc'));
    assert.deepEqual(storage.keys(), [key]);
    await storage.delete(key);
    await storage.delete(key);
    assert.equal(await storage.get(key), null);
  });

  test('mesma validação de chave', async () => {
    const storage = createMemoryStorage();
    for (const key of BAD_KEYS) {
      await assert.rejects(storage.put(key, Buffer.from('x')), /inválida/);
      assert.throws(() => assertValidKey(key), /inválida/);
    }
    assert.deepEqual(storage.keys(), []);
  });
});

describe('chaves de foto de profissional (AF-07, critério 13)', () => {
  test('professionals/<uuid>.png é aceito', async () => {
    const storage = createMemoryStorage();
    const key = `professionals/${randomUUID()}.png`;
    assert.doesNotThrow(() => assertValidKey(key));
    await storage.put(key, Buffer.from('x'));
    assert.deepEqual(storage.keys(), [key]);
  });

  test('travessia, prefixo errado e extensão errada são recusados', () => {
    const id = randomUUID();
    for (const key of [`professionals/../logos/${id}.png`, `professional/${id}.png`, `professionals/${id}.jpg`]) {
      assert.throws(() => assertValidKey(key), /inválida/, key);
    }
  });
});
