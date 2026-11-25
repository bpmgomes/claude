import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { assertValidKey } from './index.js';

/**
 * Storage em disco local (implementa `Storage`, ver ./index.js).
 * - a chave precisa casar STORAGE_KEY_RE e o caminho final precisa ficar dentro de `root`;
 * - `put` grava num arquivo temporário e faz rename (atômico), com modo 0o640.
 */
export class LocalDiskStorage {
  /** @param {{ root: string }} options */
  constructor({ root }) {
    this.root = resolve(root);
  }

  #pathOf(key) {
    assertValidKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Chave de armazenamento inválida.');
    return full;
  }

  async put(key, body) {
    const target = this.#pathOf(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, body, { mode: 0o640, flag: 'wx' });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key) {
    const target = this.#pathOf(key);
    try {
      return await readFile(target);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key) {
    await rm(this.#pathOf(key), { force: true });
  }
}
