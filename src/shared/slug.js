// Slug do link público do negócio. Módulo puro, sem imports: usado pelo backend
// e pelo browser (pré-preenchimento do campo).

export const SLUG_MIN = 3;
export const SLUG_MAX = 50;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SLUG_MESSAGES = Object.freeze({
  invalid: 'O link deve ter de 3 a 50 caracteres, só com letras minúsculas sem acento, números e hífen.',
  reserved: 'Este link é reservado. Escolha outro.',
});

/**
 * Slugs que não podem ser usados por negócios: rotas e diretórios do app e nomes
 * institucionais. Um teste garante que todo diretório/HTML de `web/` e toda página
 * registrada estão aqui.
 */
export const RESERVED_SLUGS = readOnlySet([
  'admin', 'api', 'app', 'login', 'logout', 'cadastro', 'onboarding', 'negocio', 'servicos',
  'profissionais', 'horarios', 'bloqueios', 'agenda', 'agendar', 'agendamentos', 'painel', 'conta',
  'configuracoes', 'static', 'shared', 'media', 'uploads', 'assets', 'css', 'js', 'img',
  'public', 'www', 'ajuda', 'suporte', 'termos', 'privacidade', 'sobre', 'contato', 'blog',
  'status', 'health', 'robots', 'sitemap',
  // AF-12: página de gerenciar (`/agendamento/:token`) e o prefixo `/api/public/manage/...`, que
  // capturaria `GET /api/public/manage/availability` de um negócio de slug `manage`.
  'agendamento', 'manage',
  'esqueci-senha', 'redefinir-senha', // AF-03
]);

// Object.freeze sozinho não impede add/delete num Set: bloqueia as mutações e depois congela.
function readOnlySet(values) {
  const set = new Set(values);
  for (const method of ['add', 'delete', 'clear']) {
    Object.defineProperty(set, method, {
      value: () => {
        throw new TypeError('RESERVED_SLUGS é somente leitura.');
      },
    });
  }
  return Object.freeze(set);
}

function trimHyphens(text) {
  return text.replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * Gera um slug a partir do nome. Pode devolver menos de 3 caracteres ou ''.
 * "Salão da Ana" -> "salao-da-ana"; "  --Café & Cia--  " -> "cafe-cia".
 * @param {unknown} name
 * @returns {string}
 */
export function slugify(name) {
  if (typeof name !== 'string') return '';
  const base = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return trimHyphens(trimHyphens(base).slice(0, SLUG_MAX));
}

/** @returns {string} trim + minúsculas; não-string vira '' */
export function normalizeSlug(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/**
 * Valida um slug (editado ou gerado). Não "conserta" o valor.
 * @returns {{ ok: true, value: string } | { ok: false, reason: 'INVALID'|'RESERVED', message: string }}
 */
export function validateSlug(raw) {
  const slug = normalizeSlug(raw);
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX || !SLUG_RE.test(slug)) {
    return { ok: false, reason: 'INVALID', message: SLUG_MESSAGES.invalid };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, reason: 'RESERVED', message: SLUG_MESSAGES.reserved };
  }
  return { ok: true, value: slug };
}

/**
 * `${base}-${n}` com no máximo SLUG_MAX caracteres (corta a base se preciso).
 * @param {string} base
 * @param {number|string} n
 */
export function withSuffix(base, n) {
  const suffix = `-${n}`;
  const head = trimHyphens(String(base).slice(0, SLUG_MAX - suffix.length));
  return `${head}${suffix}`;
}

/**
 * Slug vindo da URL pública (AF-09). Não faz trim nem conserto, e não roda regex sobre texto longo.
 * - não string, ou length > SLUG_MAX            -> { kind: 'invalid' } (antes de qualquer transformação)
 * - lower = raw.toLowerCase(); lower.length !== raw.length -> invalid (ex.: 'İ')
 * - lower fora de SLUG_RE, < SLUG_MIN ou reservado -> invalid
 * - lower !== raw                                 -> { kind: 'redirect', slug: lower }
 * - senão                                         -> { kind: 'ok', slug: raw }
 * Os casos invalid nunca carregam o valor recebido.
 * @param {unknown} raw
 * @returns {{ kind: 'ok'|'redirect', slug: string } | { kind: 'invalid' }}
 */
export function parsePublicSlug(raw) {
  const invalid = { kind: 'invalid' };
  if (typeof raw !== 'string' || raw.length > SLUG_MAX) return invalid;
  const lower = raw.toLowerCase();
  if (lower.length !== raw.length) return invalid;
  if (lower.length < SLUG_MIN || !SLUG_RE.test(lower) || RESERVED_SLUGS.has(lower)) return invalid;
  if (lower !== raw) return { kind: 'redirect', slug: lower };
  return { kind: 'ok', slug: raw };
}
