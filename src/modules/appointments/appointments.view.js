// Único caminho do 201 de `POST /api/public/:slug/appointments` (AF-11, critério 26). Módulo puro,
// no padrão de toPublicPage: só dados de exibição, nenhum id, nenhum instante UTC e nenhum dado do
// cliente (nem o digitado). As chaves são sempre as mesmas, para cliente novo e antigo.
import { formatDuration, formatServicePrice } from '../../shared/services.js';
import { formatPhone } from '../../shared/validation.js';

/**
 * Árvore de chaves da resposta (o teste compara recursivamente). `manage` (AF-12, critério 8) é
 * acrescentado pelo serviço na resposta; o corpo guardado na idempotência é só `{ appointment }`.
 */
export const PUBLIC_APPOINTMENT_FIELDS = Object.freeze({
  root: Object.freeze(['appointment', 'manage']),
  manage: Object.freeze(['url', 'cancellationLeadMinutes', 'policy']),
  appointment: Object.freeze(['start', 'end', 'weekday', 'timezone', 'service', 'professional', 'business']),
  service: Object.freeze(['name', 'durationMinutes', 'durationLabel', 'priceCents', 'priceOnRequest', 'priceLabel']),
  professional: Object.freeze(['name']),
  business: Object.freeze(['name', 'address', 'phoneDisplay', 'phoneHref']),
});

/**
 * @param {{
 *   booked: { start: string, end: string, weekday: number, professional: { name: string },
 *     service: { name: string, durationMinutes: number, priceCents: number|null, priceOnRequest: boolean } },
 *   business: { name: string, address: string, phone: string },
 *   timezone: string,
 * }} input
 * @returns {{ appointment: object }} o corpo guardado em `booking_idempotency_keys` (sem `manage`)
 */
export function toPublicAppointment({ booked, business, timezone }) {
  const priceOnRequest = Boolean(booked.service.priceOnRequest) || booked.service.priceCents === null;
  const priceCents = priceOnRequest ? null : booked.service.priceCents;
  const digits = String(business.phone ?? '').replace(/\D/g, '');
  return {
    appointment: {
      start: booked.start,
      end: booked.end,
      weekday: booked.weekday,
      timezone,
      service: {
        name: booked.service.name,
        durationMinutes: booked.service.durationMinutes,
        durationLabel: formatDuration(booked.service.durationMinutes),
        priceCents,
        priceOnRequest,
        priceLabel: formatServicePrice({ priceCents, priceOnRequest }),
      },
      professional: { name: booked.professional.name },
      business: {
        name: business.name,
        address: business.address,
        phoneDisplay: formatPhone(digits),
        phoneHref: `tel:+55${digits}`,
      },
    },
  };
}
