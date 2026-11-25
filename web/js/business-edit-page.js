import {
  submitBusiness,
  uploadLogo,
  removeLogo,
  loadBusiness,
  safePublicUrl,
} from './business-controller.js';
import {
  browserFetch,
  readValues,
  clearErrors,
  showErrors,
  setupSlugField,
  renderLogo,
} from './business-form.js';

const navigate = (url) => window.location.assign(url);

const loading = document.getElementById('loading');
const section = document.getElementById('edit-section');
const form = document.getElementById('business-form');
const formError = document.getElementById('form-error');
const saveStatus = document.getElementById('save-status');
const submitButton = document.getElementById('submit-button');
const slugPrefix = document.getElementById('slug-prefix');
const publicLink = document.getElementById('public-link');
const logoInput = document.getElementById('logo');
const logoError = document.getElementById('logo-error');
const logoStatus = document.getElementById('logo-status');
const logoPreview = document.getElementById('logo-preview');
const removeButton = document.getElementById('remove-logo');

const slugField = setupSlugField(form, {
  status: document.getElementById('slug-status'),
  suggestionButton: document.getElementById('slug-suggestion'),
  autofill: false,
});

function render(business) {
  form.elements.name.value = business.name;
  form.elements.address.value = business.address;
  form.elements.phone.value = business.phone;
  form.elements.slug.value = business.slug;
  const href = safePublicUrl(business.publicUrl);
  publicLink.textContent = business.publicUrl || '';
  if (href) {
    publicLink.href = href;
    const url = new URL(href);
    const base = `${url.host}${url.pathname}`;
    slugPrefix.textContent = base.endsWith(business.slug) ? base.slice(0, base.length - business.slug.length) : `${url.host}/`;
  } else {
    publicLink.removeAttribute('href');
  }
  renderLogo(logoPreview, business.logoUrl);
  removeButton.hidden = !business.logoUrl;
}

function handleAuth(status) {
  if (status === 401) navigate('/login');
  else if (status === 404) navigate('/onboarding');
  else return false;
  return true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, formError);
  saveStatus.textContent = '';
  slugField.showSuggestion(null);
  submitButton.disabled = true;
  try {
    const result = await submitBusiness(readValues(form), { mode: 'update', fetchFn: browserFetch });
    if (result.ok) {
      render(result.business);
      saveStatus.textContent = 'Dados salvos.';
      return;
    }
    if (handleAuth(result.status)) return;
    showErrors(form, formError, result.fields, result.message);
    if (result.suggestion) slugField.showSuggestion(result.suggestion);
  } finally {
    submitButton.disabled = false;
  }
});

logoInput.addEventListener('change', async () => {
  const file = logoInput.files && logoInput.files[0];
  logoError.textContent = '';
  logoStatus.textContent = '';
  if (!file) return;
  logoInput.disabled = true;
  logoStatus.textContent = 'Enviando…';
  try {
    const result = await uploadLogo(file, { fetchFn: browserFetch });
    logoStatus.textContent = '';
    if (result.ok) {
      render(result.business);
      logoStatus.textContent = 'Logo salvo.';
    } else if (!handleAuth(result.status)) {
      logoError.textContent = result.message;
    }
  } finally {
    logoInput.disabled = false;
    logoInput.value = '';
  }
});

removeButton.addEventListener('click', async () => {
  logoError.textContent = '';
  removeButton.disabled = true;
  try {
    const result = await removeLogo({ fetchFn: browserFetch });
    if (result.ok) {
      renderLogo(logoPreview, null);
      removeButton.hidden = true;
      logoStatus.textContent = 'Logo removido.';
    } else if (!handleAuth(result.status)) {
      logoError.textContent = result.message;
    }
  } finally {
    removeButton.disabled = false;
  }
});

const current = await loadBusiness({ fetchFn: browserFetch });
if (current.ok) {
  render(current.business);
  loading.hidden = true;
  section.hidden = false;
} else if (!handleAuth(current.status)) {
  loading.textContent = current.message || 'Não foi possível carregar seus dados. Recarregue a página.';
}
