// Tela da agenda do dono (AF-14, design 4.4). Só createElement/textContent/replaceChildren; "hoje" vem
// do `now` do servidor; a URL leva só view, date e professional; o interruptor de cancelados fica em
// memória. Sem polling: "Atualizar" refaz a leitura.
import { loadBusiness, safePublicUrl } from './business-controller.js';
import { logout } from './login-controller.js';
import { browserFetch, renderLogo } from './business-form.js';
import { loadProfessionals } from './professionals-controller.js';
import {
  parseAgendaUrl,
  buildAgendaUrl,
  rangeOf,
  shift,
  titleOf,
  timezoneLabel,
  dayHeading,
  hiddenLabel,
  describeItem,
  cancelQuestion,
  cancelResultMessage,
  chainLabels,
  cancelledLabel,
  detailWhen,
  localLabel,
  safeTelHref,
  loadAgenda,
  loadAppointment,
  cancelAppointment,
  AGENDA_PAGE_MESSAGES as M,
  ALL_PROFESSIONALS_LABEL,
} from './agenda-controller.js';
import { AGENDA_STATUS_DISPLAY, AGENDA_ALL_PROFESSIONALS, AGENDA_PAST_DAYS, AGENDA_FUTURE_DAYS } from '/shared/agenda.js';
import { addLocalDays } from '/shared/zoned-time.js';

const navigate = (url) => window.location.assign(url);
const $ = (id) => document.getElementById(id);

const nameEl = $('business-name');
const logoPreview = $('logo-preview');
const logoutButton = $('logout-button');
const pageStatus = $('page-status');
const section = $('agenda-section');
const viewDay = $('view-day');
const viewWeek = $('view-week');
const prevButton = $('prev');
const todayButton = $('today');
const nextButton = $('next');
const refreshButton = $('refresh');
const dateInput = $('agenda-date');
const professionalSelect = $('agenda-professional');
const showCancelled = $('show-cancelled');
const filterNotice = $('filter-notice');
const title = $('agenda-title');
const timezoneEl = $('agenda-timezone');
const legend = $('agenda-legend');
const truncatedEl = $('truncated');
const errorBox = $('agenda-error');
const errorText = $('agenda-error-text');
const retryButton = $('retry');
const daysEl = $('agenda-days');
const emptyState = $('empty-state');
const publicLink = $('public-link');

const detailDialog = $('detail-dialog');
const detailStatus = $('detail-status');
const detailAlert = $('detail-alert');
const detailList = $('detail-list');
const detailSituation = $('detail-situation');
const detailWhenEl = $('detail-when');
const detailService = $('detail-service');
const detailProfessional = $('detail-professional');
const detailCustomer = $('detail-customer');
const detailPhone = $('detail-phone');
const detailCall = $('detail-call');
const detailEmail = $('detail-email');
const copyEmail = $('copy-email');
const copyStatus = $('copy-status');
const detailChain = $('detail-chain');
const detailCancel = $('detail-cancel');
const detailClose = $('detail-close');

const cancelDialog = $('cancel-dialog');
const cancelQuestionEl = $('cancel-question');
const cancelAlert = $('cancel-alert');
const cancelBack = $('cancel-back');
const cancelConfirm = $('cancel-confirm');

const state = { ...parseAgendaUrl(window.location.search), includeCancelled: false };
/** Último `now` do servidor ('YYYY-MM-DDTHH:MM', hora local do negócio). */
let lastNow = null;
/** Id do agendamento cujo botão abriu o detalhe (o foco volta para ele no `close`). */
let openerId = null;
/** Detalhe aberto (`{ appointment, emailEnabled, ... }`). */
let currentDetail = null;
let cancelling = false;
/** Depois de um cancelamento, o foco volta só quando a lista recarregada estiver na tela. */
let focusAfterLoad = null;
let deferFocus = false;
let loadSeq = 0;

function element(tag, { className, text } = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function option(value, label) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}

function redirect(result) {
  if (result && result.redirectTo) {
    navigate(result.redirectTo);
    return true;
  }
  return false;
}

function renderLegend() {
  legend.replaceChildren(
    ...Object.values(AGENDA_STATUS_DISPLAY).map((d) => {
      const li = element('li', { className: `ag-legend-item ${d.className}` });
      const icon = element('span', { className: 'ag-icon', text: d.icon });
      icon.setAttribute('aria-hidden', 'true');
      li.append(icon, element('span', { className: 'ag-label', text: d.label }));
      return li;
    }),
  );
}

