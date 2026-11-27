// Página de gerenciar o agendamento (AF-12, design 4.4). Só textContent; hoje, prazo e fuso vêm do
// servidor; nada fica guardado no navegador. Cada troca de estado leva o foco ao título da seção e é
// anunciada pela região `aria-live`.
import {
  tokenFromPath,
  loadManage,
  loadRescheduleDay,
  cancelAppointment,
  rescheduleAppointment,
  rescheduleSummary,
  slotsReadyMessage,
  professionalChoices,
  suggestionLabel,
  MANAGE_PAGE_MESSAGES as P,
} from './manage-controller.js';
import { timeZoneNotice } from '/shared/timezone-names.js';

const root = document.querySelector('main.mg');
if (root) start(root);

function start(main) {
  const token = tokenFromPath(location.pathname);
  const $ = (selector) => main.querySelector(selector);
  const live = $('.mg-live');
  const alertEl = $('.mg-alert');
  const loading = $('.mg-loading');
  const invalid = $('.mg-invalid');
  const summaryEl = $('.mg-summary');
  const cancelEl = $('.mg-cancel');
  const rescheduleEl = $('.mg-reschedule');
  const sections = [invalid, summaryEl, cancelEl, rescheduleEl];

  const professionalSelect = $('#mg-professional');
  const dateInput = $('#mg-date');
  const slotsStatus = $('.mg-slots-status');
  const slotsList = $('.mg-slots');
  const suggestionsEl = $('.mg-suggestions');
  const suggestionsList = $('.mg-suggestions-list');
  const confirmEl = $('.mg-confirm');
  const selectedEl = $('.mg-selected');
  const confirmButton = $('.mg-reschedule-confirm');
  const cancelYes = $('.mg-cancel-yes');

  /** Resumo exibido (a `version` dele vai em toda escrita). */
  let summary = null;
  let selected = null;
  let pendingStart = null;
  let busy = false;
  let dayRequest = 0;

  function announce(message) {
    live.textContent = '';
    live.textContent = message || '';
  }

  function hideAlert() {
    alertEl.hidden = true;
    alertEl.textContent = '';
  }

  function showAlert(message) {
    alertEl.textContent = message;
    alertEl.hidden = false;
  }

  /** Mostra uma seção, foco no título dela. */
  function show(section, { focus = true } = {}) {
    loading.hidden = true;
    for (const other of sections) other.hidden = other !== section;
    main.dataset.state = section.className.split(' ')[0].replace('mg-', '');
    if (focus) {
      const title = section.querySelector('h2');
      if (title) title.focus();
    }
  }

  function showInvalid() {
    summary = null;
    show(invalid);
    announce(P.notFound);
  }

  function setText(selector, value) {
    const el = $(selector);
    el.textContent = value || '';
    el.hidden = !value;
  }

  function renderSummary(next, { message, done, focus = true } = {}) {
    summary = next;
    $('#mg-summary-titulo').textContent = next.title;
    const details = $('.mg-details');
    details.replaceChildren();
    for (const row of next.details) {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      details.append(dt, dd);
    }
    const confirmed = next.status === 'confirmed';
    const cancelled = next.status === 'cancelled';
    $('.mg-status').textContent = cancelled ? P.cancelled : '';
    $('.mg-status').hidden = !cancelled;
    setText('.mg-deadline', confirmed && next.canChange ? next.deadline : '');
    setText('.mg-policy', confirmed ? next.policy : '');
    $('.mg-closed').hidden = !(confirmed && !next.canChange);

    const phone = $('.mg-phone');
    const phoneLink = $('.mg-phone-link');
    if (confirmed && !next.canChange && next.phoneHref) {
      phoneLink.href = next.phoneHref;
      phoneLink.textContent = next.phoneDisplay;
      phone.hidden = false;
    } else {
      phone.hidden = true;
    }

    const page = $('.mg-page');
    const pageLink = $('.mg-page-link');
    if (cancelled && next.pageUrl) {
      pageLink.href = next.pageUrl;
      page.hidden = false;
    } else {
      page.hidden = true;
      pageLink.removeAttribute('href');
    }

    const canAct = confirmed && next.canChange;
    summaryEl.querySelector('.mg-actions').hidden = !canAct;
    $('.mg-reschedule-button').hidden = !(canAct && next.reschedule.allowed);
    setText('.mg-notice', canAct && !next.reschedule.allowed ? next.reschedule.notice : '');
    setText('.mg-done', done || '');

    show(summaryEl, { focus });
    announce(message || next.title);
  }

  /** Recarrega o resumo e mostra o alerta (changed, notChangeable, limit). */
  async function reloadWith(message) {
    const result = await loadManage(token);
    if (!result.ok) {
      if (result.kind === 'notFound') return showInvalid();
      showAlert(result.message);
      return;
    }
    renderSummary(result.summary);
    showAlert(message);
  }

  function setBusy(button, isBusy, label, busyLabel) {
    busy = isBusy;
    button.disabled = isBusy;
    if (isBusy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    button.textContent = isBusy ? busyLabel : label;
  }

  // ---- Cancelar ----

  $('.mg-cancel-button').addEventListener('click', () => {
    hideAlert();
    show(cancelEl);
  });
  $('.mg-cancel-back').addEventListener('click', () => {
    hideAlert();
    if (summary) renderSummary(summary);
  });
  cancelYes.addEventListener('click', async () => {
    if (busy || !summary) return;
    hideAlert();
    setBusy(cancelYes, true, P.cancelButton, P.cancelling);
    let result;
    try {
      result = await cancelAppointment(token, { version: summary.version });
    } finally {
      setBusy(cancelYes, false, P.cancelButton, P.cancelling);
    }
    if (result.ok) return renderSummary(result.summary, { message: P.cancelledNow });
    if (result.kind === 'notFound') return showInvalid();
    if (result.kind === 'changed' || result.kind === 'notChangeable' || result.kind === 'limit') {
      return reloadWith(result.message);
    }
    showAlert(result.message);
  });

  // ---- Remarcar ----

  function clearSlots() {
    slotsList.replaceChildren();
    selected = null;
    confirmEl.hidden = true;
    selectedEl.textContent = '';
  }

  function hideSuggestions() {
    suggestionsEl.hidden = true;
    suggestionsList.replaceChildren();
  }

  function choose(button, slot, weekday, timezone) {
    for (const other of slotsList.querySelectorAll('.pp-slot')) other.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    selected = slot;
    selectedEl.textContent = rescheduleSummary(slot, { weekday, timezone });
    confirmEl.hidden = false;
  }

  async function refreshDay({ keepAlert = false } = {}) {
    if (!keepAlert) hideAlert();
    clearSlots();
    const date = dateInput.value;
    if (!date) {
      slotsStatus.textContent = P.chooseDate;
      return;
    }
    const current = ++dayRequest;
    slotsStatus.textContent = P.loadingSlots;
    main.dataset.slots = 'loading';
    const result = await loadRescheduleDay(token, { date, professionalId: professionalSelect.value });
    if (current !== dayRequest) return;
    const wanted = pendingStart;
    pendingStart = null;
    if (!result.ok) {
      main.dataset.slots = 'error';
      if (result.kind === 'notFound') return showInvalid();
      if (result.kind === 'changed' || result.kind === 'notChangeable' || result.kind === 'limit') {
        return reloadWith(result.message);
      }
      slotsStatus.textContent = result.message;
      return;
    }
    const { day, timezone } = result;
    if (timezone) showTimeZone(timezone);
    if (day.slots.length === 0) {
      slotsStatus.textContent = P.emptyDay;
      main.dataset.slots = 'ready';
      return;
    }
    slotsStatus.textContent = slotsReadyMessage(day.slots.length, day.date, day.weekday);
    for (const slot of day.slots) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pp-slot';
      button.setAttribute('aria-pressed', 'false');
      button.textContent = slot.label;
      button.addEventListener('click', () => {
        hideAlert();
        choose(button, slot, day.weekday, timezone);
      });
      item.append(button);
      slotsList.append(item);
      if (wanted && slot.start === wanted) choose(button, slot, day.weekday, timezone);
    }
    main.dataset.slots = 'ready';
  }

  /** AF-23 (critério 8): todo aviso de fuso do painel pelo texto único. */
  function showTimeZone(timezone) {
    for (const el of main.querySelectorAll('[data-tz-notice]')) el.textContent = timeZoneNotice(timezone);
  }

  function openReschedule() {
    if (!summary) return;
    hideAlert();
    hideSuggestions();
    professionalSelect.replaceChildren();
    for (const choice of professionalChoices(summary)) {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      professionalSelect.append(option);
    }
    const { today, maxDate } = summary.reschedule;
    dateInput.min = today;
    dateInput.max = maxDate;
    dateInput.value = summary.start.slice(0, 10) >= today ? summary.start.slice(0, 10) : today;
    $('.mg-reschedule-policy').textContent = summary.policy;
    // O aviso aparece ANTES da primeira consulta (com o fuso do resumo) e é refeito com o da resposta.
    showTimeZone(summary.timezone);
    show(rescheduleEl);
    refreshDay();
  }

  function renderSuggestions(suggestions) {
    suggestionsList.replaceChildren();
    for (const suggestion of suggestions) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pp-suggestion';
      button.textContent = suggestionLabel(suggestion);
      button.addEventListener('click', () => {
        hideAlert();
        hideSuggestions();
        pendingStart = suggestion.start;
        const date = suggestion.start.slice(0, 10);
        if (date !== dateInput.value) dateInput.value = date;
        refreshDay();
      });
      item.append(button);
      suggestionsList.append(item);
    }
    suggestionsEl.hidden = suggestions.length === 0;
  }

  $('.mg-reschedule-button').addEventListener('click', openReschedule);
  $('.mg-reschedule-back').addEventListener('click', () => {
    hideAlert();
    if (summary) renderSummary(summary);
  });
  professionalSelect.addEventListener('change', () => {
    hideSuggestions();
    refreshDay();
  });
  dateInput.addEventListener('change', () => {
    hideSuggestions();
    refreshDay();
  });

  confirmButton.addEventListener('click', async () => {
    if (busy || !summary || !selected) return;
    hideAlert();
    hideSuggestions();
    setBusy(confirmButton, true, P.rescheduleButton, P.rescheduling);
    let result;
    try {
      result = await rescheduleAppointment(token, {
        start: selected.start,
        professionalId: professionalSelect.value,
        version: summary.version,
      });
    } finally {
      setBusy(confirmButton, false, P.rescheduleButton, P.rescheduling);
    }
    if (result.ok) {
      renderSummary(result.summary, { message: P.rescheduled, done: P.rescheduled });
      return;
    }
    if (result.kind === 'notFound') return showInvalid();
    if (result.kind === 'slot') {
      // Mantém profissional e data (critério 30); a lista do dia é recarregada.
      showAlert(result.suggestions.length > 0 ? result.message : `${result.message} ${P.noSuggestions}`);
      renderSuggestions(result.suggestions);
      refreshDay({ keepAlert: true });
      return;
    }
    if (result.kind === 'changed' || result.kind === 'notChangeable' || result.kind === 'limit') {
      return reloadWith(result.message);
    }
    showAlert(result.message);
  });

  // ---- Carga ----
  (async () => {
    const result = await loadManage(token);
    if (result.ok) return renderSummary(result.summary, { focus: false });
    if (result.kind === 'notFound') return showInvalid();
    loading.hidden = true;
    showAlert(result.message);
  })();
}
