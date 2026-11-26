// Validação compartilhada entre backend e browser. Módulo puro: só importa ./slug.js
// (também puro), que o browser resolve como /shared/slug.js.
import { validateSlug } from './slug.js';

export const NAME_MAX = 100;
export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX_BYTES = 72; // limite do bcrypt
export const BUSINESS_NAME_MAX = 100;
export const ADDRESS_MAX = 200;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2.097.152, inclusive (usado também no browser)
/** Antecedência para o cliente cancelar ou remarcar online (AF-12, critério 1, decisão 7). */
export const CANCELLATION_LEAD_MIN_MINUTES = 0;
export const CANCELLATION_LEAD_MAX_MINUTES = 4320; // 72 h
export const CANCELLATION_LEAD_STEP_MINUTES = 15;
export const CANCELLATION_LEAD_DEFAULT_MINUTES = 120; // = DEFAULT da migração 012 (teste)

export const MESSAGES = Object.freeze({
  nameRequired: 'Informe seu nome.',
  nameTooLong: 'O nome deve ter no máximo 100 caracteres.',
  nameInvalid: 'O nome contém caracteres inválidos.',
  emailRequired: 'Informe seu e-mail.',
  emailInvalid: 'Informe um e-mail válido.',
  passwordRequirement: 'A senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.',
  passwordTooLong: 'A senha deve ter no máximo 72 caracteres.',
  passwordRequired: 'Informe sua senha.',
  businessNameRequired: 'Informe o nome do negócio.',
  businessNameTooLong: 'O nome deve ter no máximo 100 caracteres.',
  businessNameInvalid: 'O nome contém caracteres inválidos.',
  addressRequired: 'Informe o endereço.',
  addressTooLong: 'O endereço deve ter no máximo 200 caracteres.',
  addressInvalid: 'O endereço contém caracteres inválidos.',
  phoneRequired: 'Informe o telefone.',
  phoneInvalid: 'Informe um telefone com DDD, ex.: (11) 91234-5678.',
  nothingToUpdate: 'Nada para atualizar.',
  leadNotInteger: 'Informe o prazo em minutos, com um número inteiro.',
  leadOutOfRange: 'Escolha um prazo entre 0 e 4320 minutos (72 h).',
  leadNotMultiple: 'Use múltiplos de 15 minutos (ex.: 15, 30, 60, 120).',
});

// \p{Cc}: controle (inclui \n, \t, U+007F..U+009F). \p{Cf}: formatação invisível e bidi
// (U+200B, U+200D, U+202E, U+2066..2069, U+00AD, U+FEFF...).
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;
const PHONE_ALLOWED = /^[0-9\s().+-]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * trim + NFC + minúsculas (AF-11, decisão 15): o mesmo endereço em forma composta e decomposta
 * vira uma chave só (clientes do AF-04 e contas do dono do AF-01).
 * @returns {string}
 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().normalize('NFC').toLowerCase();
}

/** @returns {string|null} */
export function validateName(raw) {
  if (typeof raw !== 'string') return MESSAGES.nameRequired;
  const name = raw.trim();
  if (name.length === 0) return MESSAGES.nameRequired;
  if ([...name].length > NAME_MAX) return MESSAGES.nameTooLong;
  if (hasForbiddenChars(name)) return MESSAGES.nameInvalid;
  return null;
}

/**
 * Regra de texto comum (AF-01 item 5): caracteres de controle ou de formatação invisível.
 * @returns {boolean}
 */
export function hasForbiddenChars(text) {
  return typeof text === 'string' && FORBIDDEN_CHARS.test(text);
}

/** @returns {string} não-string vira ''; trim + NFC */
export function normalizeText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().normalize('NFC');
}

// Letras e brancos invisíveis que não são \p{Cf}: U+115F, U+1160, U+3164 (Hangul filler),
// U+FFA0 (halfwidth Hangul filler), U+2800 (Braille em branco).
const INVISIBLE_CHARS = /[\u115F\u1160\u3164\uFFA0\u2800]/u;
const VISIBLE_CHAR = /[\p{L}\p{N}]/u;
const LEADING_MARK = /^\p{M}/u;
/** No máximo 3 marcas combinantes seguidas por letra (AF-06 item 1). */
export const MAX_MARKS_PER_LETTER = 3;
const TOO_MANY_MARKS = new RegExp(`\\p{M}{${MAX_MARKS_PER_LETTER + 1},}`, 'u');

