import { requestJson } from './api.js';
import { logout } from './login-controller.js';

const greeting = document.getElementById('greeting');
const logoutButton = document.getElementById('logout-button');

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  await logout({
    fetchFn: (...args) => fetch(...args),
    navigate: (url) => window.location.assign(url),
  });
});

const res = await requestJson('/api/me');
if (res.status === 401) {
  window.location.assign('/login');
} else if (res.ok && res.body && res.body.user) {
  greeting.textContent = `Olá, ${res.body.user.name}`;
} else {
  greeting.textContent = 'Não foi possível carregar seus dados. Recarregue a página.';
}
