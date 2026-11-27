import { loadBusiness } from './business-controller.js';
import { logout } from './login-controller.js';
import { browserFetch, renderLogo } from './business-form.js';
import { loadProfessionals } from './professionals-controller.js';
import {
  loadTimeBlocks,
  createTimeBlock,
  removeTimeBlock,
  describeTimeBlock,
  describeConflict,
  conflictsSummary,
  timeOptions,
  defaultFormTimes,
  EMPTY_TIME_BLOCKS_MESSAGE,
  ALL_PROFESSIONALS_LABEL,
  STILL_BOOKED_MESSAGE,
} from './time-blocks-controller.js';
import { TIME_BLOCK_MESSAGES } from '/shared/time-blocks.js';
import { timeZoneNotice } from '/shared/timezone-names.js';

const TIMES = timeOptions();
const ALL_VALUE = '*';
const REMOVE_QUESTION = 'Remover este bloqueio? O período volta a ficar disponível para novos agendamentos.';

const navigate = (url) => window.location.assign(url);

const nameEl = document.getElementById('business-name');
const logoPreview = document.getElementById('logo-preview');
const logoutButton = document.getElementById('logout-button');
const pageStatus = document.getElementById('page-status');
const section = document.getElementById('time-blocks-section');

const form = document.getElementById('time-block-form');
const targetSelect = document.getElementById('professionalId');
const allDay = document.getElementById('all-day');
const startDate = document.getElementById('start-date');
const endDate = document.getElementById('end-date');
const startDateLabel = document.getElementById('start-date-label');
const endDateLabel = document.getElementById('end-date-label');
const startTime = document.getElementById('start-time');
const endTime = document.getElementById('end-time');
const startTimeField = document.getElementById('start-time-field');
const endTimeField = document.getElementById('end-time-field');
const reasonKind = document.getElementById('reasonKind');
const reasonNote = document.getElementById('reasonNote');
const formError = document.getElementById('form-error');
const saveWarning = document.getElementById('save-warning');
const saveStatus = document.getElementById('save-status');
const saveButton = document.getElementById('save-button');

const panel = document.getElementById('conflicts-panel');
const conflictsChanged = document.getElementById('conflicts-changed');
const conflictsSummaryEl = document.getElementById('conflicts-summary');
const conflictsList = document.getElementById('conflicts-list');
const confirmButton = document.getElementById('confirm-button');
const cancelButton = document.getElementById('cancel-button');

const filterProfessional = document.getElementById('filter-professional');
const filterFrom = document.getElementById('filter-from');
const filterTo = document.getElementById('filter-to');
const filterError = document.getElementById('filter-error');
const emptyState = document.getElementById('empty-state');
const truncatedEl = document.getElementById('truncated');
const list = document.getElementById('time-block-list');

const ERROR_TARGETS = {
  professionalId: { el: document.getElementById('professionalId-error'), input: targetSelect },
  start: { el: document.getElementById('start-error'), input: startDate },
  end: { el: document.getElementById('end-error'), input: endDate },
  reasonKind: { el: document.getElementById('reasonKind-error'), input: reasonKind },
  reasonNote: { el: document.getElementById('reasonNote-error'), input: reasonNote },
};

/** Fuso do negócio (da resposta do GET), usado só na validação local. */
let timeZone;
/** Formulário e token do 409 de conflitos à espera de confirmação. */
let pending = null;

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  await logout({ fetchFn: browserFetch, navigate });
});

function handleRedirect(result) {
  if (result.redirectTo) {
    navigate(result.redirectTo);
    return true;
  }
  return false;
}

function option(value, label) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}

function fillTimes(select, value) {
  select.replaceChildren(...TIMES.map((t) => option(t, t)));
  select.value = TIMES.includes(value) ? value : TIMES[0];
}

