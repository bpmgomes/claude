// Helpers de DOM compartilhados pelo onboarding e pela edição do negócio.
// Todo texto vindo do servidor é escrito com textContent.
import { suggestSlugFromName, checkSlugAvailability, safeLogoUrl } from './business-controller.js';

export const FIELDS = ['name', 'address', 'phone', 'slug'];
const DEBOUNCE_MS = 400;

export const browserFetch = (...args) => fetch(...args);

export function readValues(form) {
  const values = {};
  for (const field of FIELDS) values[field] = form.elements[field].value;
  return values;
}

export function clearErrors(form, formError) {
  for (const field of FIELDS) {
    document.getElementById(`${field}-error`).textContent = '';
    form.elements[field].removeAttribute('aria-invalid');
  }
  formError.textContent = '';
}

export function showErrors(form, formError, fields, message) {
  let first = null;
  for (const field of FIELDS) {
    const msg = fields[field];
    if (!msg) continue;
    document.getElementById(`${field}-error`).textContent = msg;
    form.elements[field].setAttribute('aria-invalid', 'true');
    first = first || form.elements[field];
  }
  if (!first) formError.textContent = message || '';
  if (first) first.focus();
}

/**
 * Pré-preenche o slug a partir do nome (enquanto o dono não editá-lo), checa a
 * disponibilidade com debounce e oferece o botão "Usar {sugestão}".
 * @returns {{ showSuggestion: (suggestion?: string) => void, markEdited: () => void }}
 */
export function setupSlugField(form, { status, suggestionButton, autofill = true }) {
  const slugInput = form.elements.slug;
  let edited = !autofill;
  let timer = null;
  let sequence = 0;

  function showSuggestion(suggestion) {
    if (typeof suggestion === 'string' && suggestion) {
      suggestionButton.textContent = `Usar ${suggestion}`;
      suggestionButton.dataset.slug = suggestion;
      suggestionButton.hidden = false;
    } else {
      suggestionButton.hidden = true;
      delete suggestionButton.dataset.slug;
    }
  }

  function scheduleCheck() {
    clearTimeout(timer);
    status.textContent = '';
    showSuggestion(null);
    const value = slugInput.value;
    if (!value) return;
    timer = setTimeout(async () => {
      const current = ++sequence;
      const result = await checkSlugAvailability(value, { fetchFn: browserFetch });
      if (current !== sequence || slugInput.value !== value) return;
      if (!result.ok) {
        status.textContent = result.message;
        return;
      }
      if (result.available) {
        status.textContent = 'Link disponível.';
      } else {
        status.textContent = result.message || '';
        showSuggestion(result.suggestion);
      }
    }, DEBOUNCE_MS);
  }

  form.elements.name.addEventListener('input', () => {
    if (edited) return;
    slugInput.value = suggestSlugFromName(form.elements.name.value);
    scheduleCheck();
  });
  slugInput.addEventListener('input', () => {
    edited = true;
    scheduleCheck();
  });
  suggestionButton.addEventListener('click', () => {
    const suggestion = suggestionButton.dataset.slug;
    if (!suggestion) return;
    slugInput.value = suggestion;
    edited = true;
    document.getElementById('slug-error').textContent = '';
    slugInput.removeAttribute('aria-invalid');
    scheduleCheck();
  });

  return {
    showSuggestion,
    markEdited() {
      edited = true;
    },
  };
}

/** Mostra a miniatura do logo, só com URL `/media/logos/...` do próprio site. */
export function renderLogo(img, logoUrl) {
  const safe = safeLogoUrl(logoUrl);
  if (safe) {
    img.src = safe;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
}
