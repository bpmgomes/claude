// Modelos dos e-mails de conta (AF-03, design 4.3, critérios 30 e 32). Módulo puro. O HTML é montado
// SÓ pela tag `html` de src/http/html.js: nenhum valor vira tag. O único `href` é o link de
// redefinição; o aviso de troca não tem nenhum (decisão 8). Nenhum dado além do nome (escapado), do
// link e do instante. Sem anexo (.ics).
import { html } from '../../../http/html.js';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-blocks.js';
import { withTimeZone } from '../../../shared/timezone-names.js';
import { ACCOUNT_EMAIL_MESSAGES as AM } from '../email-messages.js';
import { formatInstant } from '../email-format.js';
import { headerText } from '../message.js';
import { EMAIL_KIND_PASSWORD_RESET, EMAIL_KIND_PASSWORD_CHANGED } from '../email-rules.js';
import { resetUrlPrefix } from '../../auth/password-reset-token.js';
import { PASSWORD_RESET_TOKEN_RE } from '../../../shared/password-reset.js';

// Estilos fixos (constantes do módulo, nunca dado), os mesmos do e-mail de agendamento.
const BODY_STYLE = 'margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1f2933;background:#ffffff';
const BOX_STYLE = 'max-width:560px;margin:0 auto';
const LINK_STYLE = 'display:inline-block;padding:10px 16px;background:#0b5cad;color:#ffffff;text-decoration:none;border-radius:4px';
const SMALL_STYLE = 'font-size:14px;color:#52606d';

/**
 * @param {{ kind: 'password_reset'|'password_changed', user: { name: string },
 *   resetUrl?: string,                        // só password_reset
 *   changedAtMs?: number, timeZone?: string,  // só password_changed
 *   publicBaseUrl: string, requireHttps: boolean }} input
 * @returns {{ subject: string, text: string, html: string }}   // sem ics
 * @throws {Error} resetUrl fora de `publicBaseUrl + '/redefinir-senha#token='` ou sem https com requireHttps
 */
export function renderAccountEmail(input) {
  const { kind, user, resetUrl, changedAtMs, timeZone, publicBaseUrl, requireHttps } = input;
  const base = String(publicBaseUrl ?? '');
  if (!/^https?:\/\/[^/?#\s]+$/.test(base)) throw new Error('renderAccountEmail: publicBaseUrl inválido.');
  if (requireHttps && !base.startsWith('https://')) throw new Error('renderAccountEmail: link sem https.');
  const name = headerText(user?.name ?? '');

  if (kind === EMAIL_KIND_PASSWORD_RESET) {
    const prefix = resetUrlPrefix(base);
    if (typeof resetUrl !== 'string' || !resetUrl.startsWith(prefix) || !PASSWORD_RESET_TOKEN_RE.test(resetUrl.slice(prefix.length))) {
      throw new Error('renderAccountEmail: link de redefinição fora da base.');
    }
    const subject = AM.subjectReset;
    const text = [
      AM.greeting(name),
      '',
      AM.introReset,
      '',
      `${AM.resetLink}: ${resetUrl}`,
      '',
      AM.resetValidity,
      AM.resetNotYou,
      '',
      AM.footer,
      '',
    ].join('\n');
    const body = html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${subject}</title>
</head>
<body style="${BODY_STYLE}">
<div style="${BOX_STYLE}">
<p>${AM.greeting(name)}</p>
<p>${AM.introReset}</p>
<p><a href="${resetUrl}" style="${LINK_STYLE}">${AM.resetLink}</a></p>
<p>${AM.resetValidity}</p>
<p style="${SMALL_STYLE}">${AM.resetNotYou}</p>
<p style="${SMALL_STYLE}">${AM.footer}</p>
</div>
</body>
</html>
`;
    return { subject, text, html: body.text };
  }

  if (kind === EMAIL_KIND_PASSWORD_CHANGED) {
    if (resetUrl !== undefined && resetUrl !== null) throw new Error('renderAccountEmail: o aviso de troca não leva link.');
    if (!Number.isFinite(changedAtMs)) throw new Error('renderAccountEmail: instante da troca inválido.');
    const tz = timeZone || DEFAULT_TIME_ZONE;
    const when = withTimeZone(formatInstant(changedAtMs, tz), tz);
    const subject = AM.subjectChanged;
    const text = [AM.greeting(name), '', AM.changedAt(when), AM.changedSessions, '', AM.changedNotYou, '', AM.footer, ''].join('\n');
    const body = html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${subject}</title>
</head>
<body style="${BODY_STYLE}">
<div style="${BOX_STYLE}">
<p>${AM.greeting(name)}</p>
<p><strong>${AM.changedAt(when)}</strong></p>
<p>${AM.changedSessions}</p>
<p>${AM.changedNotYou}</p>
<p style="${SMALL_STYLE}">${AM.footer}</p>
</div>
</body>
</html>
`;
    return { subject, text, html: body.text };
  }

  throw new Error('renderAccountEmail: tipo desconhecido.');
}
