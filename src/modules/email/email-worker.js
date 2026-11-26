// Worker de envio de e-mails (AF-18, design 4.3 e 5, critérios 7 a 11, 26, 27 e 29). Roda no
// processo da API: laço de setTimeout encadeado (com unref), ligado no `onListen` e parado no
// `onClose`, acordado pela porta de eventos pós-commit. Cada linha é REIVINDICADA por UPDATE
// condicional com `changes === 1` (vale para mais de uma instância). O envio roda fora de transação,
// com teto rígido de tempo. Logs só com `event`, id da linha, `kind`, tentativa e `errCode`/`errName`:
// nunca endereço, nome, assunto, corpo, link, token, `businessId`, `appointmentId` nem resposta SMTP.
import {
  EMAIL_KIND_CANCELLED,
  EMAIL_KIND_RESCHEDULED,
  EMAIL_MAX_SENDS,
  EMAIL_LEASE_MS,
  EMAIL_SEND_TIMEOUT_MS,
  EMAIL_PENDING_MAX_AGE_DAYS,
  EMAIL_RETENTION_DAYS,
  EMAIL_RECIPIENT_WINDOW_HOURS,
  EMAIL_RECIPIENT_MAX,
  EMAIL_BATCH_SIZE,
  EMAIL_PURGE_BATCH,
  EMAIL_PURGE_CYCLE_BATCH,
  EMAIL_MISCONFIGURED_CODES,
  retryDelayMs,
} from './email-rules.js';
import { TransientMailError, PermanentMailError } from './mail-transport.js';
import { buildMailMessage, messageIdOf, toSafeAddress } from './message.js';
import { renderAppointmentEmail } from './templates/appointment-email.js';
import { RESCHEDULES_PER_CHAIN_MAX, APPOINTMENT_STATUS_CONFIRMED, APPOINTMENT_STATUS_CANCELLED } from '../../shared/appointments.js';

const noopLog = { info() {}, warn() {}, error() {} };
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

const emptySummary = () => ({ claimed: 0, sent: 0, retried: 0, failed: 0, skipped: 0, expired: 0, leaseLost: 0, errors: 0, full: false });

/** Qualquer erro do envio vira uma das duas classes; o resto é temporário `unknown`. */
function normalizeError(err) {
  if (err instanceof TransientMailError || err instanceof PermanentMailError) return err;
  return new TransientMailError('unknown');
}

