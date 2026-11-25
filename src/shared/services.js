// Regras de serviço compartilhadas entre backend e browser (/shared/services.js).
// Módulo puro: só importa ./validation.js (também puro). Preço sempre em centavos
// inteiros, convertido por aritmética de string, sem ponto flutuante.
import { normalizeText, hasForbiddenChars, MESSAGES } from './validation.js';

export const SERVICE_NAME_MAX = 100;
export const DURATION_MIN = 15;
export const DURATION_MAX = 480;
export const DURATION_STEP = 15;
/** 15, 30, ..., 480 (32 opções): o `<select>` da tela. */
export const DURATION_OPTIONS = Object.freeze(
  Array.from({ length: (DURATION_MAX - DURATION_MIN) / DURATION_STEP + 1 }, (_, i) => DURATION_MIN + i * DURATION_STEP),
);
export const PRICE_MAX_CENTS = 9_999_999; // R$ 99.999,99
export const SERVICE_STATUSES = Object.freeze(['all', 'active', 'inactive']);

/** Identificador de serviço: UUID v4 em minúsculas, como o servidor gera. */
export const SERVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Mensagens fixas: nenhuma interpola a entrada (critério 7). */
export const SERVICE_MESSAGES = Object.freeze({
  nameRequired: 'Informe o nome do serviço.',
  nameTooLong: 'O nome deve ter no máximo 100 caracteres.',
  nameInvalid: 'O nome contém caracteres inválidos.',
  nameTaken: 'Já existe um serviço com este nome.',
  nameTakenInactive: 'Já existe um serviço desativado com este nome. Reative-o ou escolha outro nome.',
  durationRequired: 'Informe a duração.',
  durationInvalid: 'A duração deve ser de 15 min a 8 h, em intervalos de 15 min.',
  priceRequired: 'Informe o preço ou marque "Sob consulta".',
  priceInvalid: 'Informe um preço válido, ex.: 50,00.',
  priceNegative: 'O preço não pode ser negativo.',
  priceDecimals: 'Use no máximo 2 casas decimais.',
  priceTooHigh: 'O preço deve ser de no máximo R$ 99.999,99.',
  priceWithOnRequest: 'Serviço sob consulta não tem preço. Remova o preço ou desmarque "Sob consulta".',
  priceOnRequestInvalid: 'Valor inválido.',
  statusInvalid: 'Filtro inválido.',
  limitReached: 'Você atingiu o limite de 100 serviços. Edite um serviço existente.',
  businessRequired: 'Cadastre seu negócio antes de criar serviços.',
  notFound: 'Serviço não encontrado.',
});

const PRICE_TEXT_MAX = 20;
const PRICE_RE = /^(\d+)(?:[.,](\d+))?$/;
const PRICE_INTEGER_DIGITS_MAX = 7;
const SERVICE_FIELDS = ['name', 'durationMinutes', 'price', 'priceOnRequest'];

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Mesma regra do nome do negócio: trim + NFC, 1..100 code points, sem \p{Cc}/\p{Cf}.
 * @returns {string|null} mensagem de erro ou null
 */
export function validateServiceName(raw) {
  const name = normalizeText(raw);
  if (name.length === 0) return SERVICE_MESSAGES.nameRequired;
  if ([...name].length > SERVICE_NAME_MAX) return SERVICE_MESSAGES.nameTooLong;
  if (hasForbiddenChars(name)) return SERVICE_MESSAGES.nameInvalid;
  return null;
}

/**
 * Chave de unicidade do nome: sem acentos, minúsculas, espaços colapsados.
 * "Corte Masculino", "corte  masculino", "CÓRTE MASCULINO" -> "corte masculino".
 * @returns {string}
 */
export function serviceNameKey(name) {
  return normalizeText(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Só número JSON inteiro, de 15 a 480, múltiplo de 15. Texto (inclusive "30") é rejeitado.
 * @returns {string|null}
 */
export function validateDuration(raw) {
  if (raw === undefined || raw === null || raw === '') return SERVICE_MESSAGES.durationRequired;
  if (!Number.isInteger(raw) || raw < DURATION_MIN || raw > DURATION_MAX || raw % DURATION_STEP !== 0) {
    return SERVICE_MESSAGES.durationInvalid;
  }
  return null;
}

/**
 * Converte o preço digitado (pt-BR: `50`, `50,5`, `50.50`) ou um número JSON em centavos.
 * Sem parseFloat: só aritmética de inteiros sobre a string. `0` é aceito (gratuito).
 * @param {unknown} raw
 * @returns {{ ok: true, cents: number } | { ok: false, message: string }}
 */
export function parsePriceToCents(raw) {
  let text;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, message: SERVICE_MESSAGES.priceInvalid };
    text = String(raw); // 50.5 -> "50.5"; 1e21 -> "1e+21" (rejeitado pelo regex)
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return { ok: false, message: SERVICE_MESSAGES.priceInvalid };
  }

  text = text.trim();
  if (text.length === 0) return { ok: false, message: SERVICE_MESSAGES.priceRequired };
  if (text.length > PRICE_TEXT_MAX) return { ok: false, message: SERVICE_MESSAGES.priceInvalid };
  if (text.startsWith('-')) return { ok: false, message: SERVICE_MESSAGES.priceNegative };

  const match = text.match(PRICE_RE);
  if (!match) return { ok: false, message: SERVICE_MESSAGES.priceInvalid };
  const decimals = match[2] ?? '';
  if (decimals.length > 2) return { ok: false, message: SERVICE_MESSAGES.priceDecimals };

  const integer = match[1].replace(/^0+(?=\d)/, '');
  if (integer.length > PRICE_INTEGER_DIGITS_MAX) return { ok: false, message: SERVICE_MESSAGES.priceTooHigh };

  const cents = Number(integer) * 100 + Number(decimals.padEnd(2, '0'));
  if (cents > PRICE_MAX_CENTS) return { ok: false, message: SERVICE_MESSAGES.priceTooHigh };
  return { ok: true, cents };
}