/**
 * Chave normalizada: NFC -> NFD -> remove \p{M} -> minúsculas -> colapsa \s+.
 * "Corte Masculino", "corte  masculino", "CÓRTE MASCULINO" -> "corte masculino".
 * @returns {string}
 */
export function textKey(text) {
  return normalizeText(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Conteúdo visível (AF-06 item 1): ao menos um \p{L}/\p{N}, nenhum caractere de
 * INVISIBLE_CHARS, não começa com \p{M} e não tem mais de 3 \p{M} seguidos (na forma NFD).
 * @returns {boolean}
 */
export function hasVisibleContent(text) {
  if (typeof text !== 'string') return false;
  if (INVISIBLE_CHARS.test(text)) return false;
  const decomposed = text.normalize('NFD');
  if (LEADING_MARK.test(decomposed)) return false;
  if (TOO_MANY_MARKS.test(decomposed)) return false;
  return VISIBLE_CHAR.test(decomposed);
}

/**
 * Regra única de texto (nome do negócio, endereço, serviço, profissional): trim + NFC,
 * 1..max code points, sem \p{Cc}/\p{Cf} e com conteúdo visível.
 * @param {unknown} raw
 * @param {number} max
 * @param {{ required: string, tooLong: string, invalid: string }} messages
 * @returns {string|null}
 */
export function validateText(raw, max, messages) {
  const text = normalizeText(raw);
  if (text.length === 0) return messages.required;
  if ([...text].length > max) return messages.tooLong;
  if (hasForbiddenChars(text)) return messages.invalid;
  if (!hasVisibleContent(text) || textKey(text) === '') return messages.invalid;
  return null;
}

/** @returns {string|null} */
export function validateBusinessName(raw) {
  return validateText(raw, BUSINESS_NAME_MAX, {
    required: MESSAGES.businessNameRequired,
    tooLong: MESSAGES.businessNameTooLong,
    invalid: MESSAGES.businessNameInvalid,
  });
}

/** @returns {string|null} */
export function validateAddress(raw) {
  return validateText(raw, ADDRESS_MAX, {
    required: MESSAGES.addressRequired,
    tooLong: MESSAGES.addressTooLong,
    invalid: MESSAGES.addressInvalid,
  });
}

/**
 * Remove a máscara do telefone. Aceita só dígitos, espaço, `(`, `)`, `.`, `+` e `-`;
 * `+` só no início e seguido de 55 (removido).
 * @returns {string|null} só dígitos, ou null se houver caractere não permitido
 */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!PHONE_ALLOWED.test(text)) return null;
  const plusCount = (text.match(/\+/g) || []).length;
  let digits = text.replace(/\D/g, '');
  if (plusCount > 0) {
    if (plusCount > 1 || !text.startsWith('+') || !digits.startsWith('55')) return null;
    digits = digits.slice(2);
  }
  return digits;
}

/** @returns {string|null} */
export function validatePhone(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return MESSAGES.phoneRequired;
  const digits = normalizePhone(raw);
  if (digits === null || !/^[1-9]{2}/.test(digits)) return MESSAGES.phoneInvalid;
  if (digits.length === 11 && digits[2] === '9') return null;
  if (digits.length === 10 && /[2-5]/.test(digits[2])) return null;
  return MESSAGES.phoneInvalid;
}

/**
 * Formata para exibição: "(11) 91234-5678" ou "(11) 3123-4567". Outros valores voltam como vieram.
 * @param {string} digits
 */
export function formatPhone(digits) {
  if (typeof digits !== 'string') return '';
  if (/^\d{11}$/.test(digits)) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (/^\d{10}$/.test(digits)) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return digits;
}

const BUSINESS_FIELDS = ['name', 'address', 'phone', 'slug', 'cancellationLeadMinutes'];

/**
 * Antecedência do negócio (AF-12, critério 2): só número JSON inteiro, de 0 a 4320, múltiplo de 15.
 * Ordem: inteiro, intervalo, múltiplo. Nenhuma mensagem ecoa a entrada.
 * @param {unknown} raw
 * @returns {string|null} mensagem fixa ou null
 */
export function validateCancellationLead(raw) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return MESSAGES.leadNotInteger;
  if (raw < CANCELLATION_LEAD_MIN_MINUTES || raw > CANCELLATION_LEAD_MAX_MINUTES) return MESSAGES.leadOutOfRange;
  if (raw % CANCELLATION_LEAD_STEP_MINUTES !== 0) return MESSAGES.leadNotMultiple;
  return null;
}

