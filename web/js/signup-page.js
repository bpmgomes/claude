import { submitSignup } from './signup-controller.js';

const FIELDS = ['name', 'email', 'password'];

const form = document.getElementById('signup-form');
const button = document.getElementById('submit-button');
const formError = document.getElementById('form-error');

function clearErrors() {
  for (const field of FIELDS) {
    document.getElementById(`${field}-error`).textContent = '';
    form.elements[field].removeAttribute('aria-invalid');
  }
  formError.textContent = '';
}

function showErrors(fields, message) {
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  button.disabled = true;
  try {
    const values = {
      name: form.elements.name.value,
      email: form.elements.email.value,
      password: form.elements.password.value,
    };
    const result = await submitSignup(values, {
      fetchFn: (...args) => fetch(...args),
      navigate: (url) => window.location.assign(url),
    });
    if (!result.ok) showErrors(result.fields, result.message);
  } finally {
    button.disabled = false;
  }
});
