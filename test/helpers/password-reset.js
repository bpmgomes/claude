// Helpers dos testes do AF-03 (recuperação de senha, design 6).
import { emailTestApp } from './email.js';
import { TEST_PASSWORD } from './session.js';

export const RESET_LINK_RE = /https?:\/\/[^\s"<>]+\/redefinir-senha#token=([A-Za-z0-9_-]{43})/;
export const REQUESTED = 'Se este e-mail estiver cadastrado, enviaremos um link para redefinir a senha. O link vale por 1 hora.';
export const LINK_INVALID = 'Link inválido ou expirado. Peça um novo link.';
export const NEW_PASSWORD = 'nova1234senha';

/**
 * App do AF-18 (`emailTestApp`: transporte de memória, laço do worker desligado, relógio controlável,
 * bcrypt custo 4) com `trustProxy` ligado, para `withIp` escolher o IP por `X-Forwarded-For`.
 */
export function resetTestApp(overrides = {}) {
  return emailTestApp({ trustProxy: true, ...overrides });
}

/** Cabeçalho que faz o pedido vir do IP dado (com `trustProxy: true`). */
export function withIp(ip) {
  return { 'x-forwarded-for': ip };
}

/** `POST /api/auth/password-reset`. Resposta crua. */
export function requestReset(app, email, { headers = {}, cookies, payload } = {}) {
  const options = { method: 'POST', url: '/api/auth/password-reset', headers, payload: payload ?? { email } };
  if (cookies) options.cookies = cookies;
  return app.inject(options);
}

/** `POST /api/auth/password-reset/confirm`. Resposta crua. */
export function confirmReset(app, body, { headers = {}, cookies } = {}) {
  const options = { method: 'POST', url: '/api/auth/password-reset/confirm', headers, payload: body };
  if (cookies) options.cookies = cookies;
  return app.inject(options);
}

/** Corpo da redefinição com a mesma senha nos dois campos. */
export function resetBody(token, password = NEW_PASSWORD) {
  return { token, password, passwordConfirmation: password };
}

/** Link de redefinição do texto da mensagem (ou null). */
export function resetLinkFrom(message) {
  const m = RESET_LINK_RE.exec(String(message?.text ?? ''));
  return m ? m[0] : null;
}

/** Token do link de redefinição da mensagem (ou null). */
export function resetTokenFrom(message) {
  const m = RESET_LINK_RE.exec(String(message?.text ?? ''));
  return m ? m[1] : null;
}

/** Status, corpo e cabeçalhos da resposta, sem `date` (critério 2: comparação byte a byte). */
export function responseFingerprint(res) {
  const headers = { ...res.headers };
  delete headers.date;
  delete headers['request-id'];
  delete headers['x-request-id'];
  return { status: res.statusCode, body: res.body, headers };
}

/** `POST /api/auth/login`. Resposta crua. */
export function login(app, email, password = TEST_PASSWORD, { headers = {} } = {}) {
  return app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email, password } });
}

/** Mensagens do transporte para o endereço. */
export function mailsTo(transport, email) {
  return transport.messages.filter((m) => m.to === email);
}

/** Pede o link e drena o worker; devolve o token da última mensagem de redefinição para o e-mail. */
export async function requestAndSend(app, transport, email, { headers } = {}) {
  const res = await requestReset(app, email, { headers });
  if (res.statusCode !== 202) throw new Error(`pedido: ${res.statusCode} ${res.body}`);
  await app.services.emailWorker.runOnce();
  const mine = mailsTo(transport, email).filter((m) => resetTokenFrom(m));
  return resetTokenFrom(mine.at(-1));
}
