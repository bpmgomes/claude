import { submitBusiness, uploadLogo, loadBusiness, safePublicUrl } from './business-controller.js';
import { logout } from './login-controller.js';
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
const stepForm = document.getElementById('step-form');
const stepDone = document.getElementById('step-done');
const form = document.getElementById('business-form');
const formError = document.getElementById('form-error');
const submitButton = document.getElementById('submit-button');
const publicLink = document.getElementById('public-link');
const copyButton = document.getElementById('copy-link');
const copyStatus = document.getElementById('copy-status');
const logoInput = document.getElementById('logo');
const logoError = document.getElementById('logo-error');
const logoStatus = document.getElementById('logo-status');
const logoPreview = document.getElementById('logo-preview');
const continueButton = document.getElementById('continue-button');
const logoutButton = document.getElementById('logout-button');

let nextPath = '/servicos';

const slugField = setupSlugField(form, {
  status: document.getElementById('slug-status'),
  suggestionButton: document.getElementById('slug-suggestion'),
});

function showDone(business, redirectTo) {
  if (typeof redirectTo === 'string' && redirectTo.startsWith('/')) nextPath = redirectTo;
  const href = safePublicUrl(business.publicUrl);
  publicLink.textContent = business.publicUrl || '';
  if (href) publicLink.href = href;
  else publicLink.removeAttribute('href');
  renderLogo(logoPreview, business.logoUrl);
  stepForm.hidden = true;
  stepDone.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, formError);
  slugField.showSuggestion(null);
  submitButton.disabled = true;
  try {
    const result = await submitBusiness(readValues(form), { mode: 'create', fetchFn: browserFetch });
    if (result.ok) {
      showDone(result.business, result.redirectTo);
      return;
    }
    if (result.status === 401) return navigate('/login');
    if (result.status === 409 && !result.fields.slug) return navigate('/servicos'); // já tem negócio
    showErrors(form, formError, result.fields, result.message);
    if (result.suggestion) {
      slugField.markEdited();
      slugField.showSuggestion(result.suggestion);
    }
  } finally {
    submitButton.disabled = false;
  }
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(publicLink.textContent);
    copyStatus.textContent = 'Link copiado.';
  } catch {
    copyStatus.textContent = 'Não foi possível copiar. Selecione o link e copie manualmente.';
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
      renderLogo(logoPreview, result.business.logoUrl);
      logoStatus.textContent = 'Logo salvo.';
    } else {
      logoError.textContent = result.message;
    }
  } finally {
    logoInput.disabled = false;
    logoInput.value = '';
  }
});

continueButton.addEventListener('click', () => navigate(nextPath));

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  await logout({ fetchFn: browserFetch, navigate });
});

const current = await loadBusiness({ fetchFn: browserFetch });
if (current.status === 401) {
  navigate('/login');
} else if (current.ok) {
  navigate('/servicos'); // onboarding já concluído
} else if (current.status === 404) {
  loading.hidden = true;
  stepForm.hidden = false;
  form.elements.name.focus();
} else {
  loading.textContent = current.message || 'Não foi possível carregar seus dados. Recarregue a página.';
}
