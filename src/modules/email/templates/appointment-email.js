// Modelos dos e-mails do agendamento (AF-18, design 4.3, critérios 12 a 17). Módulo puro. O HTML é
// montado SÓ pela tag `html` de src/http/html.js (escapa & < > " ' `): nenhum valor do banco vira
// tag. Sem imagem, CSS externo, script nem atributo on*; os únicos href são o link de gerenciar, a
// página pública do negócio e o `tel:` do negócio. O texto puro leva os valores literais.
import { html } from '../../../http/html.js';
import { formatDuration, formatServicePrice } from '../../../shared/services.js';
import { formatPhone } from '../../../shared/validation.js';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-blocks.js';
import { changeWindow, MANAGE_PATH_PREFIX, RESCHEDULES_PER_CHAIN_MAX } from '../../../shared/appointments.js';
import { buildIcs, icsUidOf } from '../../calendar/ics.js';
import { EMAIL_MESSAGES as EM } from '../email-messages.js';
import { localParts, formatWhen, formatShortWhen } from '../email-format.js';
import { headerText } from '../message.js';
import {
  EMAIL_KIND_CONFIRMED,
  EMAIL_KIND_CANCELLED,
  EMAIL_KIND_RESCHEDULED,
  EMAIL_KIND_CANCELLED_BY_OWNER,
  EMAIL_CANCELLATION_KINDS,
} from '../email-rules.js';

/** Corte dos valores no assunto (design 4.2). */
export const SUBJECT_PART_MAX = 60;

// Estilos fixos (constantes do módulo, nunca dado).
const BODY_STYLE = 'margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1f2933;background:#ffffff';
const BOX_STYLE = 'max-width:560px;margin:0 auto';
const LINK_STYLE = 'display:inline-block;padding:10px 16px;background:#0b5cad;color:#ffffff;text-decoration:none;border-radius:4px';
const SMALL_STYLE = 'font-size:14px;color:#52606d';

/**
 * @typedef {import('../../appointments/appointments.repository.js').AppointmentRow & { professionalName: string }} Row
 * @param {{
 *   kind: 'appointment_confirmed'|'appointment_cancelled'|'appointment_rescheduled'|'appointment_cancelled_by_owner',
 *   business: { name: string, address: string, phone: string, slug: string, timezone: string,
 *     cancellationLeadMinutes: number },
 *   appointment: Row,                       // o atual (rescheduled: o novo; cancelled: o cancelado)
 *   previous?: Row,                         // só rescheduled
 *   chain: { rootAppointmentId: string, sequence: number },   // sequence do `appointment` (0..3)
 *   manageUrl?: string,                     // confirmed/rescheduled; nunca cancelled; cancelled_by_owner: lança
 *   publicBaseUrl: string, nowMs: number, requireHttps: boolean,
 * }} input
 * @returns {{ subject: string, text: string, html: string, ics: { content: string, method: 'PUBLISH'|'CANCEL' } }}
 * @throws {Error} link fora de `publicBaseUrl`, sem https com `requireHttps`, ou tipo desconhecido
 */
