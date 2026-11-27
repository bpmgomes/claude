// AF-23 (design 4.4, critérios 3, 5 e 14): varredura estática permanente de fontes de fuso em web/ e
// src/. Roda no `npm test` e, portanto, no CI do AF-20 nos três TZ. Exceções explícitas: só
// src/shared/zoned-time.js (inteiro) e, fora de src/shared/, as linhas com `// utc` contadas em
// UTC_MARKED. Uma marca nova exige atualizar o mapa no mesmo PR.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIME_SOURCE_RULES, stripComments, timeSourceHits, utcMarkedLines, callArgs } from '../helpers/time-scan.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Linhas com `// utc` por arquivo (caminho relativo à raiz, com '/'). Revisado no PR. */
const UTC_MARKED = Object.freeze({
  'src/app.js': 1,
  'src/db/migrate.js': 1,
  'src/http/user-rate-limit.js': 1,
  'src/modules/accounts/accounts.service.js': 1,
  'src/modules/agenda/agenda.service.js': 1,
  'src/modules/appointments/appointments.service.js': 1,
  'src/modules/appointments/manage.service.js': 1,
  'src/modules/auth/auth.service.js': 1,
  'src/modules/auth/login-attempts.service.js': 1,
  'src/modules/auth/sessions.service.js': 1,
  'src/modules/availability/availability.service.js': 1,
  'src/modules/businesses/businesses.service.js': 1,
  'src/modules/email/email-config.js': 1,
  'src/modules/email/email-worker.js': 1,
  'src/modules/email/transports/file.js': 1,
  'src/modules/professionals/professionals.service.js': 1,
  'src/modules/public-page/public-page.service.js': 1,
  'src/modules/public-page/public-page.view.js': 1,
  'src/modules/services/services.service.js': 1,
  'src/modules/time-blocks/time-blocks.service.js': 1,
  'src/modules/working-hours/working-hours.service.js': 1,
});

const ZONED_TIME = 'src/shared/zoned-time.js';

async function filesUnder(dir, ext, out = []) {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await filesUnder(path, ext, out);
    else if (ext.test(entry.name)) out.push({ path, text: await readFile(join(ROOT, path), 'utf8') });
  }
  return out;
}

/** Conteúdo dos `<script>` sem `src` (inline). */
function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/.test(m[1])).map((m) => m[2]);
}

const fmt = (path, hits) => hits.map((h) => `${path}:${h.line} ${h.rule}`);

describe('fontes de fuso proibidas (critério 5)', () => {
  test('web/**: nenhuma ocorrência de T1 a T10, sem exceção (.js e scripts inline dos .html)', async () => {
    const files = await filesUnder('web', /\.js$/);
    assert.ok(files.length >= 20, 'a varredura enxerga web/');
    const found = files.flatMap(({ path, text }) => fmt(path, timeSourceHits(text, { web: true })));
    for (const { path, text } of await filesUnder('web', /\.html?$/)) {
      for (const script of inlineScripts(text)) found.push(...fmt(`${path} (script inline)`, timeSourceHits(script, { web: true })));
    }
    assert.deepEqual(found, []);
  });

  test('scripts inline dos .html entram na varredura', () => {
    const html = '<script type="module" src="/js/a.js"></script>\n<script>const d = new Date;</script>';
    assert.deepEqual(inlineScripts(html), ['const d = new Date;']);
    assert.deepEqual(timeSourceHits(inlineScripts(html)[0], { web: true }).map((h) => h.rule).sort(), ['T1', 'T9']);
  });

  test('src/shared: nenhuma ocorrência de T1 a T8, exceto zoned-time.js', async () => {
    const files = await filesUnder('src/shared', /\.js$/);
    assert.ok(files.some((f) => f.path === ZONED_TIME));
    const found = files.filter((f) => f.path !== ZONED_TIME).flatMap(({ path, text }) => fmt(path, timeSourceHits(text)));
    assert.deepEqual(found, []);
    // A marca `// utc` não vale em src/shared/.
    assert.deepEqual(files.filter((f) => utcMarkedLines(f.text) > 0).map((f) => f.path), []);
  });

  test('src/ fora de shared: só linhas com `// utc`, com a contagem exata de UTC_MARKED', async () => {
    const files = (await filesUnder('src', /\.js$/)).filter((f) => !f.path.startsWith('src/shared/'));
    const unmarked = [];
    const marks = {};
    for (const { path, text } of files) {
      const hits = timeSourceHits(text);
      unmarked.push(...fmt(path, hits.filter((h) => !h.marked)));
      const n = utcMarkedLines(text);
      if (n > 0) marks[path] = n;
      // Toda linha marcada tem de fato uma ocorrência (a marca não sobra numa linha sem uso).
      const hitLines = new Set(hits.map((h) => h.line));
      text.split('\n').forEach((line, k) => {
        if (/\/\/ utc\b/.test(line) && !hitLines.has(k + 1)) unmarked.push(`${path}:${k + 1} marca sem ocorrência`);
      });
    }
    assert.deepEqual(unmarked, []);
    assert.deepEqual(marks, { ...UTC_MARKED });
  });
});