function fillProfessionals(professionals) {
  targetSelect.replaceChildren(
    option(ALL_VALUE, ALL_PROFESSIONALS_LABEL),
    ...professionals.map((p) => option(p.id, p.name)),
  );
  filterProfessional.replaceChildren(
    option('', 'Todos os bloqueios'),
    ...professionals.map((p) => option(p.id, p.name)),
    option('all', 'Só os de todos os profissionais'),
  );
}

function syncAllDay() {
  const whole = allDay.checked;
  startTimeField.hidden = whole;
  endTimeField.hidden = whole;
  startDateLabel.textContent = whole ? 'Primeiro dia' : 'Início';
  endDateLabel.textContent = whole ? 'Último dia' : 'Fim';
}
allDay.addEventListener('change', syncAllDay);

function readForm() {
  return {
    professionalId: targetSelect.value === ALL_VALUE ? null : targetSelect.value,
    allDay: allDay.checked,
    startDate: startDate.value,
    startTime: startTime.value,
    endDate: endDate.value,
    endTime: endTime.value,
    reasonKind: reasonKind.value,
    reasonNote: reasonNote.value,
  };
}

function clearErrors() {
  for (const { el, input } of Object.values(ERROR_TARGETS)) {
    el.textContent = '';
    input.removeAttribute('aria-invalid');
  }
  formError.textContent = '';
  saveWarning.textContent = '';
  saveStatus.textContent = '';
}

function showErrors(fields, message) {
  for (const [key, text] of Object.entries(fields || {})) {
    const target = ERROR_TARGETS[key];
    if (!target || typeof text !== 'string') continue;
    target.el.textContent = text;
    target.input.setAttribute('aria-invalid', 'true');
  }
  formError.textContent = message || '';
}

function hidePanel() {
  pending = null;
  panel.hidden = true;
  conflictsList.replaceChildren();
  conflictsChanged.textContent = '';
}

function showPanel(result, formValues) {
  pending = { form: formValues, token: result.conflictsToken };
  conflictsChanged.textContent = result.changed ? TIME_BLOCK_MESSAGES.conflictsChanged : '';
  conflictsSummaryEl.textContent = conflictsSummary(result.conflictsTotal, result.conflicts.length);
  conflictsList.replaceChildren(
    ...result.conflicts.map((item) => {
      const c = describeConflict(item);
      const li = document.createElement('li');
      li.className = 'service-item';
      const info = document.createElement('div');
      info.className = 'service-info';
      const when = document.createElement('p');
      when.className = 'service-name';
      when.textContent = c.when;
      const who = document.createElement('p');
      who.className = 'service-meta conflict-name';
      who.textContent = `${c.serviceName} · ${c.professionalName} · ${c.customerName}`;
      info.append(when, who);
      li.append(info);
      return li;
    }),
  );
  panel.hidden = false;
  confirmButton.focus();
}

async function submit(formValues, token) {
  clearErrors();
  saveButton.disabled = true;
  confirmButton.disabled = true;
  const result = await createTimeBlock(formValues, { fetchFn: browserFetch, confirmConflictsToken: token, timeZone });
  saveButton.disabled = false;
  confirmButton.disabled = false;
  if (!result.ok) {
    if (result.needsConfirmation) {
      showPanel(result, formValues);
      return;
    }
    hidePanel();
    if (handleRedirect(result)) return;
    showErrors(result.fields, result.message);
    return;
  }
  hidePanel();
  reasonNote.value = '';
  saveStatus.textContent = 'Bloqueio criado.';
  const warnings = [...result.warnings];
  if (result.acknowledgedConflictsCount > 0) warnings.push(STILL_BOOKED_MESSAGE);
  saveWarning.textContent = warnings.join(' ');
  await refreshList();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hidePanel();
  await submit(readForm());
});

confirmButton.addEventListener('click', async () => {
  if (!pending) return;
  await submit(pending.form, pending.token);
});

cancelButton.addEventListener('click', () => {
  hidePanel();
  saveStatus.textContent = 'Nada foi bloqueado.';
});

