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