/**
 * @typedef {{ claimed: number, sent: number, retried: number, failed: number, skipped: number,
 *   expired: number, leaseLost: number, errors: number, full: boolean }} RunSummary
 * `errors`: linhas cujo preparo ou registro lançou (a transação voltou; a linha fica como estava).
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   outbox: ReturnType<typeof import('./email-outbox.repository.js').createEmailOutboxRepository>,
 *   appointmentsRepository: object, businessesRepository: object, customersRepository: object,
 *   reschedulesRepository: object, manageTokensRepository: object,
 *   tokenIssuer: ReturnType<typeof import('../appointments/manage-token-issuer.js').createManageTokenIssuer>,
 *   mailTransport: import('./mail-transport.js').MailTransport|null,
 *   emailConfig: { from: { name: string, address: string }, messageIdDomain: string, requireHttps: boolean },
 *   publicBaseUrl: string,
 *   enabled: boolean, intervalMs: number, batchSize?: number,
 *   render?: typeof renderAppointmentEmail,
 *   now?: () => Date, random?: () => number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 *   sendTimeoutMs?: number, leaseMs?: number,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createEmailWorker(deps) {
  const {
    db,
    outbox,
    appointmentsRepository,
    businessesRepository,
    customersRepository,
    reschedulesRepository,
    manageTokensRepository,
    tokenIssuer,
    mailTransport,
    emailConfig,
    publicBaseUrl,
    enabled,
    intervalMs,
    batchSize = EMAIL_BATCH_SIZE,
    render = renderAppointmentEmail,
    now = () => new Date(),
    random = Math.random,
    timers = { setTimeout, clearTimeout },
    sendTimeoutMs = EMAIL_SEND_TIMEOUT_MS,
    leaseMs = EMAIL_LEASE_MS,
    log = noopLog,
  } = deps;

  let started = false;
  let stopped = false;
  let timer = null;
  let rerun = false;
  let looping = false;
  /** Um ciclo por vez por instância: o laço e `runOnce` passam pela mesma fila. */
  let chain = Promise.resolve();
  let signalStop;
  const stopSignal = new Promise((resolve) => {
    signalStop = resolve;
  });

  function exclusive(fn) {
    const p = chain.then(fn);
    chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  function logFailure(event, err) {
    log.error({ event, errCode: err?.code, errName: err?.name });
  }

  /**
   * Envio com teto rígido; a promessa nunca rejeita (devolve o erro normalizado ou `aborted`). No
   * teto e no `stop()`, o `AbortSignal` passado ao adaptador é disparado: o SMTP fecha a conexão
   * (B3), em vez de deixá-la aberta até os timeouts de socket.
   */
  async function sendWithTimeout(message) {
    let handle;
    const controller = new AbortController();
    const timeout = new Promise((resolve) => {
      handle = timers.setTimeout(() => resolve({ error: new TransientMailError('send_timeout', { maybeDelivered: true }) }), sendTimeoutMs);
      handle?.unref?.();
    });
    const sending = (async () => mailTransport.send(message, { signal: controller.signal }))().then(
      () => ({ error: null, settled: true }),
      (err) => ({ error: normalizeError(err), settled: true }),
    );
    let outcome;
    try {
      outcome = await Promise.race([sending, timeout, stopSignal.then(() => ({ aborted: true }))]);
      return outcome;
    } finally {
      timers.clearTimeout(handle);
      // Venceu o teto ou o stop: o envio ainda corre no adaptador e precisa ser interrompido.
      if (!outcome?.settled) controller.abort();
    }
  }

  /** 5.2: preparo numa transação (só `tx`). @returns {Promise<object>} */
  function prepare(id, nowMs, lease) {
    const nowIso = iso(nowMs);
    return db.transaction(async (tx) => {
      const { changes } = await outbox.claim(id, { nowIso, lockedUntil: lease.lockedUntil }, tx);
      if (changes !== 1) return { action: 'taken' };
      const row = await outbox.findById(id, tx);
      lease.attempts = row.attempts;
      const skip = async (reason) => {
        await outbox.markSkipped(id, lease, { reason, nowIso }, tx);
        return { action: 'skipped', row, code: reason };
      };
      const fail = async (code) => {
        await outbox.markFailed(id, lease, { errorCode: code, nowIso }, tx);
        return { action: 'failed', row, code };
      };
      // Releitura pelo business_id DA LINHA (critério 29).
      const businessId = row.businessId;
      const business = await businessesRepository.findById(businessId, tx);
      const appointment = await appointmentsRepository.findById(row.appointmentId, businessId, tx);
      const previous =
        row.kind === EMAIL_KIND_RESCHEDULED ? await appointmentsRepository.findById(row.previousAppointmentId, businessId, tx) : null;
      if (!business || !appointment || (row.kind === EMAIL_KIND_RESCHEDULED && !previous)) return skip('missing');
      // Reavaliação (critério 10): nada de e-mail com estado velho.
      if (row.kind === EMAIL_KIND_CANCELLED) {
        if (appointment.status !== APPOINTMENT_STATUS_CANCELLED) return skip('not_cancelled');
      } else if (appointment.status !== APPOINTMENT_STATUS_CONFIRMED) return skip('not_confirmed');
      if (appointment.endsAt <= nowIso) return skip('ended');
      // Endereço lido de customers só agora (critério 27).
      const customer = await customersRepository.findById(appointment.customerId, businessId, tx);
      if (!customer) return skip('missing');
      const to = toSafeAddress(customer.email);
      if (!to) return fail('invalid_header');
      const recent = await outbox.countRecentToRecipient(
        customer.email,
        { sinceIso: iso(nowMs - EMAIL_RECIPIENT_WINDOW_HOURS * HOUR_MS), excludeId: id },
        tx,
      );
      if (recent >= EMAIL_RECIPIENT_MAX) return skip('recipient_limited');
      // Cadeia: posição do agendamento e raiz (UID do .ics, critério 21).
      const sequence = await reschedulesRepository.sequenceOf(appointment.id, businessId, tx);
      let rootAppointmentId = appointment.id;
      for (let hop = 0; hop < RESCHEDULES_PER_CHAIN_MAX; hop++) {
        const before = await reschedulesRepository.previousOf(rootAppointmentId, businessId, tx);
        if (!before) break;
        rootAppointmentId = before;
      }
      // Token novo no envio (critério 11); o cancelamento não emite.
      const token =
        row.kind === EMAIL_KIND_CANCELLED
          ? null
          : await tokenIssuer.issue(tx, {
              businessId,
              appointmentId: appointment.id,
              expiresAt: appointment.endsAt,
              status: APPOINTMENT_STATUS_CONFIRMED,
              nowIso,
            });
      return { action: 'send', row, business, appointment, previous, to, chain: { rootAppointmentId, sequence }, token };
    });
  }

  /** 5.3: registro numa transação, com o arrendamento. @returns {Promise<'recorded'|'lost'>} */
  function record(prep, lease, nowMs, error) {
    const { row, token } = prep;
    const nowIso = iso(nowMs);
    return db.transaction(async (tx) => {
      let result;
      if (!error) result = await outbox.markSent(row.id, lease, nowIso, tx);
      else if (error instanceof TransientMailError && lease.attempts < EMAIL_MAX_SENDS) {
        const nextAttemptAt = iso(nowMs + retryDelayMs(lease.attempts, random));
        result = await outbox.markRetry(row.id, lease, { nextAttemptAt, errorCode: error.code, nowIso, maybeDelivered: error.maybeDelivered }, tx);
      } else result = await outbox.markFailed(row.id, lease, { errorCode: error.code, nowIso, maybeDelivered: Boolean(error?.maybeDelivered) }, tx);
      if (result.changes !== 1) return 'lost';
      // Token de um envio que falhou e não pode ter chegado: apagado, para retentativas não
      // empurrarem para fora do teto o link da tela de sucesso (decisão 5 do Gerente).
      if (error && token && !error.maybeDelivered) {
        await manageTokensRepository.deleteByHash(row.businessId, token.tokenHash, tx);
      }
      return 'recorded';
    });
  }

  async function processOne(id, summary) {
    const nowMs = now().getTime();
    const lease = { lockedUntil: iso(nowMs + leaseMs), attempts: 0 };
    const prep = await prepare(id, nowMs, lease);
    if (prep.action === 'taken') return;
    summary.claimed += 1;
    const base = { outboxId: id, kind: prep.row.kind };
    if (prep.action === 'skipped') {
      summary.skipped += 1;
      log.info({ event: 'email_skipped', ...base, errCode: prep.code });
      return;
    }
    if (prep.action === 'failed') {
      summary.failed += 1;
      log.warn({ event: 'email_failed', ...base, attempt: lease.attempts, errCode: prep.code, errName: 'PermanentMailError' });
      return;
    }
    if (stopped) return;

    let error = null;
    let message = null;
    try {
      const rendered = render({
        kind: prep.row.kind,
        business: prep.business,
        appointment: prep.appointment,
        previous: prep.previous ?? undefined,
        chain: prep.chain,
        manageUrl: prep.token?.url,
        publicBaseUrl,
        nowMs,
        requireHttps: Boolean(emailConfig.requireHttps),
      });
      message = buildMailMessage({
        rendered,
        to: prep.to,
        from: emailConfig.from,
        messageId: messageIdOf(id, emailConfig.messageIdDomain),
        date: now(),
      });
    } catch (err) {
      error = err instanceof PermanentMailError ? err : new PermanentMailError('render_failed');
    }
    if (!error) {
      const outcome = await sendWithTimeout(message);
      // Depois de stop() o worker não toca mais no banco: a linha fica `sending` até vencer (5.5).
      if (outcome.aborted || stopped) return;
      error = outcome.error;
    }
    message = null;
    if (stopped) return;

    const recorded = await record(prep, lease, nowMs, error);
    const withAttempt = { ...base, attempt: lease.attempts };
    if (recorded === 'lost') {
      summary.leaseLost += 1;
      log.warn({ event: 'email_lease_lost', ...withAttempt });
      return;
    }
    if (!error) {
      summary.sent += 1;
      log.info({ event: 'email_sent', ...withAttempt });
      return;
    }
    const errFields = { errCode: error.code, errName: error.name };
    if (EMAIL_MISCONFIGURED_CODES.includes(error.code)) {
      // Autenticação, remetente e TLS: configuração, igual para todas as mensagens (decisão 3).
      log.error({ event: 'email_transport_misconfigured', ...errFields });
    }
    if (error instanceof TransientMailError && lease.attempts < EMAIL_MAX_SENDS) {
      summary.retried += 1;
      log.warn({ event: 'email_retry', ...withAttempt, ...errFields });
    } else {
      summary.failed += 1;
      log.warn({ event: 'email_failed', ...withAttempt, ...errFields });
    }
  }

  /** Expiração (7 dias) e arrendamentos esgotados. */
  async function expireAndExhaust(nowMs, summary) {
    const nowIso = iso(nowMs);
    const expired = await outbox.expireStale(iso(nowMs - EMAIL_PENDING_MAX_AGE_DAYS * DAY_MS), nowIso);
    if (expired > 0) log.info({ event: 'email_expired', count: expired });
    const exhausted = await outbox.failExhausted(nowIso);
    if (exhausted > 0) log.warn({ event: 'email_failed', errCode: 'lease_expired', count: exhausted });
    if (summary) {
      summary.expired += expired;
      summary.failed += exhausted;
    }
  }

  /** 5.1: um ciclo completo. Nunca lança. @returns {Promise<RunSummary>} */
  async function cycle() {
    const summary = emptySummary();
    if (stopped || !mailTransport) return summary;
    try {
      const nowMs = now().getTime();
      await expireAndExhaust(nowMs, summary);
      const ids = await outbox.findCandidates(iso(nowMs), batchSize);
      summary.full = ids.length >= batchSize;
      for (const id of ids) {
        if (stopped) break;
        try {
          await processOne(id, summary);
        } catch (err) {
          summary.errors += 1;
          logFailure('email_worker_failed', err);
        }
      }
      if (!stopped) {
        const purged = await outbox.purgeTerminal(iso(now().getTime() - EMAIL_RETENTION_DAYS * DAY_MS), {
          batch: EMAIL_PURGE_CYCLE_BATCH,
        });
        if (purged > 0) log.info({ event: 'email_outbox_purged', count: purged });
      }
    } catch (err) {
      summary.errors += 1;
      if (!stopped) logFailure('email_worker_failed', err);
    }
    return summary;
  }

  /**
   * Lote cheio só reagenda já se o ciclo AVANÇOU alguma linha e nada lançou (B1): com linhas que
   * outro worker levou (`taken`) ou com preparo que lança (a linha volta a `pending` sem consumir
   * tentativa), reagendar com 0 seria um laço quente sobre os mesmos candidatos. Nesses casos vale
   * `intervalMs`. `rerun` (acordado por escrita durante o ciclo) continua imediato: vem de fora.
   */
  function shouldContinue(summary) {
    return summary.full && summary.claimed > 0 && summary.errors === 0;
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(tick, ms);
    timer?.unref?.();
  }

  function tick() {
    timer = null;
    if (stopped) return;
    if (looping) {
      rerun = true;
      return;
    }
    looping = true;
    rerun = false;
    exclusive(cycle).then(
      (summary) => {
        looping = false;
        schedule(rerun || shouldContinue(summary) ? 0 : intervalMs);
      },
      () => {
        looping = false;
        schedule(intervalMs);
      },
    );
  }

  /** Pede um ciclo já (sem efeito se não iniciado). */
  function wake() {
    if (!started || stopped) return;
    if (looping) {
      rerun = true;
      return;
    }
    schedule(0);
  }

  const events = Object.freeze({
    confirmed: async () => wake(),
    cancelled: async () => wake(),
    rescheduled: async () => wake(),
  });

  return {
    /** Agenda o laço; sem efeito se desligado, sem transporte ou já iniciado. O 1º ciclo é imediato. */
    start() {
      if (!enabled || !mailTransport || started || stopped) return;
      started = true;
      schedule(0);
    },

    /**
     * Para de agendar, espera o ciclo em curso até `graceMs` e fecha o transporte. Um envio em curso
     * é abandonado: a linha fica `sending` e é recuperada quando o arrendamento vencer.
     */
    async stop({ graceMs = 5000 } = {}) {
      stopped = true;
      if (timer) {
        timers.clearTimeout(timer);
        timer = null;
      }
      signalStop();
      let graceTimer;
      await Promise.race([
        chain,
        new Promise((resolve) => {
          graceTimer = setTimeout(resolve, graceMs);
          graceTimer.unref?.();
        }),
      ]);
      clearTimeout(graceTimer);
      try {
        await mailTransport?.close?.();
      } catch {
        // melhor esforço
      }
    },

    wake,

    /** Um ciclo completo (os testes chamam direto). @returns {Promise<RunSummary>} */
    runOnce() {
      return exclusive(cycle);
    },

    /** Boot (5.6), também com `none`: expira, esgota e purga em lotes. Nunca lança. */
    async maintenance() {
      try {
        const nowMs = now().getTime();
        await expireAndExhaust(nowMs);
        const purged = await outbox.purgeTerminalAll(iso(nowMs - EMAIL_RETENTION_DAYS * DAY_MS), { batch: EMAIL_PURGE_BATCH });
        if (purged > 0) log.info({ event: 'email_outbox_purged', count: purged });
      } catch (err) {
        log.warn({ event: 'email_maintenance_failed', errCode: err?.code, errName: err?.name });
      }
    },

    events,

    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
  };
}