function syncControls() {
  viewDay.setAttribute('aria-pressed', String(state.view === 'day'));
  viewWeek.setAttribute('aria-pressed', String(state.view === 'week'));
  if (state.date) dateInput.value = state.date;
  if (lastNow) {
    const today = lastNow.slice(0, 10);
    dateInput.min = addLocalDays(today, -AGENDA_PAST_DAYS);
    dateInput.max = addLocalDays(today, AGENDA_FUTURE_DAYS);
  }
  professionalSelect.value = state.professional || AGENDA_ALL_PROFESSIONALS;
  window.history.replaceState(null, '', `/agenda${buildAgendaUrl(state)}`);
}

function renderItem(item, date, showProfessional) {
  const d = describeItem(item, { date, showProfessional });
  const li = element('li');
  const box = element(item && item.type === 'block' ? 'div' : 'button', { className: `ag-item ${d.className}` });
  if (box.tagName === 'BUTTON') {
    box.type = 'button';
    box.dataset.id = item.id;
    box.addEventListener('click', () => openDetail(item.id));
  }
  const icon = element('span', { className: 'ag-icon', text: d.icon });
  icon.setAttribute('aria-hidden', 'true');
  const head = element('span', { className: 'ag-line' });
  head.append(icon, element('span', { className: 'ag-time', text: d.timeLabel }), element('span', { className: 'ag-label', text: d.statusLabel }));
  box.append(head);
  if (d.key === 'block') {
    box.append(element('span', { className: 'ag-name', text: d.primary }));
    if (d.secondary) box.append(element('span', { className: 'ag-meta', text: d.secondary }));
  } else {
    box.append(element('span', { className: 'ag-name', text: d.primary }));
    box.append(element('span', { className: d.struck ? 'ag-name ag-struck' : 'ag-name', text: d.secondary }));
    if (d.professional) box.append(element('span', { className: 'ag-meta', text: d.professional }));
    if (d.origin) box.append(element('span', { className: 'ag-meta', text: d.origin }));
  }
  li.append(box);
  return li;
}

function render(body) {
  const { from, to } = body;
  title.textContent = titleOf(state.view, from, to);
  timezoneEl.textContent = timezoneLabel(body.timezone);
  truncatedEl.hidden = body.truncated !== true;
  const showProfessional = !state.professional;
  let total = 0;
  const sections = body.days.map((day) => {
    const sec = element('section', { className: 'ag-day' });
    const headingId = `day-${day.date}`;
    sec.setAttribute('aria-labelledby', headingId);
    const h3 = element('h3', { className: 'ag-day-title', text: dayHeading(day) });
    h3.id = headingId;
    sec.append(h3);
    const hidden = state.includeCancelled ? '' : hiddenLabel(day.counts);
    if (hidden) sec.append(element('p', { className: 'help', text: hidden }));
    const items = Array.isArray(day.items) ? day.items : [];
    total += items.length;
    if (items.length > 0) {
      const ul = element('ul', { className: 'ag-list' });
      ul.append(...items.map((item) => renderItem(item, day.date, showProfessional)));
      sec.append(ul);
    }
    return sec;
  });
  daysEl.replaceChildren(...sections);
  emptyState.hidden = total > 0;
}

/**
 * Lê a agenda do período do estado. Sem `date` (primeira leitura sem data na URL), pede "hoje" ao
 * servidor e, se a visão for semana, faz uma segunda leitura com a semana de `now` (C-1).
 * @param {{ announce?: string }} [options] mensagem a anunciar no lugar de "Agenda atualizada."
 */
