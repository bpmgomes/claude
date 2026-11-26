// Horários (AF-10), "Seus dados" (AF-04) e confirmação (AF-11) da página pública. Só textContent;
// hoje e fuso vêm do servidor; nada fica guardado no navegador.
import {
  loadAvailability,
  createLatestOnly,
  professionalOptionsFor,
  readSelection,
  selectionToSearch,
  selectedSummary,
  emptyDayMessage,
  readyMessage,
  confirmBooking,
  createAttemptKeys,
  successDetails,
  safePhoneHref,
  suggestionLabel,
  BOOKING_MESSAGES,
} from './public-booking-controller.js';
import {
  CUSTOMER_FIELDS,
  checkCustomerField,
  checkCustomerForm,
  phoneDisplayOnBlur,
} from './customer-form-controller.js';
import { ANY_PROFESSIONAL, AVAILABILITY_MESSAGES, BOOKING_HORIZON_DAYS } from '/shared/availability.js';
import { addLocalDays, parseLocalDate } from '/shared/zoned-time.js';

/** UUID v4 por tentativa (critério 25); fora de contexto seguro, sem chave (o cabeçalho é opcional). */
const newAttemptKey = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '');

const section = document.querySelector('.pp-booking');
const customerFormEl = document.querySelector('#bk-customer');
const customerForm = customerFormEl ? startCustomerForm(customerFormEl) : null;

if (section) start(section, customerForm);

/** Valida ao sair do campo; ao digitar, só remove o erro que deixou de valer. Nunca apaga valores. */
function startCustomerForm(form) {
  const entries = CUSTOMER_FIELDS.map((field) => ({
    field,
    input: form.querySelector(`#bk-${field}`),
    error: form.querySelector(`#bk-${field}-erro`),
  })).filter((e) => e.input && e.error);

  // Texto reescrito só quando muda (sem anúncio repetido); `quiet` quando o foco vai ao campo.
  function show(entry, message, { quiet = false } = {}) {
    const text = message || '';
    entry.error.setAttribute('aria-live', quiet ? 'off' : 'polite');
    if (entry.error.textContent !== text) entry.error.textContent = text;
    if (message) entry.input.setAttribute('aria-invalid', 'true');
    else entry.input.removeAttribute('aria-invalid');
  }

  for (const entry of entries) {
    entry.input.addEventListener('blur', () => {
      const message = checkCustomerField(entry.field, entry.input.value);
      show(entry, message);
      if (!message && entry.field === 'phone') {
        const display = phoneDisplayOnBlur(entry.input.value);
        if (display !== entry.input.value) entry.input.value = display;
      }
    });
    entry.input.addEventListener('input', () => {
      if (entry.input.getAttribute('aria-invalid') !== 'true') return;
      if (checkCustomerField(entry.field, entry.input.value) === null) show(entry, null);
    });
  }

  /** Erros locais ou do servidor, com foco no primeiro inválido. @returns {boolean} houve erro */
  function applyErrors(fields) {
    const first = entries.find((e) => fields[e.field]);
    for (const entry of entries) show(entry, fields[entry.field] || null, { quiet: entry === first });
    if (first) first.input.focus();
    return Boolean(first);
  }

  return {
    form,
    values: () => Object.fromEntries(entries.map((e) => [e.field, e.input.value])),
    /** @returns {boolean} válido */
    validateAll() {
      const result = checkCustomerForm(this.values());
      return !applyErrors(result.ok ? {} : result.fields);
    },
    applyErrors,
  };
}

