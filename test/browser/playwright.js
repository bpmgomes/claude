// Playwright fica fora do package.json (design AF-09, decisão 1 e R1): carregado do ambiente.
import { createRequire } from 'node:module';

const MISSING =
  'Playwright não encontrado: instale o pacote e o Chromium (npx playwright install chromium).';

/** @returns {typeof import('playwright')} */
export function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch (err) {
    throw new Error(MISSING, { cause: err });
  }
}
