// HTML da página pública (AF-09, 4.4). Módulo puro: todo valor dinâmico passa pela tag `html`,
// que escapa por padrão. A página não tem JavaScript, estilo inline nem handler inline.
import { html } from '../../http/html.js';

/** CSP própria da página pública: sem script e sem `unsafe-inline` (critério 22). */
export const PUBLIC_PAGE_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Avatar padrão do AF-07 para profissional sem foto. */
export const DEFAULT_AVATAR_URL = '/img/avatar-default.svg';

const LOGO_SIZE = 96;
const AVATAR_SIZE = 64;
const OG_IMAGE_SIZE = 256;

function head({ title, description, canonicalUrl, ogImageUrl, noindex = false, og = true }) {
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
</head>`;
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
<button type="button" class="pp-book" disabled aria-describedby="agendar-aviso">Agendar</button>
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
<section id="profissionais" aria-labelledby="profissionais-titulo">
<h2 id="profissionais-titulo">Profissionais</h2>
<ul class="pp-professionals">
${page.professionals.map(professionalItem)}</ul>
</section>`;
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
  });
  const bodyHtml = html`<a class="skip-link" href="#servicos">Pular para os serviços</a>
${header(business)}
<main>
<p class="pp-notice" id="agendar-aviso">Agendamento online em breve. Por enquanto, ligue para ${business.phoneDisplay}.</p>
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
