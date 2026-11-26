// HTML da página pública (AF-09 4.4, AF-10 4.4). Módulo puro: todo valor dinâmico passa pela tag
// `html`, que escapa por padrão. Sem script inline, estilo inline nem handler inline: o único
// JavaScript é o módulo de horários, do mesmo domínio, e os dados vão em atributos `data-*`.
import { html } from '../../http/html.js';

/**
 * CSP própria da página pública: script e fetch só do próprio domínio (módulo de horários do
 * AF-10), sem `unsafe-inline` e sem `unsafe-eval` (AF-09 critério 22, AF-10 decisão 12).
 */
export const PUBLIC_PAGE_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * CSP das páginas curtas e fixas (404, 429 e 500): a da página pública sem `script-src` e sem
 * `connect-src` (AF-10 item 2). Elas não têm script nem fetch.
 */
export const PUBLIC_MESSAGE_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Ponto de entrada do módulo de horários. */
export const PUBLIC_BOOKING_ENTRY = '/js/public-booking-page.js';

/**
 * Grafo inteiro de imports estáticos do módulo de horários, cada um com `modulepreload` (uma ida e
 * volta em vez de uma por nível de import). Um teste percorre o grafo e confere esta lista.
 */
export const PUBLIC_BOOKING_MODULES = Object.freeze([
  PUBLIC_BOOKING_ENTRY,
  '/js/public-booking-controller.js',
  '/js/customer-form-controller.js',
  '/js/api.js',
  '/shared/customers.js',
  '/shared/availability.js',
  '/shared/zoned-time.js',
  '/shared/services.js',
  '/shared/validation.js',
  '/shared/slug.js',
]);

/** Avatar padrão do AF-07 para profissional sem foto. */
export const DEFAULT_AVATAR_URL = '/img/avatar-default.svg';

const LOGO_SIZE = 96;
const AVATAR_SIZE = 64;
const OG_IMAGE_SIZE = 256;

function bookingScripts() {
  return html`${PUBLIC_BOOKING_MODULES.map((href) => html`<link rel="modulepreload" href="${href}">\n`)}<script type="module" src="${PUBLIC_BOOKING_ENTRY}"></script>
`;
}

function head({ title, description, canonicalUrl, ogImageUrl, noindex = false, og = true, booking = false }) {
  return html`<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${noindex ? html`<meta name="robots" content="noindex">\n` : ''}${description ? html`<meta name="description" content="${description}">\n` : ''}${canonicalUrl ? html`<link rel="canonical" href="${canonicalUrl}">\n` : ''}${
    og
      ? html`<meta property="og:type" content="website">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${og.title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonicalUrl}">
${
  ogImageUrl
    ? html`<meta property="og:image" content="${ogImageUrl}">
<meta property="og:image:width" content="${OG_IMAGE_SIZE}">
<meta property="og:image:height" content="${OG_IMAGE_SIZE}">
`
    : ''
}`
      : ''
  }<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/public.css">
${booking ? bookingScripts() : ''}</head>`;
}

function documentOf(headHtml, bodyHtml) {
  return html`<!doctype html>
<html lang="pt-BR">
${headHtml}
<body>
${bodyHtml}
<footer class="pp-footer">Página criada com AgendaFácil</footer>
</body>
</html>
`.toString();
}

function header(business) {
  const logo = business.logoUrl
    ? html`<img class="pp-logo" src="${business.logoUrl}" alt="Logo de ${business.name}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" fetchpriority="high">`
    : html`<div class="pp-logo pp-logo-placeholder" aria-hidden="true"></div>`;
  return html`<header class="pp-header">
${logo}
<h1 class="pp-name">${business.name}</h1>
<p class="pp-address">${business.address}</p>
<a class="pp-phone" href="${business.phoneHref}">${business.phoneDisplay}</a>
</header>`;
}

function serviceItem(service) {
  return html`<li class="pp-service">
<h3 class="pp-service-name">${service.name}</h3>
<p class="pp-meta"><span>${service.durationLabel}</span> · <span class="pp-price">${service.priceLabel}</span></p>
<p class="pp-with">Com: ${service.professionalNames.join(', ')}</p>
<a class="pp-book" href="?servico=${service.id}#agendar" data-service-id="${service.id}">Ver horários</a>
</li>
`;
}

