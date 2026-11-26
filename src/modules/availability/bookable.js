import { NotFoundError } from '../../http/errors.js';
import { ANY_PROFESSIONAL } from '../../shared/availability.js';

/**
 * Serviço e profissionais "reserváveis", o mesmo critério nos dois endpoints públicos (AF-11,
 * critério 5, decisão 5): serviço ativo (findBookable) e profissionais listados na página pública
 * (findListedByBusinessId: ativos, com serviço ativo e com grade) que realizam o serviço. Lista
 * vazia é 404 (serviço oculto da página, AF-10 item 3). Com um UUID, ele precisa estar entre os
 * elegíveis, senão 404. Todas as leituras em `conn` (a transação da reserva, ou o `db` global).
 * @param {{
 *   servicesRepository: ReturnType<typeof import('../services/services.repository.js').createServicesRepository>,
 *   professionalsRepository: ReturnType<typeof import('../professionals/professionals.repository.js').createProfessionalsRepository>,
 * }} deps
 * @param {string} businessId
 * @param {{ serviceId: string, professionalId: string }} selection `professionalId` é um UUID ou 'any'
 * @param {import('../../db/index.js').Database} [conn]
 * @returns {Promise<{ service: import('../services/services.repository.js').Service,
 *                     eligible: import('../professionals/professionals.repository.js').Professional[] }>}
 *   `eligible` na ordem name_key, id
 * @throws {NotFoundError}
 */
export async function resolveBookable({ servicesRepository, professionalsRepository }, businessId, { serviceId, professionalId }, conn) {
  const service = await servicesRepository.findBookable(businessId, serviceId, conn);
  if (!service) throw new NotFoundError();
  const listed = await professionalsRepository.findListedByBusinessId(businessId, conn);
  let eligible = listed.filter((p) => (p.services || []).some((s) => s.id === serviceId));
  if (professionalId !== ANY_PROFESSIONAL) eligible = eligible.filter((p) => p.id === professionalId);
  if (eligible.length === 0) throw new NotFoundError();
  return { service, eligible };
}