/**
 * "R$ 50,50", "R$ 1.234,00", "R$ 0,00". Só inteiros; sem Intl (que usa U+00A0 e varia com a ICU).
 * @param {number} cents inteiro >= 0
 * @returns {string}
 */
export function formatPriceCents(cents) {
  const value = Math.trunc(Number(cents) || 0);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const reais = String(Math.trunc(abs / 100));
  const centavos = String(abs % 100).padStart(2, '0');
  let grouped = '';
  for (let i = 0; i < reais.length; i++) {
    if (i > 0 && (reais.length - i) % 3 === 0) grouped += '.';
    grouped += reais[i];
  }
  return `${sign}R$ ${grouped},${centavos}`;
}

/** @param {{ priceCents: number|null, priceOnRequest: boolean }} service */
export function formatServicePrice(service) {
  if (!service || service.priceOnRequest || service.priceCents === null || service.priceCents === undefined) {
    return 'Sob consulta';
  }
  return formatPriceCents(service.priceCents);
}

/** 15 -> "15 min", 60 -> "1 h", 90 -> "1 h 30 min", 480 -> "8 h". */
export function formatDuration(minutes) {
  const total = Math.trunc(Number(minutes) || 0);
  const hours = Math.trunc(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

/**
 * Valida os dados do serviço, juntando os erros de todos os campos.
 * - partial=false (criação): name e durationMinutes obrigatórios; `priceOnRequest` padrão false;
 *   `value` sempre traz `priceCents` (number|null) e `priceOnRequest` (boolean).
 * - partial=true (PATCH): só os campos presentes (a chave existe). O par preço/sob consulta é
 *   autocontido: se qualquer um dos dois vier, os dois são gravados juntos.
 * Regras do par: sob consulta com preço informado -> erro em `price`; sem sob consulta e sem
 * preço (ausente ou null) -> erro em `price`. PATCH sem nenhum campo de serviço devolve
 * `fields: {}` e `message` "Nada para atualizar.".
 * @param {unknown} input
 * @returns {{ ok: true, value: { name?: string, nameKey?: string, durationMinutes?: number,
 *   priceCents?: number|null, priceOnRequest?: boolean } } | { ok: false, fields: Record<string, string>, message?: string }}
 */
export function validateServiceInput(input, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  if (partial && !hasServiceFields(src)) return { ok: false, fields: {}, message: MESSAGES.nothingToUpdate };
  const present = (key) => !partial || has(src, key);
  const fields = {};
  const value = {};

  if (present('name')) {
    const error = validateServiceName(src.name);
    if (error) fields.name = error;
    else {
      value.name = normalizeText(src.name);
      value.nameKey = serviceNameKey(value.name);
    }
  }

  if (present('durationMinutes')) {
    const error = validateDuration(src.durationMinutes);
    if (error) fields.durationMinutes = error;
    else value.durationMinutes = src.durationMinutes;
  }

  const pairTouched = !partial || has(src, 'price') || has(src, 'priceOnRequest');
  if (pairTouched) {
    let onRequest = false;
    if (src.priceOnRequest !== undefined) {
      if (typeof src.priceOnRequest === 'boolean') onRequest = src.priceOnRequest;
      else fields.priceOnRequest = SERVICE_MESSAGES.priceOnRequestInvalid;
    }
    const priceGiven = src.price !== undefined && src.price !== null;

    if (onRequest) {
      if (priceGiven) fields.price = SERVICE_MESSAGES.priceWithOnRequest;
      else {
        value.priceCents = null;
        value.priceOnRequest = true;
      }
    } else if (!priceGiven) {
      fields.price = SERVICE_MESSAGES.priceRequired;
    } else {
      const parsed = parsePriceToCents(src.price);
      if (!parsed.ok) fields.price = parsed.message;
      else if (!fields.priceOnRequest) {
        value.priceCents = parsed.cents;
        value.priceOnRequest = false;
      }
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value };
}

/** @returns {boolean} true se o objeto tem ao menos um campo editável do serviço */
export function hasServiceFields(input) {
  if (!input || typeof input !== 'object') return false;
  return SERVICE_FIELDS.some((key) => has(input, key));
}

/**
 * Filtro da listagem. Ausente equivale a `all`.
 * @returns {{ ok: true, value: 'all'|'active'|'inactive' } | { ok: false, message: string }}
 */
export function validateStatusFilter(raw) {
  if (raw === undefined) return { ok: true, value: 'all' };
  if (typeof raw === 'string' && SERVICE_STATUSES.includes(raw)) return { ok: true, value: raw };
  return { ok: false, message: SERVICE_MESSAGES.statusInvalid };
}