describe('autoteste das regras (design 4.4)', () => {
  const rulesHit = (code, options) => timeSourceHits(code, options).map((h) => h.rule);

  test('acertos', () => {
    for (const [code, rule] of [
      ['const d = new Date( );', 'T1'],
      ['const d = new Date(\n);', 'T1'],
      ['const s = Date();', 'T2'],
      ['const t = Date.now();', 'T3'],
      ['const t = Date . now;', 'T3'],
      ['const h = d.getHours();', 'T4'],
      ['const h = d.getDate();', 'T4'],
      ['d.setMinutes(0);', 'T4'],
      ['d.getFullYear()', 'T4'],
      ['const o = d.getTimezoneOffset();', 'T5'],
      ["x.toLocaleDateString('pt-BR')", 'T6'],
      ['x.toLocaleString()', 'T6'],
      ['x.toLocaleTimeString()', 'T6'],
      ['const d = input.valueAsDate;', 'T7'],
      ["new Intl.DateTimeFormat('pt-BR', { hour: 'numeric' })", 'T8'],
      ['Intl.DateTimeFormat().resolvedOptions()', 'T8'],
      ["new Intl.DateTimeFormat('pt-BR', {\n  hour: 'numeric',\n})", 'T8'],
      // Formas equivalentes (QA, 1ª tentativa).
      ['const d = new Date;', 'T1'],
      ['const d = new Date\n;', 'T1'],
      ['const d = new globalThis.Date();', 'T1'],
      ['const d = new window.Date();', 'T1'],
      ['const d = new self.Date;', 'T1'],
      ["const d = new globalThis['Date']();", 'T1'],
      ['const s = globalThis.Date();', 'T2'],
      ["const t = Date['now']();", 'T3'],
      ['new Intl.DateTimeFormat ("pt-BR")', 'T8'],
      ['new Intl . DateTimeFormat\n("pt-BR")', 'T8'],
      ['const { DateTimeFormat: DTF } = Intl; new DTF("pt-BR", { timeZone: "UTC" });', 'T8'],
      ['Intl["DateTimeFormat"]("pt-BR", { timeZone: "UTC" })', 'T8'],
      ['Intl.DateTimeFormat.call(null, "pt-BR", { timeZone: "UTC" })', 'T8'],
      ['const F = Intl.DateTimeFormat;', 'T8'],
      ['x["toLocaleTimeString"]()', 'T6'],
      ["x['toLocaleString']()", 'T6'],
      ['Date.prototype.getHours.call(d)', 'T4'],
      ['d.getHours.call(d)', 'T4'],
      ["d['getHours']()", 'T4'],
      ['d.setDate.apply(d, [1])', 'T4'],
      ['const z = Temporal.Now.timeZoneId();', 'T10'],
      ["const d = globalThis['Temporal'].Now.plainDateISO();", 'T10'],
    ]) {
      assert.ok(rulesHit(code).includes(rule), `${rule}: ${code}`);
    }
    for (const code of ['new Date(ms)', 'Date.UTC(2026, 0, 1)', 'Date.parse(iso)', 'const D = Date;']) {
      assert.deepEqual(rulesHit(code).filter((r) => r === 'T9'), [], code);
    }
    for (const code of ['new Date(ms)', 'Date.UTC(2026, 0, 1)', 'Date.parse(iso)', 'const D = Date;', 'globalThis.Date', 'window.Date.UTC(1)', "self['Date']", 'new Date;']) {
      assert.ok(rulesHit(code, { web: true }).includes('T9'), `T9: ${code}`);
    }
    // `new Date;` também é acusado em src/ fora de shared sem a marca, e aceito só com ela.
    assert.deepEqual(timeSourceHits('const d = new Date;'), [{ rule: 'T1', line: 1, marked: false }]);
    assert.deepEqual(timeSourceHits('const d = new Date; // utc'), [{ rule: 'T1', line: 1, marked: true }]);
  });

  test('falsos positivos', () => {
    for (const code of [
      'new Date(ms)',
      'new Date(Date.UTC(2026, 0, 1))',
      'Date.UTC(2026, 0, 1)',
      'Date.parse(iso)',
      'd.getUTCDate()',
      'd.getUTCHours()',
      'parseLocalDate(text)',
      'isDate(v)',
      'isoWeekdayOfDate(date)',
      'input.valueAsDateX',
      'new Intl.DateTimeFormat(\'en-US\', { timeZone, hour: \'numeric\' })',
      'new Intl.DateTimeFormat(\'en-US\', { timeZone: tz })',
      "const url = 'http://x'; // new Date()",
      '/* new Date() */ const a = 1;',
      '/**\n * now = () => new Date()\n */',
      'const t = `a ${b} c`; // Date.now()',
      'const t = `a ${f(`x`)} c`; // Date.now()',
    ]) {
      assert.deepEqual(rulesHit(code), [], code);
    }
  });

  test('stripComments mantém strings, quebras de linha e índices', () => {
    const code = "const a = 'x // y'; // comentário\nconst b = \"/* z */\"; /* bloco\nmais */ const c = `t ${'//'} u`;";
    const out = stripComments(code);
    assert.equal(out.length, code.length);
    assert.equal(out.split('\n').length, code.split('\n').length);
    assert.ok(out.includes("'x // y'"));
    assert.ok(out.includes('"/* z */"'));
    assert.ok(!out.includes('comentário'));
    assert.ok(!out.includes('bloco'));
    assert.ok(!out.includes('mais */'));
    assert.ok(out.includes("`t ${'//'} u`"));
  });

  test('a linha de cada ocorrência vem do índice; a marca `// utc` é lida na linha crua', () => {
    const hits = timeSourceHits('const a = 1;\nconst now = () => new Date(); // utc\nconst t = Date.now();\n');
    assert.deepEqual(hits, [
      { rule: 'T1', line: 2, marked: true },
      { rule: 'T3', line: 3, marked: false },
    ]);
    assert.equal(utcMarkedLines('a // utc\nb\nc // utc\n'), 2);
  });

  test('as regras têm nome e regex global', () => {
    for (const rule of TIME_SOURCE_RULES) {
      assert.ok(rule.name && rule.re.global, rule.id);
    }
    assert.deepEqual(callArgs("x.f(a, (b)); y.f()", 'f'), ['a, (b)', '']);
  });
});

