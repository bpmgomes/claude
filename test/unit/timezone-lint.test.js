// AF-23 (critério 5, decisão do Gerente após o QA): a camada de AST do ESLint (eslint.config.js) pega
// cada forma equivalente de relógio ou fuso local em web/** e src/shared/** (exceto zoned-time.js).
// Roda o ESLint pela API programática sobre arquivos sintéticos (nada é gravado em disco).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESTRICTED = new Set(['no-restricted-syntax', 'no-restricted-globals', 'no-restricted-properties']);
const eslint = new ESLint({ cwd: ROOT });

async function restrictedHits(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${filePath}` });
  return result.messages.filter((m) => RESTRICTED.has(m.ruleId));
}

const FORMS = [
  'const d = new Date;',
  'const d = new Date();',
  'const d = new Date(0);',
  'const s = Date();',
  'const t = Date.now();',
  'const p = Date.parse("2026-01-01T00:00:00Z");',
  'const d = new globalThis.Date();',
  'const d = new window.Date();',
  'const d = new self.Date();',
  "const d = new globalThis['Date']();",
  'const D = globalThis.Date;',
  'new Intl.DateTimeFormat ("pt-BR");',
  'new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });',
  'const { DateTimeFormat: DTF } = Intl; new DTF("pt-BR");',
  'Intl["DateTimeFormat"]("pt-BR");',
  'Intl[`DateTimeFormat`]("pt-BR");',
  'Intl.DateTimeFormat.call(null, "pt-BR");',
  'Reflect.get(Intl, "DateTimeFormat");',
  'export const f = (x) => x["toLocaleTimeString"]();',
  'export const f = (x) => x.toLocaleString();',
  'export const f = (x) => x.toLocaleDateString("pt-BR");',
  'export const f = (d) => Date.prototype.getHours.call(d);',
  'export const f = (d) => d.getHours.call(d);',
  'export const f = (d) => d.getHours();',
  'export const f = (d) => d["getDate"]();',
  'export const f = (d) => d.setMinutes(0);',
  'export const f = (d) => d.getTimezoneOffset();',
  'export const f = (input) => input.valueAsDate;',
  'export const z = Temporal.Now.timeZoneId();',
  'export const d = globalThis.Temporal.Now.plainDateISO();',
  "export const d = window['Temporal'];",
];

describe('ESLint: formas equivalentes de relógio e fuso local (critério 5)', () => {
  for (const path of ['web/js/__af23-sintetico__.js', 'web/outro/__af23-sintetico__.js', 'src/shared/__af23-sintetico__.js']) {
    test(`${path}: o lint pega cada forma`, async () => {
      const missed = [];
      for (const code of FORMS) {
        if ((await restrictedHits(code, path)).length === 0) missed.push(code);
      }
      assert.deepEqual(missed, []);
    });
  }

  test('código limpo não é acusado', async () => {
    const clean = [
      "import { parseLocalDate, addLocalDays, instantToLocal } from '/shared/zoned-time.js';",
      "export const a = addLocalDays('2026-11-26', 1);",
      "export const b = parseLocalDate('2026-11-26').ok;",
      "export const c = instantToLocal(0, 'America/Sao_Paulo');",
      "export const fullDate = (x) => `${x.slice(8, 10)}/${x.slice(5, 7)}`;",
      'export const n = new Intl.NumberFormat("pt-BR");',
    ].join('\n');
    assert.deepEqual(await restrictedHits(clean, 'web/js/__af23-limpo__.js'), []);
  });

  test('zoned-time.js e src/ fora de shared ficam fora desta camada (lá vale a marca // utc)', async () => {
    assert.deepEqual(await restrictedHits('export const iso = (ms) => new Date(ms).toISOString();', 'src/shared/zoned-time.js'), []);
    assert.deepEqual(await restrictedHits('export const now = () => new Date(); // utc', 'src/modules/__af23-sintetico__.js'), []);
  });

  test('o repositório inteiro passa nesta camada', async () => {
    const results = await eslint.lintFiles(['web/**/*.js', 'src/shared/**/*.js']);
    const hits = results.flatMap((r) => r.messages.filter((m) => RESTRICTED.has(m.ruleId)).map((m) => `${r.filePath}:${m.line}`));
    assert.deepEqual(hits, []);
    assert.ok(results.length >= 30, `${results.length} arquivos`);
  });
});
