// Página de gerenciar o agendamento (AF-12, design 4.3 e 4.4). HTML FIXO, igual para qualquer token
// (o HTML nunca contém o token nem depende dele, critério 13). Todo dado vem da API por JS e entra
// por `textContent`. Sem script inline, estilo inline nem handler inline; o único JavaScript é o
// módulo do mesmo domínio (CSP da página pública, só 'self').
import { html } from '../../http/html.js';

/** Ponto de entrada do módulo da página. */
export const MANAGE_PAGE_ENTRY = '/js/manage-page.js';

const PAGE = html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seu agendamento · AgendaFácil</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/public.css">
<script type="module" src="${MANAGE_PAGE_ENTRY}"></script>
</head>
<body>
<main class="mg" data-state="loading">
<h1 class="pp-name">Seu agendamento</h1>
<p class="mg-live" role="status" aria-live="polite"></p>
<div class="pp-alert mg-alert" role="alert" hidden></div>
<p class="mg-loading">Carregando…</p>
<noscript><p class="pp-notice">Para ver e alterar o agendamento, ative o JavaScript ou ligue para o estabelecimento.</p></noscript>
<section class="mg-invalid" hidden aria-labelledby="mg-invalid-titulo">
<h2 id="mg-invalid-titulo" tabindex="-1">Link inválido ou expirado</h2>
<p>Link inválido ou expirado. Se precisar, ligue para o estabelecimento.</p>
</section>
<section class="mg-summary" hidden aria-labelledby="mg-summary-titulo">
<h2 id="mg-summary-titulo" tabindex="-1">Agendamento</h2>
<p class="mg-done" hidden></p>
<p class="mg-status" hidden></p>
<dl class="pp-success-details mg-details"></dl>
<p class="mg-deadline" hidden></p>
<p class="mg-policy" hidden></p>
<p class="mg-closed" hidden>O prazo para alterar online terminou. Ligue para o estabelecimento.</p>
<p class="mg-phone" hidden>Telefone do estabelecimento: <a class="mg-phone-link pp-success-phone-link"></a></p>
<p class="mg-page" hidden><a class="mg-page-link pp-success-phone-link" rel="noreferrer">Ver a página do estabelecimento</a></p>
<p class="mg-notice" hidden></p>
<div class="mg-actions" hidden>
<button type="button" class="pp-confirm-button mg-cancel-button">Cancelar agendamento</button>
<button type="button" class="pp-confirm-button mg-secondary mg-reschedule-button">Remarcar</button>
</div>
</section>
<section class="mg-cancel" hidden aria-labelledby="mg-cancel-titulo">
<h2 id="mg-cancel-titulo" tabindex="-1">Cancelar agendamento</h2>
<p>Cancelar este agendamento? O horário fica livre para outra pessoa.</p>
<div class="mg-actions">
<button type="button" class="pp-confirm-button mg-cancel-yes">Sim, cancelar</button>
<button type="button" class="pp-confirm-button mg-secondary mg-cancel-back">Voltar</button>
</div>
</section>
<section class="mg-reschedule" hidden aria-labelledby="mg-reschedule-titulo">
<h2 id="mg-reschedule-titulo" tabindex="-1">Remarcar</h2>
<p class="mg-reschedule-policy"></p>
<div class="pp-booking-fields" role="group" aria-label="Escolha do novo horário">
<label for="mg-professional">Profissional</label>
<select id="mg-professional"></select>
<label for="mg-date">Data</label>
<input id="mg-date" type="date">
</div>
<p class="pp-timezone mg-timezone tz-notice" id="mg-timezone" data-tz-notice></p>
<p class="pp-status mg-slots-status" role="status" aria-live="polite"></p>
<ul class="pp-slots mg-slots" aria-label="Horários livres" aria-describedby="mg-timezone"></ul>
<div class="pp-suggestions mg-suggestions" hidden><p class="pp-suggestions-title">Horários livres próximos</p><ul class="pp-suggestions-list mg-suggestions-list" aria-describedby="mg-timezone"></ul></div>
<div class="mg-confirm" hidden>
<p class="pp-selected mg-selected"></p>
<button type="button" class="pp-confirm-button mg-reschedule-confirm">Confirmar remarcação</button>
</div>
<div class="mg-actions">
<button type="button" class="pp-confirm-button mg-secondary mg-reschedule-back">Voltar</button>
</div>
</section>
</main>
<footer class="pp-footer">Página criada com AgendaFácil</footer>
</body>
</html>
`;

/** Bytes constantes, gerados na carga do módulo (padrão de NOT_FOUND_HTML). */
export const MANAGE_PAGE_HTML = Buffer.from(PAGE.toString(), 'utf8');
