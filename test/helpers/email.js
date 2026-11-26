// Helpers dos testes do AF-18 (e-mail de confirmação, design 6).
import { buildTestApp } from './test-app.js';
import { createClock } from './clock.js';
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } from './session.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';

export const NOW = '2026-11-26T12:00:00.000Z';
export const FRIDAY = '2026-11-27';
const LINK_RE = /https?:\/\/[^\s"<>]+\/agendamento\/([A-Za-z0-9_-]{43})/;

/**
 * App de teste com transporte de memória (injetado: ativo) e o laço do worker DESLIGADO: os testes
 * chamam `drain(app)` / `app.services.emailWorker.runOnce()`. Relógio controlável.
 * @returns {Promise<{ app: import('fastify').FastifyInstance, logs: () => string, transport: ReturnType<typeof createMemoryMailTransport>, clock: ReturnType<typeof createClock> }>}
 */
export async function emailTestApp(overrides = {}) {
  const clock = overrides.clock ?? createClock(NOW);
  const transport = overrides.mailTransport ?? createMemoryMailTransport();
  const { clock: _c, ...rest } = overrides;
  const { app, logs } = await buildTestApp({
    now: clock.now,
    mailTransport: transport,
    email: { worker: { enabled: false, intervalMs: 15_000 } },
    ...rest,
  });
  return { app, logs, transport, clock };
}

/** Negócio com um serviço de 60 min e dois profissionais com grade 9h-18h. */
export async function seedBusiness(app, { email = 'ana@x.com', name = 'Salão da Ana', slug, serviceName = 'Corte', price = '50', professionals = ['Ana Souza', 'Bia Lima'] } = {}) {
  const cookies = await signupAndLogin(app, { email });
  const input = { name };
  if (slug) input.slug = slug;
  const business = await createBusinessFor(app, cookies, input);
  const service = await createService(app, cookies, { name: serviceName, durationMinutes: 60, price });
  const pros = [];
  for (const pname of professionals) {
    const p = await createProfessional(app, cookies, { name: pname, serviceIds: [service.id] });
    const res = await putHours(app, cookies, p.id, WEEK_9_TO_18);
    if (res.statusCode !== 200) throw new Error(`grade: ${res.body}`);
    pros.push(p);
  }
  return { cookies, business, slug: business.slug, service, professionals: pros };
}

/** `runOnce` até nada mais ser reivindicado. @returns {Promise<object[]>} os resumos */
export async function drain(app, { max = 20 } = {}) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const summary = await app.services.emailWorker.runOnce();
    out.push(summary);
    if (summary.claimed === 0) break;
  }
  return out;
}

/** Linhas da fila em ordem de criação. */
export function outboxRows(db, where = {}) {
  const keys = Object.keys(where);
  const sql = `SELECT * FROM email_outbox${keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : ''} ORDER BY created_at, rowid`;
  return db.all(sql, keys.map((k) => where[k]));
}

export async function countOutbox(db) {
  return Number((await db.get('SELECT COUNT(*) AS n FROM email_outbox')).n);
}

/** Link de gerenciar do texto puro da mensagem (ou null). */
export function linkFrom(message) {
  const m = LINK_RE.exec(String(message?.text ?? ''));
  return m ? m[0] : null;
}

/** Token do link da mensagem (ou null). */
export function tokenFrom(message) {
  const m = LINK_RE.exec(String(message?.text ?? ''));
  return m ? m[1] : null;
}

/** Conteúdo do anexo .ics da mensagem. */
export function icsOf(message) {
  return message.attachments.find((a) => a.filename === 'agendamento.ics')?.content ?? null;
}

/**
 * Analisador mínimo de iCalendar (design 6): recusa LF sem CR e linha física acima de 75 octetos,
 * desdobra continuações e separa nome, parâmetros e valor.
 * @returns {{ lines: Array<{ name: string, params: Record<string, string>, value: string }>, get: (name: string) => string|undefined, all: (name: string) => string[] }}
 */
export function parseIcs(text) {
  if (!text.endsWith('\r\n')) throw new Error('ics: não termina em CRLF');
  if (/[^\r]\n/.test(text) || text.startsWith('\n')) throw new Error('ics: LF sem CR');
  const physical = text.slice(0, -2).split('\r\n');
  for (const line of physical) {
    if (Buffer.byteLength(line, 'utf8') > 75) throw new Error(`ics: linha acima de 75 octetos: ${line}`);
  }
  const logical = [];
  for (const line of physical) {
    if (line.startsWith(' ')) {
      if (logical.length === 0) throw new Error('ics: continuação sem linha');
      logical[logical.length - 1] += line.slice(1);
    } else logical.push(line);
  }
  const lines = logical.map((line) => {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error(`ics: linha sem ':': ${line}`);
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const params = Object.fromEntries(paramParts.map((p) => p.split('=')));
    return { name, params, value: line.slice(colon + 1) };
  });
  return {
    lines,
    get: (name) => lines.find((l) => l.name === name)?.value,
    all: (name) => lines.filter((l) => l.name === name).map((l) => l.value),
  };
}

/** Desfaz o escape TEXT do iCalendar. */
export function unescapeIcsText(value) {
  return String(value).replace(/\\([\\;,nN])/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Objetos JSON das linhas do log capturado. */
export function logEntries(logs) {
  return logs()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
