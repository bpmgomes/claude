import { loadBusiness } from './business-controller.js';
import { logout } from './login-controller.js';
import { browserFetch, renderLogo } from './business-form.js';
import { loadProfessionals } from './professionals-controller.js';
import {
  loadHours,
  saveHours,
  timeOptions,
  copyDay,
  copyFromProfessional,
  isDirty,
  errorsByInterval,
  emptyWeek,
  EMPTY_HOURS_MESSAGE,
} from './hours-controller.js';
import { PROFESSIONAL_ID_RE } from '/shared/professionals.js';
import { WEEKDAYS, WEEKDAY_LABELS, INTERVALS_PER_DAY_MAX } from '/shared/working-hours.js';

const START_OPTIONS = timeOptions({ forEnd: false });
const END_OPTIONS = timeOptions({ forEnd: true });
const NEW_INTERVAL = Object.freeze({ start: '09:00', end: '18:00' });
const UNSAVED_QUESTION = 'Há alterações não salvas. Deseja descartá-las?';

const navigate = (url) => window.location.assign(url);

const nameEl = document.getElementById('business-name');
const logoPreview = document.getElementById('logo-preview');
const logoutButton = document.getElementById('logout-button');
const pageStatus = document.getElementById('page-status');
const notFoundEl = document.getElementById('not-found');
const section = document.getElementById('hours-section');
const professionalSelect = document.getElementById('professional-select');
const copyFromSelect = document.getElementById('copy-from');
const emptyState = document.getElementById('empty-state');
const noServices = document.getElementById('no-services');
const form = document.getElementById('hours-form');
const daysBox = document.getElementById('days');
const formError = document.getElementById('form-error');
const saveWarning = document.getElementById('save-warning');
const saveStatus = document.getElementById('save-status');
const saveButton = document.getElementById('save-button');

/** Profissionais ativos do negócio. */
let professionals = [];
/** Profissional em edição. */
let currentId = null;
/** Grade gravada (resposta do servidor) e grade em edição. */
let saved = emptyWeek();
let current = emptyWeek();
/** Erros por intervalo/dia (errorsByInterval). */
let errors = new Map();

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

const dirty = () => isDirty(saved, current);

