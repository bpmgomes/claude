import { loadBusiness, safePublicUrl } from './business-controller.js';
import { logout } from './login-controller.js';
import { browserFetch, renderLogo } from './business-form.js';

const navigate = (url) => window.location.assign(url);

const nameEl = document.getElementById('business-name');
const linkBox = document.getElementById('link-box');
const publicLink = document.getElementById('public-link');
const logoPreview = document.getElementById('logo-preview');
const logoutButton = document.getElementById('logout-button');

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  await logout({ fetchFn: browserFetch, navigate });
});

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
} else {
  nameEl.textContent = 'Não foi possível carregar seus dados. Recarregue a página.';
}
