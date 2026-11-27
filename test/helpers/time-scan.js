// Regras da varredura estática de fuso do AF-23 (design 4.4, critério 5), usadas por
// test/unit/timezone-scan.test.js. Também guarda `callArgs` (antes `callsOf` em source-scan.test.js).

/** Marca, na linha crua, de uma marca de tempo de infraestrutura em UTC. */
export const UTC_MARKER = '// utc';
export const UTC_MARKER_RE = /\/\/ utc\b/;

/** Prefixo opcional do objeto global: `globalThis.`, `window.`, `self.` ou `globalThis['`. */
const GLOBAL = String.raw`(?:(?:globalThis|window|self)\s*(?:\.\s*|\[\s*['"\x60]))?`;
/** Acesso a membro por ponto ou por string computada: `.nome` ou `['nome'`. */
const MEMBER = String.raw`(?:\.\s*|\[\s*['"\x60])`;
const LOCAL_ACCESSORS = '(?:get|set)(?:FullYear|Year|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)';

/**
 * Regras sobre o texto SEM comentários (formas equivalentes incluídas: sem parênteses, via objeto
 * global, membro computado, `.call`/`.apply`). T9 vale só para `web/`. T8 é tratada à parte.
 * @type {ReadonlyArray<{ id: string, name: string, re: RegExp, webOnly?: boolean }>}
 */
export const TIME_SOURCE_RULES = Object.freeze([
  // `new Date`, `new Date()`, `new globalThis.Date()`; não acusa `new Date(ms)`.
  { id: 'T1', name: 'new Date sem argumento', re: new RegExp(String.raw`\bnew\s+${GLOBAL}Date\b(?:['"\x60]\s*\])?(?!\s*\(\s*[^\s)])`, 'g') },
  { id: 'T2', name: 'Date() como função', re: new RegExp(String.raw`(?<!new\s+)(?<![.\w$])${GLOBAL}Date(?:['"\x60]\s*\])?\s*\(`, 'g') },
  { id: 'T3', name: 'Date.now', re: new RegExp(String.raw`\bDate\s*${MEMBER}now\b`, 'g') },
  // Qualquer referência: chamada, `.call`, `Date.prototype.getHours`, `d['getHours']`.
  { id: 'T4', name: 'getters e setters locais', re: new RegExp(String.raw`${MEMBER}${LOCAL_ACCESSORS}\b`, 'g') },
  { id: 'T5', name: 'getTimezoneOffset', re: /\bgetTimezoneOffset\b/g },
  { id: 'T6', name: 'toLocale*', re: /\btoLocale(?:String|DateString|TimeString)\b/g },
  { id: 'T7', name: 'valueAsDate', re: /\bvalueAsDate\b/g },
  // Qualquer referência ao global Date em web/ (também `globalThis.Date`, `new Date`, `x['Date']`).
  { id: 'T9', name: 'qualquer Date em web/', re: /(?<![\w$])Date(?![\w$])/g, webOnly: true },
  // Temporal.Now dá o relógio e o fuso local (QA, 2ª tentativa). Nenhum uso no projeto.
  { id: 'T10', name: 'Temporal', re: /(?<![\w$])Temporal(?![\w$])/g },
].map((r) => Object.freeze(r)));

/**
 * T8: `DateTimeFormat` só é aceito como chamada direta `Intl.DateTimeFormat(…)` (com ou sem `new` e
 * espaços) cujos argumentos tenham `timeZone:` ou a forma curta `{ timeZone, … }`. Qualquer outro
 * acesso (`Intl['DateTimeFormat']`, `.call`, desestruturação, `const F = Intl.DateTimeFormat`) é
 * acusado.
 */
export const T8 = Object.freeze({ id: 'T8', name: 'Intl.DateTimeFormat sem timeZone', has: /\btimeZone\s*[:,}]/ });

/**
 * Troca comentários (`//…` e `/*…*\/`) fora de strings por espaços, mantendo as quebras de linha (os
 * índices e as linhas continuam os mesmos). Entende '…', "…" e `…` com escapes e `${…}` aninhado.
 * Regex literal não é parseado: `//` dentro de um regex precisa ser `\/\/` (design 4.4).
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Pilha de contextos: 'code' (com profundidade de chaves) e 'template'.
  const stack = [{ kind: 'code', depth: 0 }];
  let i = 0;
  while (i < text.length) {
    const top = stack[stack.length - 1];
    const c = text[i];
    if (top.kind === 'template') {
      if (c === '\\') i += 2;
      else if (c === '`') {
        stack.pop();
        i += 1;
      } else if (c === '$' && text[i + 1] === '{') {
        stack.push({ kind: 'code', depth: 0 });
        i += 2;
      } else i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else if (c === '`') {
      stack.push({ kind: 'template' });
      i += 1;
    } else if (c === '{') {
      top.depth += 1;
      i += 1;
    } else if (c === '}') {
      if (top.depth === 0 && stack.length > 1) stack.pop();
      else top.depth -= 1;
      i += 1;
    } else i += 1;
  }
  return out.join('');
}

/**
 * Cada chamada `.name(` com o índice e o texto dos argumentos (até o parêntese que fecha).
 * @returns {Array<{ index: number, args: string }>}
 */
export function callSites(text, name) {
  const calls = [];
  const re = new RegExp(`\\.${name}\\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
    }
    calls.push({ index: m.index, args: text.slice(m.index + m[0].length, i - 1) });
  }
  return calls;
}

/** Texto a partir de `start` (logo depois do parêntese que abre) até o parêntese que fecha. */
function argsFrom(text, start) {
  let depth = 1;
  let i = start;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
  }
  return text.slice(start, i - 1);
}

/** Texto dos argumentos de cada chamada `.name(` (até o parêntese que fecha). */
export function callArgs(text, name) {
  return callSites(text, name).map((c) => c.args);
}

/** Linha (1-based) do índice. */
export function lineOf(text, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (text[k] === '\n') line += 1;
  return line;
}

/**
 * Ocorrências das regras num arquivo.
 * @param {string} text texto cru
 * @param {{ web?: boolean }} [options] `web`: aplica também T9
 * @returns {Array<{ rule: string, line: number, marked: boolean }>}
 */
export function timeSourceHits(text, { web = false } = {}) {
  const code = stripComments(text);
  const rawLines = text.split('\n');
  const hits = [];
  const add = (rule, index) => {
    const line = lineOf(code, index);
    hits.push({ rule, line, marked: UTC_MARKER_RE.test(rawLines[line - 1] || '') });
  };
  for (const rule of TIME_SOURCE_RULES) {
    if (rule.webOnly && !web) continue;
    for (const m of code.matchAll(rule.re)) add(rule.id, m.index);
  }
  for (const m of code.matchAll(/\bDateTimeFormat\b/g)) {
    const direct = /\bIntl\s*\.\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index));
    const open = /^\s*\(/.exec(code.slice(m.index + m[0].length));
    if (!direct || !open) {
      add(T8.id, m.index);
      continue;
    }
    if (!T8.has.test(argsFrom(code, m.index + m[0].length + open[0].length))) add(T8.id, m.index);
  }
  return hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Número de linhas cruas com a marca `// utc`. */
export function utcMarkedLines(text) {
  return text.split('\n').filter((l) => UTC_MARKER_RE.test(l)).length;
}
