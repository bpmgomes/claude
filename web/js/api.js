export const GENERIC_ERROR_MESSAGE = 'Não foi possível concluir agora. Verifique sua conexão e tente novamente.';

/**
 * Wrapper de fetch JSON. Nunca lança: erros de rede (e a consulta abortada por `signal`) viram
 * { ok: false, status: 0 }.
 * @param {string} url
 * `credentials`: padrão `same-origin` (telas do dono, que dependem do cookie). O JS público
 * (`web/js/public-*.js`) passa sempre `'omit'` (AF-10 item 5, AF-04 critério 16).
 * @param {{ method?: string, body?: unknown, fetchFn?: typeof fetch, signal?: AbortSignal, credentials?: RequestCredentials }} [options]
 * @returns {Promise<{ ok: boolean, status: number, body: any, error: { code: string, message: string, fields?: Record<string,string> } | null }>}
 */
export async function requestJson(
  url,
  { method = 'GET', body, fetchFn = globalThis.fetch, signal, credentials = 'same-origin' } = {},
) {
  let response;
  try {
    const init = { method, credentials, headers: { Accept: 'application/json' } };
    if (signal) init.signal = signal;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    response = await fetchFn(url, init);
  } catch {
    return { ok: false, status: 0, body: null, error: { code: 'NETWORK_ERROR', message: GENERIC_ERROR_MESSAGE } };
  }
  return parseResponse(response);
}

async function parseResponse(response) {
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (response.ok) return { ok: true, status: response.status, body: parsed, error: null };

  const error =
    parsed && parsed.error && typeof parsed.error.code === 'string'
      ? parsed.error
      : { code: 'UNKNOWN_ERROR', message: GENERIC_ERROR_MESSAGE };
  return { ok: false, status: response.status, body: parsed, error };
}

/**
 * Envia um corpo binário (ex.: o File do logo). Mesmo contrato de `requestJson`: nunca lança.
 * @returns {Promise<{ ok: boolean, status: number, body: any, error: { code: string, message: string, fields?: Record<string,string> } | null }>}
 */
export async function requestBinary(
  url,
  { method = 'PUT', body, contentType = 'application/octet-stream', fetchFn = globalThis.fetch } = {},
) {
  let response;
  try {
    response = await fetchFn(url, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': contentType },
      body,
    });
  } catch {
    return { ok: false, status: 0, body: null, error: { code: 'NETWORK_ERROR', message: GENERIC_ERROR_MESSAGE } };
  }
  return parseResponse(response);
}
