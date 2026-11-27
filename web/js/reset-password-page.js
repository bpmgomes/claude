import { submitResetPassword, readResetToken, RESET_FIELDS } from './reset-password-controller.js';

// Decisão 2: o token é lido do fragmento, guardado só nesta variável do módulo e tirado da barra de
// endereço antes de qualquer `fetch`. Nada em localStorage nem sessionStorage. Abrir um link novo na
// mesma aba é navegação só de fragmento (sem recarregar): o `hashchange` lê o token novo (QA F1).
let token = takeToken();

function takeToken() {
  const value = readResetToken(window.location.hash);
  history.replaceState(null, '', '/redefinir-senha');
  return value;
}

const form = document.getElementById('reset-form');
const button = document.getElementById('submit-button');
const formError = document.getElementById('form-error');
const linkInvalid = document.getElementById('link-invalid');
const toggle = document.getElementById('toggle-password');

function showLinkInvalid() {
  form.hidden = true;
  linkInvalid.hidden = false;
  document.getElementById('request-new-link').focus();
}

function clearErrors() {
  for (const field of RESET_FIELDS) {
    document.getElementById(`${field}-error`).textContent = '';
    form.elements[field].removeAttribute('aria-invalid');
  }
  formError.textContent = '';
}

function showErrors(fields, message) {
  let first = null;
  for (const field of RESET_FIELDS) {
    const msg = fields[field];
    if (!msg) continue;
    document.getElementById(`${field}-error`).textContent = msg;
    form.elements[field].setAttribute('aria-invalid', 'true');
    first = first || form.elements[field];
  }
  if (first) first.focus();
  else {
    formError.textContent = message || '';
    formError.focus();
  }
}

/** Estado inicial da tela para o token atual: sem mensagens, campos vazios, senha oculta. */
function resetState() {
  clearErrors();
  form.reset();
  toggle.setAttribute('aria-pressed', 'false');
  for (const field of RESET_FIELDS) form.elements[field].type = 'password';
  if (token) {
    linkInvalid.hidden = true;
    form.hidden = false;
  } else {
    showLinkInvalid();
  }
}

resetState();

window.addEventListener('hashchange', () => {
  // O próprio replaceState não dispara hashchange; um fragmento vazio não é link novo.
  if (window.location.hash === '' || window.location.hash === '#') return;
  token = takeToken();
  resetState();
  if (token) form.elements.password.focus();
});

toggle.addEventListener('click', () => {
  const show = toggle.getAttribute('aria-pressed') !== 'true';
  // O nome acessível fica fixo; o estado vai em aria-pressed (critério 39).
  toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
  for (const field of RESET_FIELDS) form.elements[field].type = show ? 'text' : 'password';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  button.disabled = true;
  try {
    const result = await submitResetPassword(
      { token, password: form.elements.password.value, passwordConfirmation: form.elements.passwordConfirmation.value },
      { fetchFn: (...args) => fetch(...args), navigate: (url) => window.location.assign(url) },
    );
    if (result.ok) return;
    if (result.linkInvalid) showLinkInvalid();
    else showErrors(result.fields, result.message);
  } finally {
    button.disabled = false;
  }
});