function professionalItem(professional) {
  return html`<li class="pp-professional">
<img class="pp-avatar" src="${professional.photoUrl || DEFAULT_AVATAR_URL}" alt="Foto de ${professional.name}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" loading="lazy" decoding="async">
<div class="pp-professional-info">
<h3 class="pp-professional-name">${professional.name}</h3>
<p class="pp-with">${professional.serviceNames.join(', ')}</p>
</div>
</li>
`;
}

function offer(page) {
  return html`<section id="servicos" tabindex="-1" aria-labelledby="servicos-titulo">
<h2 id="servicos-titulo">Serviços</h2>
<ul class="pp-services">
${page.services.map(serviceItem)}</ul>
</section>
${booking(page)}
<section id="profissionais" aria-labelledby="profissionais-titulo">
<h2 id="profissionais-titulo">Profissionais</h2>
<ul class="pp-professionals">
${page.professionals.map(professionalItem)}</ul>
</section>`;
}

function serviceOption(service) {
  return html`<option value="${service.id}" data-duration="${service.durationMinutes}">${service.name} · ${service.durationLabel}</option>
`;
}

function professionalOption(professional) {
  return html`<option value="${professional.id}" data-services="${professional.serviceIds.join(' ')}">${professional.name}</option>
`;
}

/**
 * Passo "Seus dados" (AF-04, 4.4). Formulário real para o autocomplete do navegador, sem `action`
 * nem `method`: o envio é sempre interceptado no JS e a CSP tem `form-action 'none'`. Sem
 * `maxlength` (cortaria em silêncio um telefone colado com máscara). Desde o AF-11, o botão
 * confirma o agendamento (POST com `credentials: 'omit'`). Cada erro de campo fica num `<p aria-live="polite">`
 * sempre presente (vazio sem erro): um live region oculto com `hidden` não é anunciado de forma
 * confiável ao aparecer.
 */
function customerForm(business) {
  return html`<form class="pp-customer" id="bk-customer" novalidate aria-labelledby="dados-titulo">
<h3 id="dados-titulo">Seus dados</h3>
<p class="pp-privacy" id="dados-privacidade">Usamos seu nome, telefone e e-mail só para fazer este agendamento e avisar você sobre ele. Os dados são recebidos por ${business.name}. Não pedimos senha nem criamos conta.</p>
<div class="pp-field">
<label for="bk-name">Nome</label>
<input id="bk-name" name="name" type="text" autocomplete="name" autocapitalize="words" required aria-describedby="bk-name-erro">
<p class="pp-field-error" id="bk-name-erro" aria-live="polite"></p>
</div>
<div class="pp-field">
<label for="bk-phone">Telefone (com DDD)</label>
<input id="bk-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" required aria-describedby="bk-phone-dica bk-phone-erro">
<p class="pp-hint" id="bk-phone-dica">Celular ou fixo. Ex.: (11) 91234-5678</p>
<p class="pp-field-error" id="bk-phone-erro" aria-live="polite"></p>
</div>
<div class="pp-field">
<label for="bk-email">E-mail</label>
<input id="bk-email" name="email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" required aria-describedby="bk-email-erro">
<p class="pp-field-error" id="bk-email-erro" aria-live="polite"></p>
</div>
<button type="submit" class="pp-confirm-button">Confirmar agendamento</button>
</form>`;
}

/**
 * Tela de sucesso (AF-11, 4.4), vazia e oculta: os dados do 201 entram só por `textContent`. Não
 * promete e-mail. Desde o AF-12 (critério 8, que substitui o critério 28 do AF-11), o bloco
 * "Gerenciar agendamento" fica oculto e sem `href` no HTML: o JS o preenche só com o link válido do
 * 201 (`manage.url`) e a política vinda do servidor. O telefone continua sempre visível, e é o único
 * caminho quando `manage` é null.
 */
function successSection(business) {
  return html`<section class="pp-success" hidden tabindex="-1" aria-labelledby="sucesso-titulo">
<h2 id="sucesso-titulo" tabindex="-1">Agendamento confirmado</h2>
<dl class="pp-success-details"></dl>
<div class="pp-success-manage" hidden>
<p class="pp-success-policy"></p>
<p><a class="pp-success-manage-link" rel="noreferrer">Gerenciar agendamento (cancelar ou remarcar)</a></p>
<p class="pp-success-manage-url"></p>
<p class="pp-success-manage-warning">Guarde este link: é por ele que você cancela ou remarca. Não compartilhe; quem tiver o link pode alterar o agendamento.</p>
</div>
<p class="pp-success-phone">Se preferir, ligue para <a class="pp-success-phone-link" href="${business.phoneHref}">${business.phoneDisplay}</a>.</p>
</section>`;
}

