// Configuração do e-mail (AF-18, design 2.2): `resolveEmailConfig` decide e valida o transporte a
// partir do que `loadConfig` leu (que nunca lança por causa do e-mail); `createMailTransport` cria o
// adaptador. Padrão de `resolveConflictsTokenSecret`: lista de permitidos e mensagens fixas, SEM
// eco do valor recebido. A senha SMTP nunca entra no objeto devolvido.
import { existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSafeAddress, FROM_NAME_MAX } from './message.js';
import { createFileMailTransport } from './transports/file.js';
import { createMemoryMailTransport } from './transports/memory.js';
import { createSmtpTransport } from './transports/smtp.js';

export const EMAIL_TRANSPORTS = Object.freeze(['memory', 'file', 'smtp', 'none']);
export const EMAIL_FROM_DEFAULT = 'nao-responda@agendafacil.invalid';
export const EMAIL_FROM_NAME_DEFAULT = 'AgendaFácil';
export const EMAIL_WORKER_INTERVAL_MIN_MS = 100;
export const EMAIL_WORKER_INTERVAL_MAX_MS = 3_600_000;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
/** = DEV_TEST_ENVS de src/config.js (cópia: config.js reexporta este módulo; teste confere). */
export const EMAIL_DEV_TEST_ENVS = Object.freeze(['development', 'test']);
const DEV_TEST_ENVS = EMAIL_DEV_TEST_ENVS;

/** Raiz do repositório (para a regra de EMAIL_FILE_DIR). */
export const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));

export const EMAIL_CONFIG_MESSAGES = Object.freeze({
  transportInvalid: 'EMAIL_TRANSPORT inválido. Use memory, file, smtp ou none.',
  devOnly: `EMAIL_TRANSPORT=memory e file só são permitidos com NODE_ENV em ${DEV_TEST_ENVS.join(', ')}.`,
  fromRequired: 'EMAIL_FROM é obrigatório e precisa ser um endereço válido com EMAIL_TRANSPORT=smtp.',
  fromInvalid: 'EMAIL_FROM precisa ser um endereço válido.',
  hostInvalid: 'SMTP_HOST e SMTP_PORT precisam ser válidos com EMAIL_TRANSPORT=smtp.',
  authPair: 'Informe SMTP_USER e SMTP_PASSWORD juntos, ou nenhum dos dois.',
  httpsRequired: 'PUBLIC_BASE_URL precisa usar https com EMAIL_TRANSPORT=smtp.',
  fromNameInvalid: 'EMAIL_FROM_NAME inválido.',
  intervalInvalid: 'EMAIL_WORKER_INTERVAL_MS fora do intervalo permitido.',
  fileDirInvalid: 'EMAIL_FILE_DIR precisa ficar fora do repositório ou dentro de data/, e fora de UPLOADS_DIR.',
});
const MSG = EMAIL_CONFIG_MESSAGES;

/**
 * Caminho real: `realpath` do ancestral mais próximo que existe (o diretório do `.eml` pode ainda não
 * existir; o adaptador o cria), mais o resto. Links simbólicos não escapam da regra (I1).
 * @param {string} p
 * @returns {string}
 */
