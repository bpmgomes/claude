import { assertValidKey } from './index.js';

/**
 * Storage em memória (testes). Mesma validação de chave do disco.
 * @returns {import('./index.js').Storage & { keys: () => string[] }}
 */
export function createMemoryStorage() {
  const files = new Map();
  return {
    async put(key, body) {
      assertValidKey(key);
      files.set(key, Buffer.from(body));
    },
    async get(key) {
      assertValidKey(key);
      const body = files.get(key);
      return body ? Buffer.from(body) : null;
    },
    async delete(key) {
      assertValidKey(key);
      files.delete(key);
    },
    /** Chaves gravadas (só para inspeção nos testes). */
    keys() {
      return [...files.keys()];
    },
  };
}
