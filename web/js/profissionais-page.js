import { loadBusiness } from './business-controller.js';
import { logout } from './login-controller.js';
import { browserFetch, renderLogo, clearErrors, showErrors } from './business-form.js';
import {
  loadProfessionals,
  loadServiceOptions,
  submitProfessional,
  uploadPhoto,
  removePhoto,
  removeProfessional,
  safePhotoUrl,
  serviceChoices,
  describeProfessional,
} from './professionals-controller.js';
import { hasDuplicateName, PROFESSIONAL_MESSAGES } from '/shared/professionals.js';

const FORM_FIELDS = ['name', 'serviceIds', 'photo'];
const DEFAULT_AVATAR = '/img/avatar-default.svg';
const EMPTY_LIST = 'Nenhum profissional cadastrado ainda.';

const navigate = (url) => window.location.assign(url);

const nameEl = document.getElementById('business-name');
const logoPreview = document.getElementById('logo-preview');
const logoutButton = document.getElementById('logout-button');
const section = document.getElementById('professionals-section');
const form = document.getElementById('professional-form');
const formTitle = document.getElementById('form-title');
const formError = document.getElementById('form-error');
const saveStatus = document.getElementById('save-status');
const submitButton = document.getElementById('submit-button');
const cancelButton = document.getElementById('cancel-edit');
const nameWarning = document.getElementById('name-warning');
const choicesBox = document.getElementById('service-choices');
const noServices = document.getElementById('no-services');
const photoInput = document.getElementById('photo');
const photoPreview = document.getElementById('photo-preview');
const photoError = document.getElementById('photo-error');
const changePhotoButton = document.getElementById('change-photo');
const removePhotoButton = document.getElementById('remove-photo');
const listStatus = document.getElementById('list-status');
const list = document.getElementById('professional-list');

/** Profissional em edição (null = criando). */
let editing = null;
/** Lista carregada (para o aviso de homônimo). */
let professionals = [];
/** Serviços do negócio (ativos e desativados). */
let services = [];

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

function renderAvatar(img, photoUrl) {
  img.src = safePhotoUrl(photoUrl) || DEFAULT_AVATAR;
}

function renderChoices(linked) {
  const choices = serviceChoices(services, linked);
  const items = choices.map((choice) => {
    const row = document.createElement('div');
    row.className = 'field-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'service';
    input.value = choice.id;
    input.id = `service-${choice.id}`;
    input.checked = choice.checked;
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.textContent = choice.label;
    row.append(input, label);
    return row;
  });
  choicesBox.replaceChildren(...items);
  noServices.hidden = services.some((s) => s.active) || choices.length > 0;
}

function selectedServiceIds() {
  return [...choicesBox.querySelectorAll('input[type="checkbox"]')].filter((i) => i.checked).map((i) => i.value);
}

function updateNameWarning() {
  const duplicate = hasDuplicateName(form.elements.name.value, professionals, editing ? editing.id : undefined);
  nameWarning.textContent = duplicate ? PROFESSIONAL_MESSAGES.nameDuplicate : '';
}
form.elements.name.addEventListener('input', updateNameWarning);

function syncPhotoButtons() {
  const inEdit = Boolean(editing);
  changePhotoButton.hidden = !inEdit;
  removePhotoButton.hidden = !inEdit || !safePhotoUrl(editing && editing.photoUrl);
}

function resetForm() {
  editing = null;
  form.reset();
  clearErrors(form, formError, FORM_FIELDS);
  nameWarning.textContent = '';
  formTitle.textContent = 'Novo profissional';
  submitButton.textContent = 'Adicionar profissional';
  cancelButton.hidden = true;
  renderAvatar(photoPreview, null);
  renderChoices([]);
  syncPhotoButtons();
}

function startEdit(professional) {
  editing = professional;
  clearErrors(form, formError, FORM_FIELDS);
  saveStatus.textContent = '';
  form.elements.name.value = professional.name;
  photoInput.value = '';
  renderAvatar(photoPreview, professional.photoUrl);
  renderChoices(professional.services || []);
  updateNameWarning();
  formTitle.textContent = 'Editar profissional';
  submitButton.textContent = 'Salvar alterações';
  cancelButton.hidden = false;
  syncPhotoButtons();
  form.elements.name.focus();
}

cancelButton.addEventListener('click', resetForm);

function renderItem(professional) {
  const { servicesLabel, bookableLabel } = describeProfessional(professional);
  const item = document.createElement('li');
  item.className = 'professional-item';

  const avatar = document.createElement('img');
  avatar.className = 'avatar';
  avatar.width = 48;
  avatar.height = 48;
  avatar.alt = '';
  renderAvatar(avatar, professional.photoUrl);

  const info = document.createElement('div');
  info.className = 'professional-info';
  const title = document.createElement('p');
  title.className = 'professional-name';
  title.textContent = professional.name;
  const meta = document.createElement('p');
  meta.className = 'service-meta';
  meta.textContent = servicesLabel;
  info.append(title, meta);
  if (bookableLabel) {
    const badge = document.createElement('span');
    badge.className = 'badge-draft';
    badge.textContent = bookableLabel;
    info.append(badge);
  }

  const actions = document.createElement('div');
  actions.className = 'service-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'button-secondary button-small';
  edit.textContent = 'Editar';
  edit.addEventListener('click', () => startEdit(professional));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button-secondary button-small';
  remove.textContent = 'Remover';
  remove.addEventListener('click', () => removeItem(professional, remove));
  actions.append(edit, remove);

  item.append(avatar, info, actions);
  return item;
}