async function refresh({ announce } = {}) {
  const seq = ++loadSeq;
  section.dataset.state = 'loading';
  pageStatus.textContent = M.loading;
  errorBox.hidden = true;
  const range = state.date ? rangeOf(state.view, state.date) : {};
  const result = await loadAgenda(
    { ...range, professionalId: state.professional || AGENDA_ALL_PROFESSIONALS, includeCancelled: state.includeCancelled },
    { fetchFn: browserFetch },
  );
  if (seq !== loadSeq) return;
  if (!result.ok) {
    if (redirect(result)) return;
    pageStatus.textContent = '';
    errorText.textContent = result.message;
    errorBox.hidden = false;
    section.dataset.state = 'error';
    section.dataset.loads = String(Number(section.dataset.loads || 0) + 1);
    return;
  }
  lastNow = typeof result.body.now === 'string' ? result.body.now : lastNow;
  if (!state.date) {
    state.date = result.body.from;
    if (state.view === 'week') {
      await refresh({ announce });
      return;
    }
  }
  render(result.body);
  syncControls();
  pageStatus.textContent = announce || M.loaded;
  section.dataset.state = 'ready';
  section.dataset.loads = String(Number(section.dataset.loads || 0) + 1);
  if (focusAfterLoad) {
    const { id } = focusAfterLoad;
    focusAfterLoad = null;
    focusItemOrTitle(id);
  }
}

/** Foco no botão do agendamento `id` (depois de uma recarga) ou, se ele sumiu, no título. */
function focusItemOrTitle(id) {
  const target = id ? [...daysEl.querySelectorAll('button.ag-item')].find((b) => b.dataset.id === id) : null;
  (target || title).focus();
}

function setView(view) {
  state.view = view;
  refresh();
}

viewDay.addEventListener('click', () => setView('day'));
viewWeek.addEventListener('click', () => setView('week'));
prevButton.addEventListener('click', () => {
  if (state.date) state.date = shift(state.view, state.date, -1);
  refresh();
});
nextButton.addEventListener('click', () => {
  if (state.date) state.date = shift(state.view, state.date, 1);
  refresh();
});
todayButton.addEventListener('click', () => {
  state.date = lastNow ? lastNow.slice(0, 10) : null;
  refresh();
});
refreshButton.addEventListener('click', () => refresh());
retryButton.addEventListener('click', () => refresh());
dateInput.addEventListener('change', () => {
  if (parseAgendaUrl(`?date=${encodeURIComponent(dateInput.value)}`).date) {
    state.date = dateInput.value;
    refresh();
  }
});
professionalSelect.addEventListener('change', () => {
  const value = professionalSelect.value;
  state.professional = value === AGENDA_ALL_PROFESSIONALS ? null : parseAgendaUrl(`?professional=${encodeURIComponent(value)}`).professional;
  filterNotice.textContent = '';
  refresh();
});
showCancelled.addEventListener('change', () => {
  state.includeCancelled = showCancelled.checked;
  refresh();
});

// Detalhe.

function clearDetail() {
  detailStatus.textContent = '';
  detailAlert.textContent = '';
  copyStatus.textContent = '';
  detailList.hidden = true;
  detailCancel.hidden = true;
  detailChain.replaceChildren();
}

function fillDetail(body) {
  currentDetail = body;
  const a = body.appointment;
  const d = describeItem({ type: 'appointment', status: a.status, cancelled: a.cancelled }, {});
  const situation = [d.statusLabel, cancelledLabel(body)].filter(Boolean).join(' · ');
  detailSituation.textContent = situation;
  detailWhenEl.textContent = detailWhen(body);
  const service = a.service || {};
  detailService.textContent = [service.name, service.durationLabel, service.priceLabel].filter((v) => typeof v === 'string' && v !== '').join(' · ');
  const pro = a.professional || {};
  detailProfessional.textContent = `${typeof pro.name === 'string' ? pro.name : ''}${pro.removed === true ? M.removedSuffix : ''}`;
  const customer = a.customer || {};
  detailCustomer.textContent = typeof customer.name === 'string' ? customer.name : '';
  detailPhone.textContent = typeof customer.phoneDisplay === 'string' ? customer.phoneDisplay : '';
  const tel = safeTelHref(customer.phoneHref);
  if (tel) {
    detailCall.href = tel;
    detailCall.hidden = false;
  } else {
    detailCall.removeAttribute('href');
    detailCall.hidden = true;
  }
  detailEmail.textContent = typeof customer.email === 'string' ? customer.email : '';
  copyEmail.hidden = detailEmail.textContent === '';
  $('detail-created').textContent = localLabel(a.createdAt);
  detailChain.replaceChildren(...chainLabels(body).map((text) => element('li', { text })));
  detailCancel.hidden = a.canCancel !== true;
  detailList.hidden = false;
}