export function renderAppointmentEmail(input) {
  const { kind, business, appointment, previous, chain, manageUrl, publicBaseUrl, nowMs, requireHttps } = input;
  const base = String(publicBaseUrl ?? '');
  if (!/^https?:\/\/[^/?#\s]+$/.test(base)) throw new Error('renderAppointmentEmail: publicBaseUrl inválido.');
  if (requireHttps && !base.startsWith('https://')) throw new Error('renderAppointmentEmail: link sem https.');
  if (![EMAIL_KIND_CONFIRMED, EMAIL_KIND_CANCELLED, EMAIL_KIND_RESCHEDULED, EMAIL_KIND_CANCELLED_BY_OWNER].includes(kind)) {
    throw new Error('renderAppointmentEmail: tipo desconhecido.');
  }
  const byOwner = kind === EMAIL_KIND_CANCELLED_BY_OWNER;
  // AF-14 (critério 26): o e-mail do cancelamento pelo dono nunca leva link de gerenciar.
  if (byOwner && manageUrl !== undefined && manageUrl !== null) {
    throw new Error('renderAppointmentEmail: cancelamento pelo dono não leva link de gerenciar.');
  }
  const cancelled = EMAIL_CANCELLATION_KINDS.includes(kind);
  const withManage = !cancelled;
  if (withManage && !(typeof manageUrl === 'string' && manageUrl.startsWith(`${base}${MANAGE_PATH_PREFIX}`))) {
    throw new Error('renderAppointmentEmail: link de gerenciar fora da base.');
  }
  if (kind === EMAIL_KIND_RESCHEDULED && !previous) throw new Error('renderAppointmentEmail: remarcação sem o anterior.');

  const timeZone = business.timezone || DEFAULT_TIME_ZONE;
  const startMs = Date.parse(appointment.startsAt);
  const endMs = Date.parse(appointment.endsAt);
  const phoneDigits = String(business.phone ?? '').replace(/\D/g, '');
  const phone = formatPhone(phoneDigits);
  const tel = `tel:+55${phoneDigits}`;
  const pageUrl = `${base}/${business.slug}`;
  const sequence = Number(chain.sequence) || 0;

  const startParts = localParts(startMs, timeZone);
  const subjectArgs = [
    headerText(appointment.serviceName, SUBJECT_PART_MAX),
    startParts.ddmm,
    startParts.time,
    headerText(business.name, SUBJECT_PART_MAX),
  ];
  const subject = headerText(
    kind === EMAIL_KIND_CONFIRMED
      ? EM.subjectConfirmed(...subjectArgs)
      : kind === EMAIL_KIND_CANCELLED
        ? EM.subjectCancelled(...subjectArgs)
        : byOwner
          ? EM.subjectCancelledByOwner(...subjectArgs)
          : EM.subjectRescheduled(...subjectArgs),
  );

  const priceOnRequest = appointment.priceCents === null || appointment.priceCents === undefined;
  const serviceLine = EM.serviceLine(
    appointment.serviceName,
    formatDuration(appointment.durationMinutes),
    formatServicePrice({ priceCents: appointment.priceCents, priceOnRequest }),
  );
  const when = formatWhen(startMs, endMs, timeZone);
  const professionalChanged = kind === EMAIL_KIND_RESCHEDULED && previous.professionalId !== appointment.professionalId;
  const professionalText = professionalChanged
    ? EM.professionalChanged(appointment.professionalName, previous.professionalName)
    : `${EM.professionalLabel}: ${appointment.professionalName}`;

  // Política e prazo (critério 14): antecedência ATUAL do negócio, relida no envio.
  let policyLines = [];
  if (withManage) {
    const window = changeWindow({
      status: appointment.status,
      startsAtMs: startMs,
      nowMs,
      leadMinutes: business.cancellationLeadMinutes,
    });
    policyLines = window.canChange
      ? [EM.policy(business.cancellationLeadMinutes), EM.deadline(formatShortWhen(window.deadlineMs, timeZone))]
      : [EM.deadlinePassed(phone)];
    if (sequence >= RESCHEDULES_PER_CHAIN_MAX) policyLines.push(EM.rescheduleExhausted(phone));
    else if (sequence === 0) policyLines.push(EM.rescheduleLimitFirst);
    else policyLines.push(EM.rescheduleRemaining(RESCHEDULES_PER_CHAIN_MAX - sequence));
  }
  const intro =
    kind === EMAIL_KIND_CONFIRMED
      ? EM.introConfirmed
      : kind === EMAIL_KIND_CANCELLED
        ? EM.introCancelled
        : byOwner
          ? EM.introCancelledByOwner
          : EM.introRescheduled;

  // Linhas de detalhe, na mesma ordem nas duas versões.
  const whenLines =
    kind === EMAIL_KIND_RESCHEDULED
      ? [
          [EM.before, formatWhen(Date.parse(previous.startsAt), Date.parse(previous.endsAt), timeZone)],
          [EM.after, when],
        ]
      : [[cancelled ? EM.cancelledWhen : null, when]];
  const details = [
    [`${EM.serviceLabel}: `, serviceLine],
    ['', professionalText],
    [`${EM.businessLabel}: `, business.name],
    [`${EM.addressLabel}: `, business.address],
    [`${EM.phoneLabel}: `, phone],
  ];

  // Texto puro: valores literais, links por extenso.
  const text = [
    EM.greeting(appointment.customerName),
    '',
    intro,
    '',
    ...whenLines.map(([label, value]) => (label ? `${label} ${value}` : value)),
    EM.timezone(timeZone),
    '',
    ...details.map(([label, value]) => `${label}${value}`),
    '',
    ...(withManage
      ? [`${EM.manageLink}: ${manageUrl}`, ...policyLines, '', EM.securityKeep, EM.securityNotYou]
      : [`${EM.bookAgain}: ${pageUrl}`, EM.callBusiness(phone)]),
    ...(byOwner ? ['', EM.notYouCancelled] : []),
    '',
    EM.footer,
    '',
  ].join('\n');

  const htmlBody = html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${subject}</title>
</head>
<body style="${BODY_STYLE}">
<div style="${BOX_STYLE}">
<p>${EM.greeting(appointment.customerName)}</p>
<p><strong>${intro}</strong></p>
${whenLines.map(([label, value]) => html`<p>${label ? html`<strong>${label}</strong> ` : ''}${value}</p>
`)}<p style="${SMALL_STYLE}">${EM.timezone(timeZone)}</p>
<ul>
${details.map(([label, value]) => html`<li>${label}${value}</li>
`)}</ul>
${
  withManage
    ? html`<p><a href="${manageUrl}" style="${LINK_STYLE}">${EM.manageLink}</a></p>
${policyLines.map((line) => html`<p>${line}</p>
`)}<p style="${SMALL_STYLE}">${EM.securityKeep}</p>
<p style="${SMALL_STYLE}">${EM.securityNotYou}</p>
`
    : html`<p><a href="${pageUrl}" style="${LINK_STYLE}">${EM.bookAgain}</a></p>
<p>${EM.callBusinessLead} <a href="${tel}">${phone}</a>.</p>
`
}${byOwner ? html`<p style="${SMALL_STYLE}">${EM.notYouCancelled}</p>
` : ''}<p style="${SMALL_STYLE}">${EM.footer}</p>
</div>
</body>
</html>
`;

  // .ics (critérios 20 e 21; AF-14: o cancelamento pelo dono também é CANCEL).
  const ics = buildIcs({
    method: cancelled ? 'CANCEL' : 'PUBLISH',
    status: cancelled ? 'CANCELLED' : 'CONFIRMED',
    uid: icsUidOf(chain.rootAppointmentId, base),
    sequence: cancelled ? sequence + 1 : sequence,
    dtstampMs: nowMs,
    startMs,
    endMs,
    summary: `${appointment.serviceName} - ${business.name}`,
    location: business.address,
    description: `${EM.professionalLabel}: ${appointment.professionalName}\n${EM.phoneLabel}: ${phone}`,
  });

  return { subject, text, html: htmlBody.text, ics: { content: ics, method: cancelled ? 'CANCEL' : 'PUBLISH' } };
}
