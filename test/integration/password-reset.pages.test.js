// AF-03 (design 4.1 e 6.1, critérios 13 e 28): páginas de recuperação e o link condicional do /login.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildTestApp } from '../helpers/test-app.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';
import { tagsOf } from '../helpers/html.js';
import { MESSAGES } from '../../src/shared/validation.js';
import { PASSWORD_RESET_MESSAGES as M } from '../../src/shared/password-reset.js';
import { FORGOT_PASSWORD_MARKER, FORGOT_PASSWORD_BLOCK, renderLoginPage } from '../../src/modules/auth/login-page.js';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));

describe('páginas /esqueci-senha e /redefinir-senha (critério 13)', () => {
  test('200, HTML, no-store, no-referrer, noindex e a CSP do app; query não é ecoada', async () => {
    const { app } = await buildTestApp();
    try {
      const login = await app.inject({ method: 'GET', url: '/login' });
      for (const url of ['/esqueci-senha', '/redefinir-senha', '/redefinir-senha?token=x&y=<script>']) {
        const res = await app.inject({ method: 'GET', url });
        assert.equal(res.statusCode, 200, url);
        assert.match(res.headers['content-type'], /^text\/html; charset=utf-8/);
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['referrer-policy'], 'no-referrer');
        assert.equal(res.headers['x-robots-tag'], 'noindex');
        assert.equal(res.headers['content-security-policy'], login.headers['content-security-policy']);
        assert.equal(res.headers['set-cookie'], undefined);
        assert.equal(res.body.includes('<script>'), false);
      }
      const plain = await app.inject({ method: 'GET', url: '/redefinir-senha' });
      const withQuery = await app.inject({ method: 'GET', url: '/redefinir-senha?token=x' });
      assert.equal(withQuery.body, plain.body);
      assert.equal(plain.body, await readFile(`${WEB}redefinir-senha.html`, 'utf8'));
      // Os arquivos .html continuam caindo no 404 uniforme.
      for (const url of ['/esqueci-senha.html', '/redefinir-senha.html']) {
        assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, url);
      }
    } finally {
      await app.close();
    }
  });

  test('marcação: rótulos, autocomplete, regiões aria e textos do critério 36', async () => {
    const { app } = await buildTestApp();
    try {
      const forgot = (await app.inject({ method: 'GET', url: '/esqueci-senha' })).body;
      assert.ok(forgot.includes(`<h1>${M.requestTitle}</h1>`));
      assert.ok(forgot.includes(`<label for="email">${M.emailLabel}</label>`));
      assert.ok(forgot.includes(`>${M.submitRequest}</button>`));
      const [email] = tagsOf(forgot, 'input');
      assert.equal(email.type, 'email');
      assert.equal(email.autocomplete, 'email');
      assert.equal(email['aria-describedby'], 'email-error');
      assert.match(forgot, /id="request-status" role="status" aria-live="polite"/);
      assert.match(forgot, /id="form-error" role="alert"/);

      const reset = (await app.inject({ method: 'GET', url: '/redefinir-senha' })).body;
      assert.ok(reset.includes(`<h1>${M.resetTitle}</h1>`));
      assert.ok(reset.includes(`<label for="password">${M.passwordLabel}</label>`));
      assert.ok(reset.includes(`<label for="passwordConfirmation">${M.confirmationLabel}</label>`));
      assert.ok(reset.includes(`>${M.submitReset}</button>`));
      assert.ok(reset.includes(`<p class="help" id="password-rule">${MESSAGES.passwordRequirement}</p>`));
      const inputs = tagsOf(reset, 'input');
      assert.deepEqual(inputs.map((i) => [i.name, i.type, i.autocomplete]), [
        ['password', 'password', 'new-password'],
        ['passwordConfirmation', 'password', 'new-password'],
      ]);
      assert.match(inputs[0]['aria-describedby'], /password-rule/);
      assert.ok(reset.includes(M.linkInvalid));
      assert.ok(reset.includes(`href="/esqueci-senha"`));
      assert.ok(reset.includes(`>${M.requestNewLink}</a>`));
      assert.match(reset, /<noscript>[\s\S]*Pedir um novo link[\s\S]*<\/noscript>/);
      assert.match(reset, /aria-pressed="false"/);
      for (const html of [forgot, reset]) assert.equal(/placeholder=/.test(html), false);
    } finally {
      await app.close();
    }
  });
});

describe('link "Esqueci minha senha" no /login (critério 28, decisão 7)', () => {
  test('com transporte ativo (injetado), o /login tem o link', async () => {
    const { app } = await buildTestApp({ mailTransport: createMemoryMailTransport() });
    try {
      assert.equal(app.config.email.enabled, true);
      const res = await app.inject({ method: 'GET', url: '/login' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes(FORGOT_PASSWORD_BLOCK));
      assert.ok(res.body.includes('href="/esqueci-senha"'));
      assert.equal(res.body.includes(FORGOT_PASSWORD_MARKER), false);
    } finally {
      await app.close();
    }
  });

  test('com transporte none (padrão de buildTestApp), sem o link e sem o marcador; as rotas continuam', async () => {
    const { app } = await buildTestApp();
    try {
      assert.equal(app.config.email.enabled, false);
      const res = await app.inject({ method: 'GET', url: '/login' });
      const file = await readFile(`${WEB}login.html`, 'utf8');
      assert.equal(res.body, file.replace(FORGOT_PASSWORD_MARKER, ''));
      assert.equal(res.body.includes('esqueci-senha'), false);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.equal((await app.inject({ method: 'GET', url: '/esqueci-senha' })).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('renderLoginPage exige exatamente um marcador', () => {
    assert.throws(() => renderLoginPage('<p></p>', { forgotPasswordEnabled: true }));
    assert.throws(() => renderLoginPage(`${FORGOT_PASSWORD_MARKER}${FORGOT_PASSWORD_MARKER}`, { forgotPasswordEnabled: false }));
    assert.equal(renderLoginPage(`a${FORGOT_PASSWORD_MARKER}b`, { forgotPasswordEnabled: false }), 'ab');
  });
});
