// Lógica do passo "Seus dados" da página pública (AF-04, 4.4). Sem DOM e sem rede: só as regras
// compartilhadas de /shared/customers.js (o servidor valida de novo de qualquer forma, critério 6).
import {
  validateCustomerName,
  validateCustomerPhone,
  validateCustomerEmail,
  validateCustomerInput,
  normalizeCustomerPhone,
} from '/shared/customers.js';
import { formatPhone } from '/shared/validation.js';

/** Campos do formulário, na ordem da tela (e chaves de `fields` do AF-11). */
export const CUSTOMER_FIELDS = Object.freeze(['name', 'phone', 'email']);

const VALIDATORS = Object.freeze({
  name: validateCustomerName,
  phone: validateCustomerPhone,
  email: validateCustomerEmail,
});

/**
 * @param {'name'|'phone'|'email'} field
 * @param {unknown} value
 * @returns {string|null} mensagem fixa de CUSTOMER_MESSAGES, ou null (válido ou campo desconhecido)
 */
export function checkCustomerField(field, value) {
  if (!CUSTOMER_FIELDS.includes(field)) return null;
  return VALIDATORS[field](value);
}

/** @param {unknown} values */
export function checkCustomerForm(values) {
  return validateCustomerInput(values);
}

/**
 * Máscara do telefone ao sair do campo (critério 24): só um número válido é reescrito, como
 * "(11) 91234-5678". Qualquer outra entrada volta intacta (nunca bloqueia nem corta o que foi colado).
 * @param {string} value
 * @returns {string}
 */
export function phoneDisplayOnBlur(value) {
  if (typeof value !== 'string') return '';
  if (validateCustomerPhone(value) !== null) return value;
  return formatPhone(normalizeCustomerPhone(value));
}

/**
 * Erros por campo devolvidos pelo servidor (para o AF-11): só as chaves de CUSTOMER_FIELDS com
 * valor string; o resto (inclusive `__proto__`) é ignorado.
 * @param {unknown} error `{ code, message, fields }` de requestJson
 * @returns {Partial<Record<'name'|'phone'|'email', string>>}
 */
export function serverFieldErrors(error) {
  const fields = error && typeof error === 'object' ? error.fields : null;
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const key of CUSTOMER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key) && typeof fields[key] === 'string') out[key] = fields[key];
  }
  return out;
}
