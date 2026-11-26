// Regras do cliente final compartilhadas entre backend e browser (/shared/customers.js, AF-04).
// Módulo puro: só importa ./validation.js (também puro). O servidor sempre valida de novo: a
// validação no navegador é só conveniência (critério 6).
import {
  EMAIL_MAX,
  normalizeText,
  normalizeEmail,
  hasForbiddenChars,
  hasVisibleContent,
  validateEmail,
} from './validation.js';

export const CUSTOMER_NAME_MIN = 2;
export const CUSTOMER_NAME_MAX = 80; // code points
export const CUSTOMER_EMAIL_MAX = EMAIL_MAX; // 254, de validation.js
export const CUSTOMER_PHONE_RAW_MAX = 40; // entrada com máscara; acima disso, inválido sem regex

/**
 * DDDs válidos (Anatel, plano de numeração nacional): 67 códigos. Fonte única; o teste confere a
 * contagem e amostras de inexistentes (20, 23, 25, 26, 29, 30, 36, 39, 40, 50, 52, 56 a 60, 70, 72,
 * 76, 78, 80, 90). Array congelado: a consulta usa um Set interno, não exportado, atrás de
 * `isValidDdd` (nenhum código fora deste módulo consegue alterar a lista usada na validação).
 */
export const VALID_DDDS = Object.freeze([
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
]);

const DDD_SET = new Set(VALID_DDDS);

/** Mensagens fixas: nenhuma interpola a entrada nem diz qual parte falhou (critério 3). */
export const CUSTOMER_MESSAGES = Object.freeze({
  nameRequired: 'Informe seu nome.',
  nameLength: 'O nome deve ter de 2 a 80 caracteres.',
  nameInvalid: 'O nome contém caracteres inválidos.',
  phoneRequired: 'Informe seu telefone.',
  phoneInvalid: 'Informe um celular ou telefone fixo com DDD, ex.: (11) 91234-5678.',
  emailRequired: 'Informe seu e-mail.',
  emailInvalid: 'Informe um e-mail válido.',
});

const M = CUSTOMER_MESSAGES;
const PHONE_ALLOWED = /^[0-9\s().+-]*$/;
const LETTER = /\p{L}/u;
const SAME_LAST_8 = /(\d)\1{7}$/;

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** @param {unknown} ddd @returns {boolean} */
export function isValidDdd(ddd) {
  return typeof ddd === 'string' && DDD_SET.has(ddd);
}

/**
 * Remove a máscara do telefone (decisão 4). Aceita só dígitos, espaço, `(`, `)`, `.`, `-` e `+`.
 * `+` no máximo uma vez, só no início e seguido de 55 (removido). Sem `+`, 12 ou 13 dígitos
 * começando com 55 perdem o 55 (código do país; um número nacional tem 10 ou 11 dígitos).
 * @param {unknown} raw
 * @returns {string|null} só dígitos (DDD + número, sem 55), ou null se a entrada não for aceitável
 */
export function normalizeCustomerPhone(raw) {
  if (typeof raw !== 'string' || raw.length > CUSTOMER_PHONE_RAW_MAX) return null;
  const text = raw.trim();
  if (!PHONE_ALLOWED.test(text)) return null;
  const plusCount = text.split('+').length - 1;
  let digits = text.replace(/\D/g, '');
  if (plusCount > 0) {
    if (plusCount > 1 || !text.startsWith('+') || !digits.startsWith('55')) return null;
    return digits.slice(2);
  }
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
  return digits;
}

/** @returns {string|null} mensagem fixa ou null */
export function validateCustomerName(raw) {
  const name = normalizeText(raw);
  if (name.length === 0) return M.nameRequired;
  const length = [...name].length;
  if (length < CUSTOMER_NAME_MIN || length > CUSTOMER_NAME_MAX) return M.nameLength;
  // A entrada inteira é conferida: um controle nas pontas ("Ana\n") também é recusado, e não aparado.
  if (hasForbiddenChars(raw) || hasForbiddenChars(name)) return M.nameInvalid;
  if (!hasVisibleContent(name) || !LETTER.test(name)) return M.nameInvalid;
  return null;
}

/** @returns {string|null} mensagem fixa ou null */
export function validateCustomerPhone(raw) {
  if (typeof raw === 'string' && raw.trim().length === 0) return M.phoneRequired;
  if (raw === undefined || raw === null) return M.phoneRequired;
  const digits = normalizeCustomerPhone(raw);
  if (digits === null) return M.phoneInvalid;
  if (digits.length !== 10 && digits.length !== 11) return M.phoneInvalid;
  if (!isValidDdd(digits.slice(0, 2))) return M.phoneInvalid;
  if (digits.length === 10 && !/[2-5]/.test(digits[2])) return M.phoneInvalid;
  if (digits.length === 11 && digits[2] !== '9') return M.phoneInvalid;
  if (SAME_LAST_8.test(digits)) return M.phoneInvalid;
  return null;
}

/** @returns {string|null} mensagem fixa ou null */
export function validateCustomerEmail(raw) {
  const email = normalizeEmail(raw);
  if (email.length === 0) return M.emailRequired;
  // Tamanho antes da regex (entrada enorme não chega à regex).
  if (email.length > CUSTOMER_EMAIL_MAX) return M.emailInvalid;
  if (hasForbiddenChars(email)) return M.emailInvalid;
  if (validateEmail(email) !== null) return M.emailInvalid;
  return null;
}

/** @typedef {{ name: string, phone: string, email: string }} CustomerInput   // já normalizado */

/**
 * Valida e normaliza os três campos, juntando os erros. Chaves desconhecidas são ignoradas (o corpo
 * do AF-11 tem outros campos). Não-objeto (inclusive null, array e string) vale {}.
 * @param {unknown} input
 * @returns {{ ok: true, value: CustomerInput } | { ok: false, fields: Partial<Record<'name'|'phone'|'email', string>> }}
 */
export function validateCustomerInput(input) {
  const src = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const get = (key) => (has(src, key) ? src[key] : undefined);
  const name = get('name');
  const phone = get('phone');
  const email = get('email');
  const fields = {};
  const nameError = validateCustomerName(name);
  if (nameError) fields.name = nameError;
  const phoneError = validateCustomerPhone(phone);
  if (phoneError) fields.phone = phoneError;
  const emailError = validateCustomerEmail(email);
  if (emailError) fields.email = emailError;

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: { name: normalizeText(name), phone: normalizeCustomerPhone(phone), email: normalizeEmail(email) },
  };
}
