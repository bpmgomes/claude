// Mapeia o import absoluto do browser `/shared/...` para `src/shared/...`,
// permitindo testar os módulos de web/js no Node sem alterar o código do front.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'shared');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/shared/')) {
      const url = pathToFileURL(join(SHARED_DIR, specifier.slice('/shared/'.length))).href;
      return nextResolve(url, context);
    }
    return nextResolve(specifier, context);
  },
});