export function realResolve(p) {
  let current = resolve(String(p));
  const rest = [];
  for (;;) {
    if (existsSync(current)) {
      let real;
      try {
        real = realpathSync.native(current);
      } catch {
        real = current;
      }
      return rest.length ? join(real, ...rest.reverse()) : real;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(String(p));
    rest.push(basename(current));
    current = parent;
  }
}

/** `child` é `parent` ou fica dentro dele. */
function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Regra de EMAIL_FILE_DIR (design 2.2, critério 25; I1 da revisão): pelo caminho REAL, fora do
 * repositório ou dentro de `data/`, e nunca em `uploadsDir` nem abaixo dele (de onde `/media`
 * serve arquivos).
 * @param {string} dir
 * @param {{ root?: string, uploadsDir?: string|null }} [options]
 * @returns {boolean}
 */
export function isAllowedFileDir(dir, { root = REPO_ROOT, uploadsDir = null } = {}) {
  const abs = realResolve(dir);
  const realRoot = realResolve(root);
  if (uploadsDir && isWithin(abs, realResolve(uploadsDir))) return false;
  if (!isWithin(abs, realRoot)) return true;
  const rel = relative(realRoot, abs);
  return rel === 'data' || rel.startsWith(`data${sep}`);
}

/**
 * @typedef {{
 *   enabled: boolean, transport: 'memory'|'file'|'smtp'|'none'|'injected',
 *   from: { name: string, address: string }, messageIdDomain: string, fileDir: string,
 *   smtp: { host: string|null, port: number|null, secure: boolean, user: string|null },
 *   worker: { enabled: boolean, intervalMs: number }, requireHttps: boolean,
 * }} EmailConfig
 * @param {{ email?: object, nodeEnv?: string|null, publicBaseUrl?: string }} config `mergeConfig(loadConfig(), overrides)`
 * @param {{ injected?: boolean }} [options] `injected`: há `mailTransport` nos overrides (testes)
 * @returns {EmailConfig}
 * @throws {Error} mensagens de EMAIL_CONFIG_MESSAGES (nunca com o valor recebido)
 */
export function resolveEmailConfig(config, { injected = false } = {}) {
  const e = config?.email ?? {};
  const nodeEnv = config?.nodeEnv ?? null;
  const devTest = DEV_TEST_ENVS.includes(nodeEnv);

  let transport;
  if (injected) transport = 'injected';
  else if (e.transport === null || e.transport === undefined) {
    transport = nodeEnv === 'development' ? 'file' : nodeEnv === 'test' ? 'memory' : 'none';
  } else if (EMAIL_TRANSPORTS.includes(e.transport)) transport = e.transport;
  else throw new Error(MSG.transportInvalid);
  if ((transport === 'memory' || transport === 'file') && !devTest) throw new Error(MSG.devOnly);

  const fromName = e.fromName === undefined || e.fromName === null ? EMAIL_FROM_NAME_DEFAULT : e.fromName;
  if (
    typeof fromName !== 'string' ||
    fromName.trim() === '' ||
    [...fromName].length > FROM_NAME_MAX ||
    /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(fromName)
  ) {
    throw new Error(MSG.fromNameInvalid);
  }

  const worker = e.worker ?? {};
  const intervalMs = worker.intervalMs === undefined || worker.intervalMs === null ? 15_000 : worker.intervalMs;
  if (!Number.isInteger(intervalMs) || intervalMs < EMAIL_WORKER_INTERVAL_MIN_MS || intervalMs > EMAIL_WORKER_INTERVAL_MAX_MS) {
    throw new Error(MSG.intervalInvalid);
  }
  const workerEnabled = worker.enabled === undefined ? true : Boolean(worker.enabled);

  let fromAddress;
  if (e.from === null || e.from === undefined || e.from === '') {
    if (transport === 'smtp') throw new Error(MSG.fromRequired);
    fromAddress = EMAIL_FROM_DEFAULT;
  } else {
    fromAddress = toSafeAddress(e.from);
    if (!fromAddress) throw new Error(transport === 'smtp' ? MSG.fromRequired : MSG.fromInvalid);
  }

  const smtpIn = e.smtp ?? {};
  const secure = Boolean(smtpIn.secure);
  let smtp = { host: null, port: null, secure, user: null };
  if (transport === 'smtp') {
    const host = smtpIn.host;
    const port = smtpIn.port === null || smtpIn.port === undefined ? (secure ? 465 : 587) : smtpIn.port;
    if (typeof host !== 'string' || !HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(MSG.hostInvalid);
    }
    const hasUser = typeof smtpIn.user === 'string' && smtpIn.user !== '';
    const hasPassword = typeof config?.smtpPassword === 'string' && config.smtpPassword !== '';
    if (hasUser !== hasPassword) throw new Error(MSG.authPair);
    if (!devTest && !String(config?.publicBaseUrl ?? '').startsWith('https://')) throw new Error(MSG.httpsRequired);
    smtp = { host, port, secure, user: hasUser ? smtpIn.user : null };
  }

  const fileDir = resolve(String(e.fileDir || './data/emails'));
  if (transport === 'file' && !isAllowedFileDir(fileDir, { uploadsDir: config?.uploadsDir ? resolve(String(config.uploadsDir)) : null })) {
    throw new Error(MSG.fileDirInvalid);
  }

  return {
    enabled: transport !== 'none' && workerEnabled,
    transport,
    from: { name: fromName.trim(), address: fromAddress },
    messageIdDomain: fromAddress.slice(fromAddress.indexOf('@') + 1),
    fileDir,
    smtp,
    worker: { enabled: workerEnabled, intervalMs },
    requireHttps: transport === 'smtp' && !devTest,
  };
}

/**
 * Adaptador do transporte resolvido (`null` em `none`). A senha só passa por aqui.
 * @param {ReturnType<typeof resolveEmailConfig>} emailConfig
 * @param {{ smtpPassword?: string|null, now?: () => Date }} [options]
 * @returns {import('./mail-transport.js').MailTransport|null}
 */
export function createMailTransport(emailConfig, { smtpPassword = null, now = () => new Date() } = {}) {
  switch (emailConfig.transport) {
    case 'memory':
      return createMemoryMailTransport();
    case 'file':
      return createFileMailTransport({ dir: emailConfig.fileDir, now });
    case 'smtp':
      return createSmtpTransport({ ...emailConfig.smtp, password: smtpPassword });
    default:
      return null;
  }
}
