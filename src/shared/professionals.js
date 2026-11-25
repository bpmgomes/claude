// Regras de profissional compartilhadas entre backend e browser (/shared/professionals.js).
// Módulo puro: só importa ./validation.js e ./services.js (também puros).
import { normalizeText, validateText, textKey, MESSAGES } from './validation.js';
import { SERVICE_ID_RE } from './services.js';

export const PROFESSIONAL_NAME_MAX = 100;
/** Máximo de IDs em `serviceIds`, igual ao limite de serviços por negócio do AF-06. */
export const SERVICE_IDS_MAX = 100;

/** Identificador de profissional: UUID v4 em minúsculas (o mesmo formato de SERVICE_ID_RE). */
export const PROFESSIONAL_ID_RE = SERVICE_ID_RE;

/** Mensagens fixas: nenhuma interpola a entrada (critério 5). */
export const PROFESSIONAL_MESSAGES = Object.freeze({
  nameRequired: 'Informe o nome do profissional.',
  nameTooLong: 'O nome deve ter no máximo 100 caracteres.',
  nameInvalid: 'O nome contém caracteres inválidos.',
  nameDuplicate: 'Já existe um profissional com este nome. Confira se não é a mesma pessoa.',
  serviceIdsInvalid: 'Selecione serviços válidos.',
  serviceIdsTooMany: 'Selecione no máximo 100 serviços.',
  limitReached: 'Você atingiu o limite de 50 profissionais. Remova um profissional para cadastrar outro.',
  businessRequired: 'Cadastre seu negócio antes de cadastrar profissionais.',
  notFound: 'Profissional não encontrado.',
  hasFutureAppointments:
    'Este profissional tem agendamentos futuros. Realoque ou cancele esses agendamentos antes de remover.',
  photoTooLarge: 'A foto deve ter no máximo 2 MB.',
});

const PROFESSIONAL_FIELDS = ['name', 'serviceIds'];

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Chave normalizada do nome (aviso de homônimo e ordenação). */
export const professionalNameKey = textKey;

/**
 * Mesma regra de texto do negócio e do serviço (validateText).
 * @returns {string|null} mensagem de erro ou null
 */
export function validateProfessionalName(raw) {
  return validateText(raw, PROFESSIONAL_NAME_MAX, {
    required: PROFESSIONAL_MESSAGES.nameRequired,
    tooLong: PROFESSIONAL_MESSAGES.nameTooLong,
    invalid: PROFESSIONAL_MESSAGES.nameInvalid,
  });
}

/**
 * Lista de serviços do profissional. Ausente ou null equivale a [] (rascunho).
 * Repetições são removidas, mantendo a ordem da primeira ocorrência.
 * @param {unknown} raw
 * @returns {{ ok: true, value: string[] } | { ok: false, message: string }}
 */
export function validateServiceIds(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: PROFESSIONAL_MESSAGES.serviceIdsInvalid };
  if (raw.length > SERVICE_IDS_MAX) return { ok: false, message: PROFESSIONAL_MESSAGES.serviceIdsTooMany };
  const seen = new Set();
  const value = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !SERVICE_ID_RE.test(item)) {
      return { ok: false, message: PROFESSIONAL_MESSAGES.serviceIdsInvalid };
    }
    if (seen.has(item)) continue;
    seen.add(item);
    value.push(item);
  }
  return { ok: true, value };
}

/** @returns {boolean} true se o objeto tem ao menos um campo editável do profissional */
export function hasProfessionalFields(input) {
  if (!input || typeof input !== 'object') return false;
  return PROFESSIONAL_FIELDS.some((key) => has(input, key));
}

/**
 * Valida os dados do profissional, juntando os erros de todos os campos.
 * - partial=false (criação): name obrigatório; serviceIds ausente ou null -> [].
 * - partial=true (PATCH): só os campos presentes (a chave existe). Sem nenhum campo,
 *   devolve `fields: {}` e `message` "Nada para atualizar.".
 * Qualquer outro campo (businessId, id, photoKey, removedAt...) é ignorado.
 * @param {unknown} input
 * @returns {{ ok: true, value: { name?: string, nameKey?: string, serviceIds?: string[] } }
 *         | { ok: false, fields: Record<string, string>, message?: string }}
 */
export function validateProfessionalInput(input, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  if (partial && !hasProfessionalFields(src)) return { ok: false, fields: {}, message: MESSAGES.nothingToUpdate };
  const present = (key) => !partial || has(src, key);
  const fields = {};
  const value = {};

  if (present('name')) {
    const error = validateProfessionalName(src.name);
    if (error) fields.name = error;
    else {
      value.name = normalizeText(src.name);
      value.nameKey = professionalNameKey(value.name);
    }
  }

  if (present('serviceIds')) {
    const check = validateServiceIds(src.serviceIds);
    if (!check.ok) fields.serviceIds = check.message;
    else value.serviceIds = check.value;
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value };
}

/**
 * Aviso de homônimo na tela: true se outro profissional da lista (exceto `exceptId`) tem a
 * mesma chave normalizada (ignora caixa, acentos e espaços).
 * @param {unknown} name
 * @param {Array<{ id: string, name: string }>} professionals
 * @param {string} [exceptId]
 * @returns {boolean}
 */
export function hasDuplicateName(name, professionals, exceptId) {
  const key = professionalNameKey(name);
  if (key === '' || !Array.isArray(professionals)) return false;
  return professionals.some((p) => p && p.id !== exceptId && professionalNameKey(p.name) === key);
}
