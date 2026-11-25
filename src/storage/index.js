import { LocalDiskStorage } from './local-disk.js';

/**
 * Interface de armazenamento de arquivos (independente do backend).
 *
 * @typedef {Object} Storage
 * @property {(key: string, body: Buffer) => Promise<void>} put      // sobrescreve se existir
 * @property {(key: string) => Promise<Buffer|null>} get              // null se não existir
 * @property {(key: string) => Promise<void>} delete                  // idempotente
 */

/** Únicas chaves aceitas: geradas pelo servidor (`logos/<uuid>.png`). */
export const STORAGE_KEY_RE = /^logos\/[0-9a-f-]{36}\.png$/;

/**
 * Defesa em profundidade: o serviço só gera chaves válidas, mas o adapter recusa qualquer outra.
 * @param {unknown} key
 * @throws {Error}
 */
export function assertValidKey(key) {
  if (typeof key !== 'string' || !STORAGE_KEY_RE.test(key)) {
    throw new Error('Chave de armazenamento inválida.');
  }
}

/**
 * @param {{ uploadsDir: string }} config
 * @returns {Storage}
 */
export function createStorage(config) {
  return new LocalDiskStorage({ root: config.uploadsDir });
}
