import { loadBusiness, safePublicUrl } from './business-controller.js';
import { logout } from './login-controller.js';
import { browserFetch, renderLogo, clearErrors, showErrors } from './business-form.js';
import {
  loadServices,
  submitService,
  setServiceActive,
  describeService,
  deactivationNotice,
} from './services-controller.js';
import { DURATION_OPTIONS, formatDuration } from '/shared/services.js';

const SERVICE_FIELDS = ['name', 'durationMinutes', 'price', 'priceOnRequest'];
const EMPTY_LIST = 'Nenhum serviço cadastrado ainda.';
const EMPTY_FILTER = 'Nenhum serviço neste filtro.';

const navigate = (url) => window.location.assign(url);

const nameEl = document.getElementById('business-name');
const linkBox = document.getElementById('link-box');
const publicLink = document.getElementById('public-link');
const logoPreview = document.getElementById('logo-preview');
const logoutButton = document.getElementById('logout-button');
const section = document.getElementById('services-section');
const form = document.getElementById('service-form');
const formTitle = document.getElementById('form-title');
const formError = document.getElementById('form-error');
const saveStatus = document.getElementById('save-status');
const submitButton = document.getElementById('submit-button');
const cancelButton = document.getElementById('cancel-edit');
const statusFilter = document.getElementById('status-filter');
const listStatus = document.getElementById('list-status');
const list = document.getElementById('service-list');

/** id do serviço em edição (null = criando). */
let editingId = null;

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  await logout({ fetchFn: browserFetch, navigate });
});

for (const minutes of DURATION_OPTIONS) {
  const option = document.createElement('option');
  option.value = String(minutes);
  option.textContent = formatDuration(minutes);
  form.elements.durationMinutes.append(option);
}

function syncPriceField() {
  const onRequest = form.elements.priceOnRequest.checked;
  form.elements.price.disabled = onRequest;
  if (onRequest) form.elements.price.value = '';
}
form.elements.priceOnRequest.addEventListener('change', syncPriceField);

function readValues() {
  return {
    name: form.elements.name.value,
    durationMinutes: form.elements.durationMinutes.value,
    price: form.elements.price.value,
    priceOnRequest: form.elements.priceOnRequest.checked,
  };
}

function resetForm() {
  editingId = null;
  form.reset();
  syncPriceField();
  clearErrors(form, formError, SERVICE_FIELDS);
  formTitle.textContent = 'Novo serviço';
  submitButton.textContent = 'Adicionar serviço';
  cancelButton.hidden = true;
}

/** Preço em centavos -> texto do campo ("50,00"), só com inteiros. */
function priceInputValue(cents) {
  if (typeof cents !== 'number') return '';
  return `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

function startEdit(service) {
  editingId = service.id;
  clearErrors(form, formError, SERVICE_FIELDS);
  saveStatus.textContent = '';
  form.elements.name.value = service.name;
  form.elements.durationMinutes.value = String(service.durationMinutes);
  form.elements.priceOnRequest.checked = Boolean(service.priceOnRequest);
  form.elements.price.value = service.priceOnRequest ? '' : priceInputValue(service.priceCents);
  syncPriceField();
  formTitle.textContent = 'Editar serviço';
  submitButton.textContent = 'Salvar alterações';
  cancelButton.hidden = false;
  form.elements.name.focus();
}

cancelButton.addEventListener('click', resetForm);

function handleRedirect(result) {
  if (result.redirectTo) {
    navigate(result.redirectTo);
    return true;
  }
  return false;
}

function renderItem(service) {
  const { durationLabel, priceLabel } = describeService(service);
  const item = document.createElement('li');
  item.className = 'service-item';

  const info = document.createElement('div');
  info.className = 'service-info';
  const title = document.createElement('p');
  title.className = 'service-name';
  title.textContent = service.name;
  if (!service.active) {
    const badge = document.createElement('span');
    badge.className = 'badge-inactive';
    badge.textContent = 'Desativado';
    title.append(' ', badge);
  }
  const meta = document.createElement('p');
  meta.className = 'service-meta';
  meta.textContent = `${durationLabel} · ${priceLabel}`;
  info.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'service-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'button-secondary button-small';
  edit.textContent = 'Editar';
  edit.addEventListener('click', () => startEdit(service));

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'button-secondary button-small';
  toggle.textContent = service.active ? 'Desativar' : 'Reativar';
  toggle.addEventListener('click', () => toggleActive(service, toggle));
  actions.append(edit, toggle);

  item.append(info, actions);
  return item;
}

async function refresh() {
  listStatus.textContent = 'Carregando…';
  const result = await loadServices(statusFilter.value, { fetchFn: browserFetch });
  if (!result.ok) {
    if (handleRedirect(result)) return;
    listStatus.textContent = result.message;
    return;
  }
  list.replaceChildren(...result.services.map(renderItem));
  if (result.services.length > 0) listStatus.textContent = '';
  else listStatus.textContent = statusFilter.value === 'all' ? EMPTY_LIST : EMPTY_FILTER;
}

async function toggleActive(service, button) {
  saveStatus.textContent = '';
  if (service.active) {
    const question =
      `Desativar ${service.name}? Ele deixa de aparecer para novos agendamentos. ` +
      'Agendamentos já marcados continuam valendo.';
    if (!window.confirm(question)) return;
  }
  button.disabled = true;
  const result = await setServiceActive(service.id, !service.active, { fetchFn: browserFetch });
  button.disabled = false;
  if (!result.ok) {
    if (handleRedirect(result)) return;
    listStatus.textContent = result.message;
    return;
  }
  if (!service.active) {
    saveStatus.textContent = 'Serviço reativado.';
  } else {
    const notice = deactivationNotice(result.futureAppointmentsCount);
    saveStatus.textContent = notice ? `Serviço desativado. ${notice}` : 'Serviço desativado.';
  }
  if (editingId === service.id) resetForm();
  await refresh();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, formError, SERVICE_FIELDS);
  saveStatus.textContent = '';
  submitButton.disabled = true;
  const mode = editingId ? 'update' : 'create';
  const result = await submitService(readValues(), { mode, id: editingId, fetchFn: browserFetch });
  submitButton.disabled = false;
  if (!result.ok) {
    if (handleRedirect(result)) return;
    showErrors(form, formError, result.fields || {}, result.message, SERVICE_FIELDS);
    return;
  }
  resetForm();
  saveStatus.textContent = mode === 'create' ? 'Serviço adicionado.' : 'Alterações salvas.';
  await refresh();
});

statusFilter.addEventListener('change', refresh);

const current = await loadBusiness({ fetchFn: browserFetch });
if (current.status === 401) {
  navigate('/login');
} else if (current.status === 404) {
  navigate('/onboarding');
} else if (current.ok) {
  const { business } = current;
  nameEl.textContent = business.name;
  publicLink.textContent = business.publicUrl || '';
  const href = safePublicUrl(business.publicUrl);
  if (href) publicLink.href = href;
  linkBox.hidden = false;
  renderLogo(logoPreview, business.logoUrl);
  section.hidden = false;
  await refresh();
} else {
  nameEl.textContent = 'Não foi possível carregar seus dados. Recarregue a página.';
}
