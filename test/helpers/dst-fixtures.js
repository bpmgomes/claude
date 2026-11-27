// Negócios de fixture em fusos com horário de verão (AF-23, design 6, critério 6). A carga confere
// contra o tzdata que as datas de transição usadas pelos testes ainda são as esperadas (R14).
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, setBusinessTimezone } from './session.js';
import { localToInstant, parseLocalDateTime } from '../../src/shared/zoned-time.js';

/** Transições usadas pelos testes: hora local dentro do salto (`gap`) ou da dobra (`fold`). */
export const DST_TRANSITIONS = Object.freeze([
  Object.freeze({ timezone: 'America/New_York', local: '2026-03-08T02:30', adjusted: 'gap' }),
  Object.freeze({ timezone: 'America/New_York', local: '2026-11-01T01:30', adjusted: 'fold' }),
  Object.freeze({ timezone: 'America/Santiago', local: '2026-09-06T00:30', adjusted: 'gap' }),
  Object.freeze({ timezone: 'America/Santiago', local: '2026-04-04T23:30', adjusted: 'fold' }),
]);

/** Lança com mensagem clara se o tzdata mudou a regra de algum fuso da fixture. */
export function assertDstFixtures() {
  for (const t of DST_TRANSITIONS) {
    const got = localToInstant(parseLocalDateTime(t.local).value, t.timezone).adjusted;
    if (got !== t.adjusted) {
      throw new Error(`tzdata mudou a regra de ${t.timezone}; revise as datas da fixture (${t.local}: ${got}, esperado ${t.adjusted})`);
    }
  }
}

assertDstFixtures();

/** Grade só no domingo: 00:00–06:00 e 08:00–12:00 (as três datas de transição de domingo). */
export const SUNDAY_GRID = Object.freeze(
  [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
    Object.freeze({ weekday, intervals: weekday === 7 ? [{ start: '00:00', end: '06:00' }, { start: '08:00', end: '12:00' }] : [] }),
  ),
);

/** Grade só no sábado, 20:00–24:00 (dobra de Santiago em 04/04/2026). */
export const SATURDAY_NIGHT_GRID = Object.freeze(
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => Object.freeze({ weekday, intervals: weekday === 6 ? [{ start: '20:00', end: '24:00' }] : [] })),
);

/**
 * Negócio num fuso com horário de verão, com um serviço de 60 min e um profissional na grade dada.
 * @returns {Promise<{ cookies: object, business: object, slug: string, service: object, professional: object }>}
 */
export async function seedDstBusiness(app, { timezone, grid = SUNDAY_GRID, slug = `dst-${timezone.split('/')[1].toLowerCase().replaceAll('_', '-')}`, email } = {}) {
  const cookies = await signupAndLogin(app, { email: email || `dono-${slug}@x.com` });
  const business = await createBusinessFor(app, cookies, { name: 'Salão Verão', slug });
  await setBusinessTimezone(app, business.id, timezone);
  const service = await createService(app, cookies, { name: 'Corte', durationMinutes: 60, price: '50' });
  const professional = await createProfessional(app, cookies, { name: 'Bia Lima', serviceIds: [service.id] });
  const res = await putHours(app, cookies, professional.id, grid);
  if (res.statusCode !== 200) throw new Error(`grade: ${res.body}`);
  return { cookies, business, slug, service, professional };
}