function start(root, customer) {
  const slug = root.dataset.slug || '';
  const bounds = { today: root.dataset.today || '', maxDate: root.dataset.maxDate || '' };
  let timezone = root.dataset.timezone || '';

  const serviceSelect = root.querySelector('#bk-service');
  const professionalSelect = root.querySelector('#bk-professional');
  const dateInput = root.querySelector('#bk-date');
  const timezoneEl = root.querySelector('.pp-timezone');
  const status = root.querySelector('.pp-status');
  const list = root.querySelector('.pp-slots');
  const confirm = root.querySelector('.pp-confirm');
  const selectedEl = root.querySelector('.pp-selected');
  const alertEl = root.querySelector('.pp-alert');
  const suggestionsEl = root.querySelector('.pp-suggestions');
  const suggestionsList = root.querySelector('.pp-suggestions-list');
  const confirmButton = root.querySelector('.pp-confirm-button');
  const success = document.querySelector('.pp-success');

  const professionalOptions = [...professionalSelect.options].map((el) => ({
    el,
    value: el.value,
    serviceIds: (el.dataset.services || '').split(' ').filter(Boolean),
  }));
  const serviceValues = new Set([...serviceSelect.options].map((o) => o.value).filter(Boolean));
  const latest = createLatestOnly();
  const attempts = createAttemptKeys(newAttemptKey);
  let markedReady = false;
  /** Horário escolhido. */
  let selected = null;
  /** Início a marcar quando a próxima lista chegar (sugestão). */
  let pendingStart = null;
  let submitting = false;

  root.hidden = false;
  root.dataset.state = 'idle';

  function selection() {
    return { serviceId: serviceSelect.value, professionalId: professionalSelect.value || ANY_PROFESSIONAL, date: dateInput.value };
  }

  /** Esconde os profissionais que não realizam o serviço; volta para "Qualquer" se preciso. */
  function filterProfessionals() {
    const visible = new Set(professionalOptionsFor(professionalOptions, serviceSelect.value).map((o) => o.value));
    for (const option of professionalOptions) {
      const show = visible.has(option.value);
      option.el.hidden = !show;
      option.el.disabled = !show;
    }
    if (!visible.has(professionalSelect.value)) professionalSelect.value = ANY_PROFESSIONAL;
  }

  function hideAlert() {
    alertEl.hidden = true;
    alertEl.textContent = '';
    suggestionsEl.hidden = true;
    suggestionsList.replaceChildren();
  }

  function showAlert(message) {
    alertEl.textContent = message;
    alertEl.hidden = false;
  }

  /** `keepConfirm`: mantém o formulário visível (critério 18). */
  function clearSlots({ keepConfirm = false } = {}) {
    list.replaceChildren();
    selected = null;
    if (!keepConfirm) {
      confirm.hidden = true;
      selectedEl.textContent = '';
    }
  }

  function updateUrl() {
    const search = selectionToSearch(selection());
    history.replaceState(null, '', `${location.pathname}${search}${location.hash}`);
  }

  function serviceName() {
    const option = serviceSelect.selectedOptions[0];
    return option ? option.textContent.replace(/ · [^·]*$/, '') : '';
  }

  function choose(button, slot, weekday, name) {
    for (const other of list.querySelectorAll('.pp-slot')) other.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    selected = slot;
    selectedEl.textContent = selectedSummary(slot, { serviceName: name, timezone, weekday });
    confirm.hidden = false;
  }

  function renderSlots(result, { keepConfirm = false } = {}) {
    clearSlots({ keepConfirm });
    const { day } = result;
    const wanted = pendingStart;
    pendingStart = null;
    if (day.slots.length === 0) {
      status.textContent = emptyDayMessage({
        any: professionalSelect.value === ANY_PROFESSIONAL,
        anyEligible: result.anyEligible,
      });
      if (wanted) status.textContent = BOOKING_MESSAGES.slotGone;
      if (keepConfirm) selectedEl.textContent = '';
      return;
    }
    status.textContent = readyMessage(day.slots.length, day.date, day.weekday);
    const name = serviceName();
    let marked = false;
    for (const slot of day.slots) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pp-slot';
      button.setAttribute('aria-pressed', 'false');
      button.textContent = slot.label;
      button.addEventListener('click', () => {
        hideAlert();
        choose(button, slot, day.weekday, name);
      });
      item.append(button);
      list.append(item);
      if (wanted && slot.start === wanted) {
        choose(button, slot, day.weekday, name);
        marked = true;
      }
    }
    if (wanted && !marked) status.textContent = BOOKING_MESSAGES.slotGone;
    if (keepConfirm && !selected) selectedEl.textContent = '';
  }

  /** Corrige o fuso e o intervalo de datas com o relógio do servidor (R9, critério 18). */
  function applyServerClock(result) {
    if (result.timezone) {
      timezone = result.timezone;
      timezoneEl.textContent = `Horários no fuso ${timezone}.`;
    }
    const today = result.now.slice(0, 10);
    if (parseLocalDate(today).ok) {
      bounds.today = today;
      bounds.maxDate = addLocalDays(today, BOOKING_HORIZON_DAYS);
      dateInput.min = bounds.today;
      dateInput.max = bounds.maxDate;
    }
  }

  async function refresh({ keepConfirm = false } = {}) {
    const current = selection();
    if (!current.serviceId) {
      latest.next();
      clearSlots();
      status.textContent = BOOKING_MESSAGES.chooseService;
      root.dataset.state = 'idle';
      return;
    }
    if (!parseLocalDate(current.date).ok) {
      latest.next();
      clearSlots();
      status.textContent = AVAILABILITY_MESSAGES.dateInvalid;
      root.dataset.state = 'error';
      return;
    }
    const { token, signal } = latest.next();
    root.dataset.state = 'loading';
    status.textContent = BOOKING_MESSAGES.loading;
    const result = await loadAvailability(slug, current, { signal });
    if (!latest.isCurrent(token)) return; // resposta de uma consulta anterior (critério 30)
    if (!result.ok) {
      clearSlots({ keepConfirm });
      status.textContent = result.message;
      root.dataset.state = 'error';
      return;
    }
    applyServerClock(result);
    renderSlots(result, { keepConfirm });
    root.dataset.state = 'ready';
    // Marca de desempenho da primeira lista pronta (npm run perf, critério 29).
    if (!markedReady && typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      markedReady = true;
      performance.mark('pp-booking-ready');
    }
  }

  /** Mudança de seleção: esconde o passo, limpa o alerta e a chave de tentativa. */
  function onChange() {
    hideAlert();
    attempts.reset();
    pendingStart = null;
    updateUrl();
    refresh();
  }

  serviceSelect.addEventListener('change', () => {
    filterProfessionals();
    onChange();
  });
  professionalSelect.addEventListener('change', onChange);
  dateInput.addEventListener('change', onChange);

  // "Ver horários" de cada serviço: escolhe o serviço, rola até a seção e consulta.
  for (const link of document.querySelectorAll('.pp-book[data-service-id]')) {
    link.addEventListener('click', (event) => {
      const id = link.dataset.serviceId;
      if (!serviceValues.has(id)) return;
      event.preventDefault();
      serviceSelect.value = id;
      filterProfessionals();
      root.scrollIntoView({ block: 'start' });
      serviceSelect.focus({ preventScroll: true });
      onChange();
    });
  }

  // ---- Confirmação (AF-11) ----

  function setBusy(busy) {
    confirmButton.disabled = busy;
    if (busy) confirmButton.setAttribute('aria-busy', 'true');
    else confirmButton.removeAttribute('aria-busy');
    confirmButton.textContent = busy ? BOOKING_MESSAGES.confirmingButton : BOOKING_MESSAGES.confirmButton;
  }

  /** Sugestões como botões (critério 18). */
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
        attempts.reset();
        pendingStart = suggestion.start;
        const date = suggestion.start.slice(0, 10);
        if (date !== dateInput.value) dateInput.value = date;
        updateUrl();
        refresh({ keepConfirm: true });
      });
      item.append(button);
      suggestionsList.append(item);
    }
    suggestionsEl.hidden = suggestions.length === 0;
  }

  /**
   * Bloco "Gerenciar agendamento" (AF-12, critério 8): só com link válido; só textContent. Nada fica
   * guardado no navegador nem vai para a URL (critério 9).
   */
  function showManage(manage) {
    const block = success.querySelector('.pp-success-manage');
    if (!block) return;
    const link = block.querySelector('.pp-success-manage-link');
    if (!manage || !manage.url || !link) {
      block.hidden = true;
      if (link) link.removeAttribute('href');
      return;
    }
    link.href = manage.url;
    block.querySelector('.pp-success-policy').textContent = manage.policy;
    block.querySelector('.pp-success-manage-url').textContent = manage.url;
    block.hidden = false;
  }

  /** Tela de sucesso, com foco no título (critério 27). */
  function showSuccess(appointment, manage) {
    latest.next();
    const details = success.querySelector('.pp-success-details');
    details.replaceChildren();
    for (const row of successDetails(appointment)) {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      details.append(dt, dd);
    }
    const link = success.querySelector('.pp-success-phone-link');
    const business = (appointment && appointment.business) || {};
    const href = safePhoneHref(business.phoneHref);
    if (link && href) {
      link.href = href;
      link.textContent = String(business.phoneDisplay);
    }
    showManage(manage);
    root.hidden = true;
    success.hidden = false;
    // Nada na URL (critério 28).
    history.replaceState(null, '', `${location.pathname}`);
    const title = success.querySelector('#sucesso-titulo');
    (title || success).focus();
  }

  async function submit() {
    if (submitting || !customer) return;
    if (!customer.validateAll()) return;
    if (!selected) {
      showAlert(BOOKING_MESSAGES.fieldsElsewhere);
      return;
    }
    const payload = {
      serviceId: serviceSelect.value,
      professionalId: professionalSelect.value || ANY_PROFESSIONAL,
      start: selected.start,
      customer: customer.values(),
    };
    const idempotencyKey = attempts.keyFor(payload);
    submitting = true;
    hideAlert();
    setBusy(true);
    let result;
    try {
      result = await confirmBooking(slug, payload, { idempotencyKey });
    } finally {
      submitting = false;
      setBusy(false);
    }
    if (result.ok) {
      attempts.reset();
      showSuccess(result.appointment, result.manage);
      return;
    }
    // Rede e 5xx: mesma chave na próxima tentativa; 4xx: chave nova.
    if (result.kind !== 'network' && result.kind !== 'unavailable') attempts.reset();
    if (result.kind === 'slot') {
      showAlert(result.suggestions.length > 0 ? result.message : `${result.message} ${BOOKING_MESSAGES.noSuggestions}`);
      renderSuggestions(result.suggestions);
      refresh({ keepConfirm: true });
      return;
    }
    if (result.kind === 'fields') {
      const hasCustomerErrors = customer.applyErrors(result.fields);
      if (result.otherFields) {
        showAlert(BOOKING_MESSAGES.fieldsElsewhere);
        refresh({ keepConfirm: true });
      } else if (!hasCustomerErrors) {
        showAlert(result.message);
      }
      return;
    }
    showAlert(result.message);
  }

  if (customer) {
    // Envio nativo sempre bloqueado (a CSP também tem form-action 'none').
    customer.form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
  }

  // Seleção inicial da URL. Sem serviço, nenhuma consulta na carga.
  const initial = readSelection(location.search, bounds);
  if (serviceValues.has(initial.serviceId)) serviceSelect.value = initial.serviceId;
  filterProfessionals();
  if (professionalOptions.some((o) => o.value === initial.professionalId && !o.el.hidden)) {
    professionalSelect.value = initial.professionalId;
  }
  dateInput.value = initial.date;
  if (serviceSelect.value) refresh();
}
