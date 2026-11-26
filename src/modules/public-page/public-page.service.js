import { toPublicPage } from './public-page.view.js';

/**
 * Página pública do negócio (AF-09). Três consultas indexadas por business_id, sem IN (...)
 * e sem N+1. As leituras não rodam numa transação: a página é uma fotografia, e uma remoção
 * concorrente aparece na próxima carga (no máximo 60 s, critério 23).
 * @param {{
 *   businessesRepository: ReturnType<typeof import('../businesses/businesses.repository.js').createBusinessesRepository>,
 *   servicesRepository: ReturnType<typeof import('../services/services.repository.js').createServicesRepository>,
 *   professionalsRepository: ReturnType<typeof import('../professionals/professionals.repository.js').createProfessionalsRepository>,
 *   config: { publicBaseUrl: string },
 *   now?: () => Date,   // relógio do servidor: `booking.today` e `booking.maxDate` (AF-10)
 * }} deps
 */
export function createPublicPageService({
  businessesRepository,
  servicesRepository,
  professionalsRepository,
  config,
  now = () => new Date(),
}) {
  return {
    /**
     * @param {string} slug já canônico (parsePublicSlug deu `ok`)
     * @returns {Promise<import('./public-page.view.js').PublicPage|null>} null: inexistente ou em
     *   quarentena (que não está em `businesses`); a rota dá o 404 uniforme
     */
    async getPage(slug) {
      const business = await businessesRepository.findBySlug(slug);
      if (!business) return null;
      const [services, professionals] = await Promise.all([
        servicesRepository.findActiveByBusinessId(business.id),
        professionalsRepository.findListedByBusinessId(business.id),
      ]);
      return toPublicPage(
        { business, services, professionals },
        { publicBaseUrl: config.publicBaseUrl, nowMs: now().getTime() },
      );
    },
  };
}