describe('texto único do fuso (critério 14)', () => {
  const NAMES_MODULE = 'src/shared/timezone-names.js';
  const LITERALS = ['Horários no fuso', 'Horário de Brasília', 'fuso do estabelecimento'];
  const PATTERNS = [/\(\$\{[^}]*\b(timezone|timeZone|tz)\b[^}]*\}\)/, /fuso\s*\$\{/];

  /** Ocorrências de montagem própria do texto do fuso (código sem comentários; HTML cru). */
  function ownAssembly(path, text) {
    const code = path.endsWith('.js') ? stripComments(text) : text;
    return [...LITERALS.filter((l) => code.includes(l)), ...PATTERNS.filter((re) => re.test(code)).map(String)].map((what) => `${path}: ${what}`);
  }

  test('nenhuma tela, e-mail ou página monta o texto do fuso fora de timezone-names.js', async () => {
    const files = [...(await filesUnder('web', /\.(js|html)$/)), ...(await filesUnder('src', /\.js$/))].filter((f) => f.path !== NAMES_MODULE);
    assert.ok(files.some((f) => f.path === 'web/agenda.html'));
    assert.deepEqual(files.flatMap(({ path, text }) => ownAssembly(path, text)), []);
  });

  test('a varredura acusa as montagens de antes do AF-23', () => {
    for (const code of [
      'const t = `Horários no fuso ${tz}.`;',
      'return `${a} – ${b} (${timezone})`;',
      'return `${a} (${text(a.timezone)})`;',
      'el.textContent = `fuso ${x}`;',
      "const s = 'Horário de Brasília';",
    ]) {
      assert.notDeepEqual(ownAssembly('x.js', code), [], code);
    }
    assert.deepEqual(ownAssembly('x.js', '// Horários no fuso, em comentário\nconst a = withTimeZone(t, tz);'), []);
  });

  test('os arquivos que mostram horário com fuso importam timezone-names.js', async () => {
    for (const path of [
      'web/js/public-booking-controller.js',
      'web/js/public-booking-page.js',
      'web/js/manage-controller.js',
      'web/js/manage-page.js',
      'web/js/agenda-page.js',
      'web/js/bloqueios-page.js',
      'web/js/horarios-page.js',
      'src/modules/public-page/public-page.render.js',
      'src/modules/email/email-messages.js',
      'src/modules/email/templates/appointment-email.js',
    ]) {
      const text = await readFile(join(ROOT, path), 'utf8');
      assert.match(text, /^import \{[^}]+\} from '[^']*\/shared\/timezone-names\.js';$/m, path);
    }
  });
});