async function openDetail(id) {
  openerId = id;
  currentDetail = null;
  clearDetail();
  detailStatus.textContent = M.detailLoading;
  if (!detailDialog.open) detailDialog.showModal();
  const result = await loadAppointment(id, { fetchFn: browserFetch });
  if (openerId !== id || !detailDialog.open) return;
  detailStatus.textContent = '';
  if (!result.ok) {
    if (redirect(result)) return;
    detailAlert.textContent = result.message;
    if (result.kind === 'notFound') refresh();
    return;
  }
  fillDetail(result.body);
}

detailClose.addEventListener('click', () => detailDialog.close());
detailDialog.addEventListener('close', () => {
  // O evento `close` é uma tarefa à parte: se o detalhe já foi reaberto (Esc e Espaço em seguida), ignora.
  if (detailDialog.open) return;
  if (cancelDialog.open) cancelDialog.close();
  const id = openerId;
  openerId = null;
  currentDetail = null;
  if (deferFocus) {
    deferFocus = false;
    focusAfterLoad = { id };
    return;
  }
  focusItemOrTitle(id);
});

copyEmail.addEventListener('click', async () => {
  const email = detailEmail.textContent;
  if (!email) return;
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
    await navigator.clipboard.writeText(email);
    copyStatus.textContent = M.copied;
  } catch {
    const range = document.createRange();
    range.selectNodeContents(detailEmail);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyStatus.textContent = M.copyFallback;
  }
});

// Cancelamento.

detailCancel.addEventListener('click', () => {
  if (!currentDetail) return;
  cancelQuestionEl.textContent = cancelQuestion(currentDetail, currentDetail.emailEnabled === true);
  cancelAlert.textContent = '';
  cancelConfirm.disabled = false;
  cancelConfirm.removeAttribute('aria-busy');
  cancelDialog.showModal();
});
cancelBack.addEventListener('click', () => cancelDialog.close());

cancelConfirm.addEventListener('click', async () => {
  if (cancelling || !currentDetail) return;
  cancelling = true;
  cancelConfirm.disabled = true;
  cancelConfirm.setAttribute('aria-busy', 'true');
  cancelAlert.textContent = M.cancelling;
  const { id, version } = currentDetail.appointment;
  const emailEnabled = currentDetail.emailEnabled === true;
  const result = await cancelAppointment(id, { version }, { fetchFn: browserFetch });
  cancelling = false;
  cancelConfirm.removeAttribute('aria-busy');
  if (result.ok) {
    deferFocus = true;
    cancelDialog.close();
    detailDialog.close();
    await refresh({ announce: cancelResultMessage(result.outcome, result.body.emailEnabled === true || (result.body.emailEnabled === undefined && emailEnabled)) });
    return;
  }
  if (redirect(result)) return;
  if (result.kind === 'changed' || result.kind === 'notChangeable' || result.kind === 'notFound') {
    cancelDialog.close();
    detailAlert.textContent = result.message;
    // Foco no alerta (tabindex=-1) ANTES de ocultar o botão que o tinha, para não cair no <body>.
    detailAlert.focus();
    detailCancel.hidden = true;
    await refresh();
    return;
  }
  cancelAlert.textContent = result.message;
  cancelConfirm.disabled = false;
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  await logout({ fetchFn: browserFetch, navigate });
});

// Início.

renderLegend();
const business = await loadBusiness({ fetchFn: browserFetch });
if (business.status === 401) {
  navigate('/login');
} else if (business.status === 404) {
  navigate('/onboarding');
} else if (business.ok) {
  nameEl.textContent = business.business.name;
  renderLogo(logoPreview, business.business.logoUrl);
  const href = safePublicUrl(business.business.publicUrl);
  if (href) publicLink.href = href;
  const professionals = await loadProfessionals({ fetchFn: browserFetch });
  if (!professionals.ok) {
    if (!redirect(professionals)) pageStatus.textContent = professionals.message;
  } else {
    const actives = professionals.professionals.filter((p) => p && p.active !== false);
    professionalSelect.replaceChildren(
      option(AGENDA_ALL_PROFESSIONALS, ALL_PROFESSIONALS_LABEL),
      ...actives.map((p) => option(p.id, p.name)),
    );
    if (state.professional && !actives.some((p) => p.id === state.professional)) {
      state.professional = null;
      filterNotice.textContent = M.professionalGone;
    }
    section.hidden = false;
    await refresh();
  }
} else {
  nameEl.textContent = 'Não foi possível carregar seus dados. Recarregue a página.';
}