/** Seção de horários (AF-10, 4.4): oculta sem JavaScript, com o aviso do <noscript>. */
function booking(page) {
  const { business, booking: b } = page;
  return html`<div id="agendar">
<noscript><p class="pp-notice">Para ver os horários livres, ative o JavaScript ou ligue para <a href="${business.phoneHref}">${business.phoneDisplay}</a>.</p></noscript>
<section class="pp-booking" aria-labelledby="horarios-titulo" hidden data-slug="${business.slug}" data-today="${b.today}" data-max-date="${b.maxDate}" data-timezone="${b.timezone}">
<h2 id="horarios-titulo">Horários disponíveis</h2>
<div class="pp-booking-fields" role="group" aria-label="Escolha do horário">
<label for="bk-service">Serviço</label>
<select id="bk-service"><option value="">Escolha um serviço</option>
${page.services.map(serviceOption)}</select>
<label for="bk-professional">Profissional</label>
<select id="bk-professional"><option value="any">Qualquer profissional</option>
${page.professionals.map(professionalOption)}</select>
<label for="bk-date">Data</label>
<input id="bk-date" type="date" min="${b.today}" max="${b.maxDate}" value="${b.today}">
</div>
<p class="pp-timezone">Horários no fuso ${b.timezone}.</p>
<p class="pp-status" role="status" aria-live="polite"></p>
<ul class="pp-slots" aria-label="Horários livres"></ul>
<div class="pp-confirm" hidden>
<p class="pp-selected"></p>
<div class="pp-alert" role="alert" hidden></div>
<div class="pp-suggestions" hidden><p class="pp-suggestions-title">Horários livres próximos</p><ul class="pp-suggestions-list"></ul></div>
${customerForm(business)}
</div>
</section>
${successSection(business)}
</div>`;
}

function emptyState(business) {
  return html`<section id="servicos" tabindex="-1" class="pp-empty" aria-labelledby="servicos-titulo">
<h2 id="servicos-titulo">Agendamento online indisponível</h2>
<p>Este negócio ainda não tem serviços disponíveis para agendar pela internet.
Entre em contato pelo telefone <a class="pp-empty-phone" href="${business.phoneHref}">${business.phoneDisplay}</a>.</p>
</section>`;
}

/**
 * @param {import('./public-page.view.js').PublicPage} page
 * @returns {string}
 */
export function renderPublicPage(page) {
  const { business } = page;
  const headHtml = head({
    title: `${business.name} · AgendaFácil`,
    description: page.description,
    canonicalUrl: page.canonicalUrl,
    ogImageUrl: page.ogImageUrl,
    og: { title: business.name },
    booking: page.hasOffer,
  });
  const bodyHtml = html`<a class="skip-link" href="#servicos">Pular para os serviços</a>
${header(business)}
<main>
${
  page.hasOffer
    ? html`<p class="pp-notice" id="agendar-aviso">Escolha um horário livre abaixo e confirme online. Se preferir, ligue para ${business.phoneDisplay}.</p>`
    : html`<p class="pp-notice" id="agendar-aviso">Agendamento online em breve. Por enquanto, ligue para ${business.phoneDisplay}.</p>`
}
${page.hasOffer ? offer(page) : emptyState(business)}
</main>`;
  return documentOf(headHtml, bodyHtml);
}

/** Página curta e fixa (404, 429, 500): não depende de nenhuma entrada. */
function staticPage(title, heading, text) {
  const headHtml = head({ title: `${title} · AgendaFácil`, noindex: true, og: false });
  const bodyHtml = html`<main class="pp-message">
<h1 class="pp-name">${heading}</h1>
<p>${text}</p>
</main>`;
  return Buffer.from(documentOf(headHtml, bodyHtml), 'utf8');
}

/** 404 uniforme (critérios 6, 20 e 21): bytes constantes, gerados na carga do módulo. */
export const NOT_FOUND_HTML = staticPage(
  'Página não encontrada',
  'Página não encontrada',
  'Confira se o link está correto. Se recebeu o link de um negócio, peça o endereço atualizado a ele.',
);

export const RATE_LIMITED_HTML = staticPage(
  'Muitos acessos',
  'Muitos acessos',
  'Muitos acessos em pouco tempo. Aguarde um instante e recarregue a página.',
);

export const ERROR_HTML = staticPage(
  'Erro',
  'Algo deu errado',
  'Não foi possível carregar a página agora. Tente novamente em instantes.',
);
