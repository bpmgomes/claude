// Adaptador de arquivo (AF-18, design 4.3, critério 23): SÓ desenvolvimento e teste (o boot recusa
// outro ambiente). Grava cada mensagem como `.eml` num diretório fora do que o servidor web expõe
// (padrão `data/emails`, ignorado pelo git). O diretório tem DADO PESSOAL em claro (endereço, nome,
// link de gerenciar): modo 0o700, arquivos 0o600, e os `.eml` com mais de 30 dias saem no boot.
import { mkdir, writeFile, readdir, stat, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { composeMime } from '../mime.js';
import { EMAIL_RETENTION_DAYS } from '../email-rules.js';

const DAY_MS = 86_400_000;

/** Nome do arquivo a partir do Message-ID, só com caracteres seguros. */
export function emlFileNameOf(messageId) {
  return `${String(messageId).replace(/^<|>$/g, '').replace(/[^A-Za-z0-9@._-]/g, '_')}.eml`;
}

/**
 * @param {{ dir: string, now?: () => Date }} options
 */
export function createFileMailTransport({ dir, now = () => new Date() }) { // utc
  let ready = null;

  async function ensureDir() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
  }

  return {
    dir,

    /** Boot: cria o diretório e apaga `.eml` com mais de 30 dias (melhor esforço; nunca lança). */
    async init() {
      try {
        await ensureDir();
        const cutoff = now().getTime() - EMAIL_RETENTION_DAYS * DAY_MS;
        let removed = 0;
        for (const name of await readdir(dir)) {
          if (!name.endsWith('.eml')) continue;
          const path = join(dir, name);
          const info = await stat(path).catch(() => null);
          if (info && info.isFile() && info.mtimeMs < cutoff) {
            await unlink(path).catch(() => {});
            removed += 1;
          }
        }
        return removed;
      } catch {
        return 0;
      }
    },

    async send(message) {
      if (!ready) ready = ensureDir();
      await ready;
      const raw = await composeMime(message);
      await writeFile(join(dir, emlFileNameOf(message.messageId)), raw, { mode: 0o600 });
      return { messageId: message.messageId };
    },

    async close() {},
  };
}