async function refresh() {
  listStatus.textContent = 'Carregando…';
  const result = await loadProfessionals({ fetchFn: browserFetch });
  if (!result.ok) {
    if (handleRedirect(result)) return;
    listStatus.textContent = result.message;
    return;
  }
  professionals = result.professionals;
  list.replaceChildren(...professionals.map(renderItem));
  listStatus.textContent = professionals.length > 0 ? '' : EMPTY_LIST;
}

async function removeItem(professional, button) {
  saveStatus.textContent = '';
  const question = `Remover ${professional.name}? Ele deixa de aparecer na agenda e na página pública.`;
  if (!window.confirm(question)) return;
  button.disabled = true;
  const result = await removeProfessional(professional.id, { fetchFn: browserFetch });
  button.disabled = false;
  if (!result.ok) {
    if (handleRedirect(result)) return;
    listStatus.textContent = result.message;
    return;
  }
  saveStatus.textContent = result.alreadyRemoved ? 'Este profissional já tinha sido removido.' : 'Profissional removido.';
  if (editing && editing.id === professional.id) resetForm();
  await refresh();
}

function showPhotoError(message) {
  photoError.textContent = message;
  photoInput.setAttribute('aria-invalid', 'true');
}

async function sendPhoto(id, file) {
  photoError.textContent = '';
  photoInput.removeAttribute('aria-invalid');
  const result = await uploadPhoto(id, file, { fetchFn: browserFetch });
  if (!result.ok) {
    if (handleRedirect(result)) return null;
    showPhotoError(result.message);
    return null;
  }
  return result.professional;
}

// Em edição, escolher um arquivo já envia a foto.
photoInput.addEventListener('change', async () => {
  if (!editing || !photoInput.files || photoInput.files.length === 0) return;
  const updated = await sendPhoto(editing.id, photoInput.files[0]);
  photoInput.value = '';
  if (!updated) return;
  editing = updated;
  renderAvatar(photoPreview, updated.photoUrl);
  syncPhotoButtons();
  saveStatus.textContent = 'Foto atualizada.';
  await refresh();
});

changePhotoButton.addEventListener('click', () => photoInput.click());

removePhotoButton.addEventListener('click', async () => {
  if (!editing) return;
  removePhotoButton.disabled = true;
  const result = await removePhoto(editing.id, { fetchFn: browserFetch });
  removePhotoButton.disabled = false;
  if (!result.ok) {
    if (handleRedirect(result)) return;
    showPhotoError(result.message);
    return;
  }
  editing = { ...editing, photoUrl: null };
  renderAvatar(photoPreview, null);
  syncPhotoButtons();
  saveStatus.textContent = 'Foto removida.';
  await refresh();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, formError, FORM_FIELDS);
  saveStatus.textContent = '';
  submitButton.disabled = true;
  const mode = editing ? 'update' : 'create';
  const pendingFile = mode === 'create' && photoInput.files && photoInput.files.length > 0 ? photoInput.files[0] : null;
  const values = { name: form.elements.name.value, serviceIds: selectedServiceIds() };
  const result = await submitProfessional(values, { mode, id: editing ? editing.id : undefined, fetchFn: browserFetch });
  if (!result.ok) {
    submitButton.disabled = false;
    if (handleRedirect(result)) return;
    showErrors(form, formError, result.fields || {}, result.message, FORM_FIELDS);
    return;
  }

  let professional = result.professional;
  const warning = result.warnings.find((w) => w && w.field === 'name');
  if (pendingFile) {
    // Criar com foto: POST e depois PUT da foto (decisão 14). Se a foto falhar, o
    // profissional já existe e o formulário passa para o modo edição com o erro na foto.
    const withPhoto = await sendPhoto(professional.id, pendingFile);
    if (!withPhoto) {
      submitButton.disabled = false;
      const photoMessage = photoError.textContent;
      await refresh();
      startEdit(professional);
      if (photoMessage) showPhotoError(photoMessage);
      saveStatus.textContent = 'Profissional salvo, mas a foto não foi enviada.';
      return;
    }
    professional = withPhoto;
  }
  submitButton.disabled = false;
  resetForm();
  saveStatus.textContent = mode === 'create' ? 'Profissional adicionado.' : 'Alterações salvas.';
  if (warning) saveStatus.textContent += ` ${warning.message}`;
  await refresh();
});

const current = await loadBusiness({ fetchFn: browserFetch });
if (current.status === 401) {
  navigate('/login');
} else if (current.status === 404) {
  navigate('/onboarding');
} else if (current.ok) {
  nameEl.textContent = current.business.name;
  renderLogo(logoPreview, current.business.logoUrl);
  const options = await loadServiceOptions({ fetchFn: browserFetch });
  if (!options.ok) {
    if (!handleRedirect(options)) listStatus.textContent = options.message;
  } else {
    services = options.services;
    resetForm();
    section.hidden = false;
    await refresh();
  }
} else {
  nameEl.textContent = 'Não foi possível carregar seus dados. Recarregue a página.';
}