// Critério 26: aviso antes de sair com alterações não salvas.
window.addEventListener('beforeunload', (event) => {
  if (!dirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

function makeSelect(options, value, label) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option;
    el.textContent = option;
    select.append(el);
  }
  select.value = options.includes(value) ? value : options[0];
  return select;
}

function errorLine(messages) {
  const p = document.createElement('p');
  p.className = 'field-error';
  p.setAttribute('aria-live', 'polite');
  p.textContent = messages ? messages.join(' ') : '';
  return p;
}

/** Intervalos atuais do dia (os handlers leem daqui, nunca do dia capturado no render). */
function intervalsOf(weekday) {
  const day = current.find((d) => d.weekday === weekday);
  return day ? day.intervals : [];
}

function setDay(weekday, intervals) {
  current = current.map((d) => (d.weekday === weekday ? { weekday, intervals } : d));
}

function renderInterval(day, interval, n) {
  const label = WEEKDAY_LABELS[day.weekday];
  const row = document.createElement('div');
  row.className = 'interval-row';

  const start = makeSelect(START_OPTIONS, interval.start, `${label}, intervalo ${n + 1}: início`);
  const end = makeSelect(END_OPTIONS, interval.end, `${label}, intervalo ${n + 1}: fim`);
  const messages = errors.get(`${day.weekday}.${n}`);
  if (messages) {
    start.setAttribute('aria-invalid', 'true');
    end.setAttribute('aria-invalid', 'true');
  }
  const update = () => {
    const intervals = intervalsOf(day.weekday).map((i, k) => (k === n ? { start: start.value, end: end.value } : i));
    setDay(day.weekday, intervals);
  };
  start.addEventListener('change', update);
  end.addEventListener('change', update);

  const separator = document.createElement('span');
  separator.textContent = 'às';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button-secondary button-small';
  remove.textContent = 'Remover';
  remove.addEventListener('click', () => {
    setDay(
      day.weekday,
      intervalsOf(day.weekday).filter((_, k) => k !== n),
    );
    errors = new Map();
    render();
  });

  row.append(start, separator, end, remove, errorLine(messages));
  return row;
}

function renderCopyTargets(day, box) {
  const targets = document.createElement('div');
  targets.className = 'copy-targets';
  const checks = [];
  for (const weekday of WEEKDAYS) {
    if (weekday === day.weekday) continue;
    const wrap = document.createElement('div');
    wrap.className = 'field-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `copy-${day.weekday}-${weekday}`;
    input.value = String(weekday);
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.textContent = WEEKDAY_LABELS[weekday];
    wrap.append(input, label);
    targets.append(wrap);
    checks.push(input);
  }
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'button-small';
  apply.textContent = 'Copiar';
  apply.addEventListener('click', () => {
    const to = checks.filter((c) => c.checked).map((c) => Number(c.value));
    current = copyDay(current, day.weekday, to);
    errors = new Map();
    render();
  });
  targets.append(apply);
  box.replaceChildren(targets);
}

function renderDay(day) {
  const label = WEEKDAY_LABELS[day.weekday];
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'hours-day';
  const legend = document.createElement('legend');
  legend.textContent = label;
  fieldset.append(legend);

  const works = document.createElement('div');
  works.className = 'field-checkbox';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = `works-${day.weekday}`;
  toggle.checked = day.intervals.length > 0;
  const toggleLabel = document.createElement('label');
  toggleLabel.htmlFor = toggle.id;
  toggleLabel.textContent = 'Trabalha neste dia';
  works.append(toggle, toggleLabel);
  toggle.addEventListener('change', () => {
    setDay(day.weekday, toggle.checked ? [{ ...NEW_INTERVAL }] : []);
    errors = new Map();
    render();
  });
  fieldset.append(works);

  day.intervals.forEach((interval, n) => fieldset.append(renderInterval(day, interval, n)));
  fieldset.append(errorLine(errors.get(String(day.weekday))));

  if (day.intervals.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'service-actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'button-secondary button-small';
    add.textContent = 'Adicionar intervalo';
    add.disabled = day.intervals.length >= INTERVALS_PER_DAY_MAX;
    add.addEventListener('click', () => {
      const intervals = intervalsOf(day.weekday);
      if (intervals.length >= INTERVALS_PER_DAY_MAX) return;
      setDay(day.weekday, [...intervals, { ...NEW_INTERVAL }]);
      render();
    });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'button-secondary button-small';
    copy.textContent = 'Copiar para...';
    const copyBox = document.createElement('div');
    copy.addEventListener('click', () => {
      if (copyBox.childElementCount > 0) copyBox.replaceChildren();
      else renderCopyTargets(day, copyBox);
    });
    actions.append(add, copy);
    fieldset.append(actions, copyBox);
  }
  return fieldset;
}

function render() {
  daysBox.replaceChildren(...current.map(renderDay));
}

function renderStatus(hours) {
  emptyState.textContent = hours.hasHours ? '' : EMPTY_HOURS_MESSAGE;
  const professional = professionals.find((p) => p.id === currentId);
  noServices.hidden = !professional || Boolean(professional.bookable);
}

function fillSelect(select, list, { placeholder } = {}) {
  const options = [];
  if (placeholder) {
    const el = document.createElement('option');
    el.value = '';
    el.textContent = placeholder;
    options.push(el);
  }
  for (const p of list) {
    const el = document.createElement('option');
    el.value = p.id;
    el.textContent = p.name;
    options.push(el);
  }
  select.replaceChildren(...options);
}

function syncSelects() {
  fillSelect(professionalSelect, professionals);
  professionalSelect.value = currentId;
  fillSelect(
    copyFromSelect,
    professionals.filter((p) => p.id !== currentId),
    { placeholder: 'Escolha um profissional' },
  );
  copyFromSelect.value = '';
  copyFromSelect.disabled = professionals.length < 2;
}

function clearMessages() {
  formError.textContent = '';
  saveWarning.textContent = '';
  saveStatus.textContent = '';
}

function showNotFound() {
  section.hidden = true;
  notFoundEl.hidden = false;
}

async function openProfessional(id) {
  clearMessages();
  pageStatus.textContent = 'Carregando…';
  const result = await loadHours(id, { fetchFn: browserFetch });
  pageStatus.textContent = '';
  if (!result.ok) {
    if (handleRedirect(result)) return;
    if (result.status === 404) showNotFound();
    else pageStatus.textContent = result.message;
    return;
  }
  currentId = id;
  saved = copyFromProfessional(result.hours);
  current = copyFromProfessional(result.hours);
  errors = new Map();
  window.history.replaceState(null, '', `/horarios?id=${encodeURIComponent(id)}`);
  syncSelects();
  renderStatus(result.hours);
  render();
  section.hidden = false;
}

professionalSelect.addEventListener('change', async () => {
  const id = professionalSelect.value;
  if (id === currentId) return;
  if (dirty() && !window.confirm(UNSAVED_QUESTION)) {
    professionalSelect.value = currentId;
    return;
  }
  await openProfessional(id);
});

copyFromSelect.addEventListener('change', async () => {
  const id = copyFromSelect.value;
  if (!id) return;
  clearMessages();
  copyFromSelect.disabled = true;
  const result = await loadHours(id, { fetchFn: browserFetch });
  copyFromSelect.disabled = false;
  copyFromSelect.value = '';
  if (!result.ok) {
    if (handleRedirect(result)) return;
    formError.textContent = result.message;
    return;
  }
  current = copyFromProfessional(result.hours);
  errors = new Map();
  render();
  saveStatus.textContent = 'Horários copiados. Revise e clique em "Salvar horários".';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();
  saveButton.disabled = true;
  const result = await saveHours(currentId, current, { fetchFn: browserFetch });
  saveButton.disabled = false;
  if (!result.ok) {
    if (handleRedirect(result)) return;
    if (result.status === 404) {
      showNotFound();
      return;
    }
    errors = errorsByInterval(result.fields);
    render();
    formError.textContent = result.message;
    return;
  }
  saved = copyFromProfessional(result.hours);
  current = copyFromProfessional(result.hours);
  errors = new Map();
  renderStatus(result.hours);
  render();
  saveStatus.textContent = 'Horários salvos.';
  if (result.warning) saveWarning.textContent = result.warning;
});

const business = await loadBusiness({ fetchFn: browserFetch });
if (business.status === 401) {
  navigate('/login');
} else if (business.status === 404) {
  navigate('/onboarding');
} else if (business.ok) {
  nameEl.textContent = business.business.name;
  renderLogo(logoPreview, business.business.logoUrl);
  const list = await loadProfessionals({ fetchFn: browserFetch });
  if (!list.ok) {
    if (!handleRedirect(list)) pageStatus.textContent = list.message;
  } else {
    professionals = list.professionals;
    const requested = new URLSearchParams(window.location.search).get('id');
    if (requested !== null && !PROFESSIONAL_ID_RE.test(requested)) {
      showNotFound();
    } else if (requested) {
      await openProfessional(requested);
    } else if (professionals.length > 0) {
      await openProfessional(professionals[0].id);
    } else {
      pageStatus.textContent = 'Cadastre um profissional antes de definir horários.';
    }
  }
} else {
  nameEl.textContent = 'Não foi possível carregar seus dados. Recarregue a página.';
}
