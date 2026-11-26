// Seção de horários da página pública (AF-10, 4.4). Todo texto entra por textContent; o relógio e
// o fuso do navegador não entram em nada (hoje e fuso vêm do servidor).
import {
  loadAvailability,
  createLatestOnly,
  professionalOptionsFor,
  readSelection,
  selectionToSearch,
  selectedSummary,
  emptyDayMessage,
  readyMessage,
  BOOKING_MESSAGES,
} from './public-booking-controller.js';
import { ANY_PROFESSIONAL, AVAILABILITY_MESSAGES, BOOKING_HORIZON_DAYS } from '/shared/availability.js';
import { addLocalDays, parseLocalDate } from '/shared/zoned-time.js';

const section = document.querySelector('.pp-booking');

if (section) start(section);

function start(root) {
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

  const professionalOptions = [...professionalSelect.options].map((el) => ({
    el,
    value: el.value,
    serviceIds: (el.dataset.services || '').split(' ').filter(Boolean),
  }));
  const serviceValues = new Set([...serviceSelect.options].map((o) => o.value).filter(Boolean));
  const latest = createLatestOnly();
  let markedReady = false;

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

  function clearSlots() {
    list.replaceChildren();
    confirm.hidden = true;
    selectedEl.textContent = '';
  }

  function updateUrl() {
    const search = selectionToSearch(selection());
    history.replaceState(null, '', `${location.pathname}${search}${location.hash}`);
  }

  function serviceName() {
    const option = serviceSelect.selectedOptions[0];
    return option ? option.textContent.replace(/ · [^·]*$/, '') : '';
  }

  function renderSlots(result) {
    clearSlots();
    const { day } = result;
    if (day.slots.length === 0) {
      status.textContent = emptyDayMessage({
        any: professionalSelect.value === ANY_PROFESSIONAL,
        anyEligible: result.anyEligible,
      });
      return;
    }
    status.textContent = readyMessage(day.slots.length, day.date, day.weekday);
    const name = serviceName();
    for (const slot of day.slots) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pp-slot';
      button.setAttribute('aria-pressed', 'false');
      button.textContent = slot.label;
      button.addEventListener('click', () => {
        for (const other of list.querySelectorAll('.pp-slot')) other.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        selectedEl.textContent = selectedSummary(slot, { serviceName: name, timezone, weekday: day.weekday });
        confirm.hidden = false;
      });
      item.append(button);
      list.append(item);
    }
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

  async function refresh() {
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
      clearSlots();
      status.textContent = result.message;
      root.dataset.state = 'error';
      return;
    }
    applyServerClock(result);
    renderSlots(result);
    root.dataset.state = 'ready';
    // Marca de desempenho da primeira lista pronta (npm run perf, critério 29).
    if (!markedReady && typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      markedReady = true;
      performance.mark('pp-booking-ready');
    }
  }

  function onChange() {
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
