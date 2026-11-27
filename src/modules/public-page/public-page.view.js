// Único caminho do banco para o HTML da página pública (AF-09, critério 17). Módulo puro.
import { formatDuration, formatServicePrice } from '../../shared/services.js';
import { formatPhone } from '../../shared/validation.js';
import { logoUrlOf } from '../businesses/businesses.repository.js';
import { photoUrlOf } from '../professionals/professionals.repository.js';
import { instantToLocal, addLocalDays } from '../../shared/zoned-time.js';
import { DEFAULT_TIME_ZONE } from '../../shared/time-blocks.js';
import { BOOKING_HORIZON_DAYS } from '../../shared/availability.js';

/**
 * @typedef {{
 *   business: { name: string, slug: string, address: string, phoneDisplay: string, phoneHref: string,
 *     logoUrl: string|null },
 *   services: Array<{ id: string, name: string, durationMinutes: number, durationLabel: string, priceLabel: string,
 *     professionalNames: string[] }>,
 *   professionals: Array<{ id: string, name: string, photoUrl: string|null, serviceIds: string[], serviceNames: string[] }>,
 *   booking: { timezone: string, today: string, maxDate: string },
 *   hasOffer: boolean,
 *   canonicalUrl: string,
 *   ogImageUrl: string|null,
 *   description: string,
 * }} PublicPage
 */

/**
 * Lista permitida de campos (critério 17), por nível. O AF-10 acrescenta só os UUIDs de serviço e
 * profissional necessários para a escolha, a duração, os serviços de cada profissional e `booking`
 * (fuso, hoje e última data no fuso do negócio).
 */
export const PUBLIC_PAGE_FIELDS = Object.freeze({
  page: Object.freeze([
    'business',
    'services',
    'professionals',
    'booking',
    'hasOffer',
    'canonicalUrl',
    'ogImageUrl',
    'description',
  ]),
  business: Object.freeze(['name', 'slug', 'address', 'phoneDisplay', 'phoneHref', 'logoUrl']),
  service: Object.freeze(['id', 'name', 'durationMinutes', 'durationLabel', 'priceLabel', 'professionalNames']),
  professional: Object.freeze(['id', 'name', 'photoUrl', 'serviceIds', 'serviceNames']),
  booking: Object.freeze(['timezone', 'today', 'maxDate']),
});

/** Descrição da página (meta description e og:description): 68 caracteres + o nome (até 100). */
export function describeBusiness(name) {
  return `Veja serviços, preços e profissionais de ${name} e agende pelo AgendaFácil.`;
}

/**
 * Aplica as regras de visibilidade (decisões 3 e 4) e formata. Só os UUIDs de serviço e de
 * profissional visíveis saem (AF-10); nenhum outro id, data interna, name_key, chave de storage
 * ou dado do dono sai daqui.
 * - `services`: ativos do negócio (findActiveByBusinessId), na ordem do AF-06.
 * - `professionals`: listados (findListedByBusinessId), com os serviços ativos anexados.
 * Serviço sem profissional listado fica oculto.
 * @param {{ business: import('../businesses/businesses.repository.js').Business,
 *   services: import('../services/services.repository.js').Service[],
 *   professionals: import('../professionals/professionals.repository.js').Professional[] }} data
 * @param {{ publicBaseUrl: string, nowMs?: number }} options `nowMs`: instante atual do servidor
 *   (padrão Date.now()); `booking.today` é a data local do negócio nesse instante
 * @returns {PublicPage}
 */
export function toPublicPage({ business, services, professionals }, { publicBaseUrl, nowMs = Date.now() }) { // utc
  const listed = Array.isArray(professionals) ? professionals : [];
  const active = Array.isArray(services) ? services.filter((s) => s.active !== false) : [];

  /** serviceId -> nomes dos profissionais listados que o realizam, na ordem name_key, id */
  const namesByService = new Map();
  for (const professional of listed) {
    for (const service of professional.services || []) {
      if (service.active === false) continue;
      if (!namesByService.has(service.id)) namesByService.set(service.id, []);
      namesByService.get(service.id).push(professional.name);
    }
  }

  const visible = active.filter((s) => namesByService.has(s.id));
  const visibleIds = new Set(visible.map((s) => s.id));

  const publicServices = visible.map((s) => ({
    id: s.id,
    name: s.name,
    durationMinutes: s.durationMinutes,
    durationLabel: formatDuration(s.durationMinutes),
    priceLabel: formatServicePrice(s),
    professionalNames: [...namesByService.get(s.id)],
  }));

  const publicProfessionals = listed
    .map((p) => {
      const offered = (p.services || []).filter((s) => visibleIds.has(s.id));
      return {
        id: p.id,
        name: p.name,
        photoUrl: photoUrlOf(p.photoKey),
        serviceIds: offered.map((s) => s.id),
        serviceNames: offered.map((s) => s.name),
      };
    })
    .filter((p) => p.serviceNames.length > 0);

  const digits = String(business.phone ?? '').replace(/\D/g, '');
  const logoUrl = logoUrlOf(business.logoKey);
  const hasOffer = publicServices.length > 0;
  const timezone = business.timezone || DEFAULT_TIME_ZONE;
  const today = instantToLocal(nowMs, timezone).slice(0, 10);

  return {
    business: {
      name: business.name,
      slug: business.slug,
      address: business.address,
      phoneDisplay: formatPhone(digits),
      phoneHref: `tel:+55${digits}`,
      logoUrl,
    },
    services: hasOffer ? publicServices : [],
    professionals: hasOffer ? publicProfessionals : [],
    booking: { timezone, today, maxDate: addLocalDays(today, BOOKING_HORIZON_DAYS) },
    hasOffer,
    canonicalUrl: `${publicBaseUrl}/${business.slug}`,
    ogImageUrl: logoUrl ? `${publicBaseUrl}${logoUrl}` : null,
    description: describeBusiness(business.name),
  };
}