/**
 * Valida os dados do negócio, juntando os erros de todos os campos.
 * - partial=false (criação): name, address e phone obrigatórios; slug opcional
 *   (ausente, null ou '' -> não vem em `value`, e o servidor gera a partir do nome).
 * - partial=true (PATCH): só os campos presentes (a chave existe no objeto); null ou ''
 *   em campo presente é erro.
 * @param {unknown} input
 * - `cancellationLeadMinutes` (AF-12): validado só quando é chave própria e diferente de
 *   `undefined`, em criação e em edição.
 * @returns {{ ok: true, value: { name?: string, address?: string, phone?: string, slug?: string,
 *   cancellationLeadMinutes?: number } }
 *         | { ok: false, fields: Record<string, string> }}
 */
export function validateBusinessInput(input, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const present = (key) => !partial || Object.prototype.hasOwnProperty.call(src, key);
  const fields = {};
  const value = {};

  if (present('name')) {
    const error = validateBusinessName(src.name);
    if (error) fields.name = error;
    else value.name = normalizeText(src.name);
  }
  if (present('address')) {
    const error = validateAddress(src.address);
    if (error) fields.address = error;
    else value.address = normalizeText(src.address);
  }
  if (present('phone')) {
    const error = validatePhone(src.phone);
    if (error) fields.phone = error;
    else value.phone = normalizePhone(src.phone);
  }
  const slugGiven = partial
    ? Object.prototype.hasOwnProperty.call(src, 'slug')
    : src.slug !== undefined && src.slug !== null && src.slug !== '';
  if (slugGiven) {
    const check = validateSlug(src.slug);
    if (!check.ok) fields.slug = check.message;
    else value.slug = check.value;
  }
  if (Object.prototype.hasOwnProperty.call(src, 'cancellationLeadMinutes') && src.cancellationLeadMinutes !== undefined) {
    const error = validateCancellationLead(src.cancellationLeadMinutes);
    if (error) fields.cancellationLeadMinutes = error;
    else value.cancellationLeadMinutes = src.cancellationLeadMinutes;
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value };
}

/** @returns {boolean} true se o objeto tem ao menos um campo editável do negócio */
export function hasBusinessFields(input) {
  if (!input || typeof input !== 'object') return false;
  return BUSINESS_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

/** @returns {string|null} */
export function validateEmail(raw) {
  const email = normalizeEmail(raw);
  if (email.length === 0) return MESSAGES.emailRequired;
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return MESSAGES.emailInvalid;
  return null;
}

/** @returns {string|null} */
export function validatePassword(raw) {
  if (typeof raw !== 'string') return MESSAGES.passwordRequirement;
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES) return MESSAGES.passwordTooLong;
  if ([...raw].length < PASSWORD_MIN || !/\p{L}/u.test(raw) || !/\d/.test(raw)) {
    return MESSAGES.passwordRequirement;
  }
  return null;
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: { name: string, email: string, password: string } }
 *         | { ok: false, fields: Record<string, string> }}
 */
export function validateSignup(input) {
  const src = input && typeof input === 'object' ? input : {};
  const fields = {};
  const nameError = validateName(src.name);
  if (nameError) fields.name = nameError;
  const emailError = validateEmail(src.email);
  if (emailError) fields.email = emailError;
  const passwordError = validatePassword(src.password);
  if (passwordError) fields.password = passwordError;

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: { name: src.name.trim(), email: normalizeEmail(src.email), password: src.password },
  };
}

/**
 * Validação do login. Não aplica as regras de força de senha do cadastro: elas
 * podem mudar e não podem impedir quem já tem conta de entrar. Nenhuma mensagem
 * depende de a conta existir.
 * @param {unknown} input
 * @returns {{ ok: true, value: { email: string, password: string } }
 *         | { ok: false, fields: Record<string, string> }}
 */
export function validateLogin(input) {
  const src = input && typeof input === 'object' ? input : {};
  const fields = {};
  const emailError = validateEmail(src.email);
  if (emailError) fields.email = emailError;
  if (typeof src.password !== 'string' || src.password.length === 0) {
    fields.password = MESSAGES.passwordRequired;
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { email: normalizeEmail(src.email), password: src.password } };
}
