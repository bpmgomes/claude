// Template tag que escapa toda interpolação (design AF-09, 4.3). Módulo puro.
// Não há `raw()` exportado: só constantes do próprio módulo de render viram SafeHtml
// sem passar pela tag. Todo atributo é escrito entre aspas duplas no template.

const ENTITIES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
});

const ESCAPE_RE = /[&<>"'`]/g;

/** `String(value ?? '')` com & < > " ' ` trocados por entidades. */
export function escapeHtml(value) {
  return String(value ?? '').replace(ESCAPE_RE, (ch) => ENTITIES[ch]);
}

/** Texto HTML já seguro (resultado da tag `html`). */
export class SafeHtml {
  /** @param {string} text */
  constructor(text) {
    this.text = String(text);
  }

  toString() {
    return this.text;
  }
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

/**
 * Cada valor é escapado, exceto SafeHtml; arrays são concatenados item a item com a mesma
 * regra; null/undefined/false viram ''.
 * @returns {SafeHtml}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
