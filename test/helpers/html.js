// Parser mínimo, só para o HTML gerado pela página pública (atributos sempre entre aspas duplas).

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*"([^"]*)")?/g;

/**
 * Lista de atributos de cada tag `name` (minúsculas), na ordem do documento.
 * @param {string} html
 * @param {string} name
 * @returns {Array<Record<string, string>>}
 */
export function tagsOf(html, name) {
  const re = new RegExp(`<${name}(?=[\\s>/])([^>]*)>`, 'gi');
  const tags = [];
  for (const match of html.matchAll(re)) {
    const attrs = {};
    for (const attr of match[1].matchAll(ATTR_RE)) {
      if (attr[1] === '/') continue;
      attrs[attr[1].toLowerCase()] = attr[2] === undefined ? '' : decodeEntities(attr[2]);
    }
    tags.push(attrs);
  }
  return tags;
}

/** Todos os nomes de tag de abertura do documento (minúsculas). */
export function tagNamesOf(html) {
  return [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());
}

/** Decodifica as entidades que escapeHtml produz (e as numéricas). */
export function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Texto do documento: sem tags, entidades decodificadas e espaços colapsados. */
export function textOf(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
