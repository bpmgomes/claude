/** Cookie `af_session=...` de uma resposta (ou undefined). */
export function cookieFrom(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.find((c) => c && c.startsWith('af_session='));
}

/** Token da sessão de uma resposta. */
export function tokenFrom(res) {
  return cookieFrom(res).split(';')[0].split('=')[1];
}

export const TEST_PASSWORD = 'abcd1234';

/**
 * Cria uma conta (o cadastro já abre sessão) e devolve os cookies para `app.inject`.
 * @returns {Promise<{ af_session: string }>}
 */
export async function signupAndLogin(app, { email = 'ana@x.com', name = 'Ana' } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    payload: { name, email, password: TEST_PASSWORD },
  });
  if (res.statusCode !== 201) throw new Error(`signup falhou: ${res.statusCode} ${res.body}`);
  return { af_session: tokenFrom(res) };
}

export const TEST_BUSINESS = Object.freeze({ name: 'Salão da Ana', address: 'Rua A, 10', phone: '(11) 91234-5678' });

/**
 * Cria o negócio do dono via `POST /api/business` e devolve o negócio da resposta.
 * @returns {Promise<object>}
 */
export async function createBusinessFor(app, cookies, overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/business',
    cookies,
    payload: { ...TEST_BUSINESS, ...overrides },
  });
  if (res.statusCode !== 201) throw new Error(`criação do negócio falhou: ${res.statusCode} ${res.body}`);
  return res.json().business;
}

/**
 * Cria um serviço via `POST /api/services` e devolve o serviço da resposta.
 * @returns {Promise<object>}
 */
export async function createService(app, cookies, body = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/services',
    cookies,
    payload: { name: 'Corte', durationMinutes: 30, price: '50', ...body },
  });
  if (res.statusCode !== 201) throw new Error(`criação do serviço falhou: ${res.statusCode} ${res.body}`);
  return res.json().service;
}

/**
 * Cria um profissional via `POST /api/professionals` e devolve o profissional da resposta.
 * @returns {Promise<object>}
 */
export async function createProfessional(app, cookies, body = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/professionals',
    cookies,
    payload: { name: 'Ana Souza', ...body },
  });
  if (res.statusCode !== 201) throw new Error(`criação do profissional falhou: ${res.statusCode} ${res.body}`);
  return res.json().professional;
}

/** Segunda a sexta 09:00–12:00 e 13:00–18:00; sábado e domingo de folga (AF-08). */
export const WEEK_9_TO_18 = Object.freeze(
  [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
    Object.freeze({
      weekday,
      intervals:
        weekday <= 5
          ? Object.freeze([
              Object.freeze({ start: '09:00', end: '12:00' }),
              Object.freeze({ start: '13:00', end: '18:00' }),
            ])
          : Object.freeze([]),
    }),
  ),
);

/**
 * `PUT /api/professionals/:id/hours` com `{ days }`. Devolve a resposta crua (sem checar status).
 * @returns {Promise<import('light-my-request').Response>}
 */
export function putHours(app, cookies, professionalId, days, { headers = {} } = {}) {
  return app.inject({
    method: 'PUT',
    url: `/api/professionals/${professionalId}/hours`,
    cookies,
    headers,
    payload: { days },
  });
}

/**
 * `POST /api/time-blocks`. Devolve a resposta crua (sem checar status).
 * @returns {Promise<import('light-my-request').Response>}
 */
export function postTimeBlock(app, cookies, body, { headers = {}, remoteAddress } = {}) {
  const options = { method: 'POST', url: '/api/time-blocks', cookies, headers, payload: body };
  if (remoteAddress) options.remoteAddress = remoteAddress;
  return app.inject(options);
}

/**
 * `GET /api/time-blocks` com a query dada. Devolve a resposta crua.
 * @param {Record<string, string>} [query]
 * @returns {Promise<import('light-my-request').Response>}
 */
export function listTimeBlocks(app, cookies, query = {}) {
  return app.inject({ method: 'GET', url: '/api/time-blocks', cookies, query });
}

/**
 * `DELETE /api/time-blocks/:id`. Devolve a resposta crua.
 * @returns {Promise<import('light-my-request').Response>}
 */
export function deleteTimeBlock(app, cookies, id, { headers = {} } = {}) {
  return app.inject({ method: 'DELETE', url: `/api/time-blocks/${id}`, cookies, headers });
}

/** Troca o fuso do negócio direto no banco (o fuso não é editável pela API). */
export async function setBusinessTimezone(app, businessId, timeZone) {
  await app.db.run('UPDATE businesses SET timezone = ? WHERE id = ?', [timeZone, businessId]);
}

/**
 * `GET /api/public/:slug/availability` com a query dada (AF-10). Sem cookie por padrão.
 * Devolve a resposta crua (sem checar status).
 * @param {Record<string, string|string[]>} [query]
 * @param {{ cookies?: object, remoteAddress?: string, headers?: object }} [options]
 * @returns {Promise<import('light-my-request').Response>}
 */
export function getAvailability(app, slug, query = {}, { cookies, remoteAddress, headers } = {}) {
  const options = { method: 'GET', url: `/api/public/${slug}/availability`, query };
  if (cookies) options.cookies = cookies;
  if (remoteAddress) options.remoteAddress = remoteAddress;
  if (headers) options.headers = headers;
  return app.inject(options);
}
