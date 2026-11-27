import { submitForgotPassword } from './forgot-password-controller.js';

const form = document.getElementById('forgot-form');
const button = document.getElementById('submit-button');
const formError = document.getElementById('form-error');
const status = document.getElementById('request-status');
const emailError = document.getElementById('email-error');

function clear() {
  emailError.textContent = '';
  form.elements.email.removeAttribute('aria-invalid');
  formError.textContent = '';
  status.textContent = '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clear();
  button.disabled = true;
  try {
    const result = await submitForgotPassword({ email: form.elements.email.value }, { fetchFn: (...args) => fetch(...args) });
    if (result.ok) {
      // Mesma região e mesmo foco para qualquer conta (critério 41).
      status.textContent = result.message;
      status.focus();
      return;
    }
    if (result.fields.email) {
      emailError.textContent = result.fields.email;
      form.elements.email.setAttribute('aria-invalid', 'true');
      form.elements.email.focus();
      return;
    }
    formError.textContent = result.message;
    formError.focus();
  } finally {
    button.disabled = false;
  }
});