function renderItem(block) {
  const { targetLabel, periodLabel, reasonLabel } = describeTimeBlock(block);
  const li = document.createElement('li');
  li.className = 'service-item time-block-item';
  const info = document.createElement('div');
  info.className = 'service-info';
  const target = document.createElement('p');
  target.className = 'service-name time-block-target';
  target.textContent = targetLabel;
  const period = document.createElement('p');
  period.className = 'service-meta';
  period.textContent = periodLabel;
  info.append(target, period);
  if (reasonLabel) {
    const reason = document.createElement('p');
    reason.className = 'service-meta time-block-reason';
    reason.textContent = reasonLabel;
    info.append(reason);
  }
  const actions = document.createElement('div');
  actions.className = 'service-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button-secondary button-small';
  remove.textContent = 'Remover';
  remove.addEventListener('click', async () => {
    if (!window.confirm(REMOVE_QUESTION)) return;
    remove.disabled = true;
    const result = await removeTimeBlock(block.id, { fetchFn: browserFetch });
    if (!result.ok && handleRedirect(result)) return;
    if (!result.ok && result.status !== 404) {
      remove.disabled = false;
      pageStatus.textContent = result.message;
      return;
    }
    pageStatus.textContent = result.ok ? 'Bloqueio removido.' : result.message;
    await refreshList();
  });
  actions.append(remove);
  li.append(info, actions);
  return li;
}

/** @returns {Promise<object|null>} resposta do GET, ou null com erro */
async function refreshList() {
  filterError.textContent = '';
  const result = await loadTimeBlocks(
    { professionalId: filterProfessional.value, from: filterFrom.value, to: filterTo.value },
    { fetchFn: browserFetch },
  );
  if (!result.ok) {
    if (handleRedirect(result)) return null;
    const fieldMessages = Object.values(result.fields || {}).filter((m) => typeof m === 'string');
    filterError.textContent = fieldMessages.length > 0 ? fieldMessages.join(' ') : result.message;
    return null;
  }
  timeZone = result.timezone;
  // AF-23 (critério 10): formulário, lista e conflitos dizem o fuso do negócio, pelo texto único.
  for (const el of section.querySelectorAll('[data-tz-notice]')) el.textContent = timeZoneNotice(timeZone);
  list.replaceChildren(...result.timeBlocks.map(renderItem));
  const filtered = filterProfessional.value !== '' || filterFrom.value !== '' || filterTo.value !== '';
  emptyState.hidden = result.timeBlocks.length > 0;
  emptyState.textContent = filtered ? 'Nenhum bloqueio com estes filtros.' : EMPTY_TIME_BLOCKS_MESSAGE;
  truncatedEl.hidden = !result.truncated;
  return result;
}

for (const el of [filterProfessional, filterFrom, filterTo]) el.addEventListener('change', refreshList);

const business = await loadBusiness({ fetchFn: browserFetch });
if (business.status === 401) {
  navigate('/login');
} else if (business.status === 404) {
  navigate('/onboarding');
} else if (business.ok) {
  nameEl.textContent = business.business.name;
  renderLogo(logoPreview, business.business.logoUrl);
  const professionals = await loadProfessionals({ fetchFn: browserFetch });
  if (!professionals.ok) {
    if (!handleRedirect(professionals)) pageStatus.textContent = professionals.message;
  } else {
    fillProfessionals(professionals.professionals);
    const first = await refreshList();
    if (first) {
      // Datas padrão a partir de `now` do servidor (hora local do negócio), sem o relógio do navegador.
      const defaults = defaultFormTimes(first.now);
      startDate.value = defaults.date;
      endDate.value = defaults.date;
      fillTimes(startTime, defaults.startTime);
      fillTimes(endTime, defaults.endTime);
      syncAllDay();
      section.hidden = false;
    }
  }
} else {
  nameEl.textContent = 'Não foi possível carregar seus dados. Recarregue a página.';
}
