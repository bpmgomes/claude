// E2E da recuperação de senha (AF-03, design 6.1, critérios 29 e 37 a 41) no Chromium: o link no
// login, o pedido, o e-mail no transporte de memória, a página de redefinição (fragmento tirado da
// barra), a troca e o login com a nova senha; erros com aria-invalid e foco; link usado com o atalho;
// acessibilidade (contraste, alvos de 44 px, 360 px sem rolagem, teclado) nas duas telas.
// Sem axe-core no projeto (nenhuma dependência nova): as verificações são as de test/browser/a11y.js
// mais rótulos, regiões aria e foco medidos aqui. Fora do `npm test`: `npm run test:e2e`.
/* global document, getComputedStyle, window */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import { smallTargets, contrastFailures } from './a11y.js';
import { signupAndLogin } from '../helpers/session.js';
import { resetLinkFrom, REQUESTED } from '../helpers/password-reset.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';

const NEW_PASSWORD = 'novaSenha123';

let server;
let browser;
const transport = createMemoryMailTransport();

before(async () => {
  const { chromium } = loadPlaywright();
  server = await startServer({
    overrides: {
      mailTransport: transport,
      email: { worker: { enabled: true, intervalMs: 100 } },
    },
    seed: async (app) => {
      for (const email of ['reset-e2e@x.com', 'teclado@x.com', 'regiao@x.com', 'usado@x.com', 'mesma-aba@x.com']) await signupAndLogin(app, { email });
    },
  });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/** Espera o e-mail de redefinição para o endereço e devolve o link apontando para o servidor de teste. */
async function waitResetLink(email, count = 1) {
  for (let i = 0; i < 100; i++) {
    const mine = transport.messages.filter((m) => m.to === email && resetLinkFrom(m));
    if (mine.length >= count) return resetLinkFrom(mine.at(-1)).replace(/^https?:\/\/[^/]+/, server.baseUrl);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`sem e-mail para ${email}`);
}

async function newPage(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  return { context, page };
}

async function requestOnPage(page, email) {
  await page.goto(`${server.baseUrl}/esqueci-senha`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.click('#submit-button');
  await page.waitForFunction(() => document.getElementById('request-status').textContent.length > 0);
}

const activeId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

describe('recuperação de senha pelo navegador (critério 29)', () => {
  test('login mostra o link; pedir, abrir o link do e-mail, trocar e entrar com a nova senha', async () => {
    const { context, page } = await newPage();
    try {
      await page.goto(`${server.baseUrl}/login`, { waitUntil: 'load' });
      const forgot = page.locator('#forgot-password a');
      assert.equal(await forgot.textContent(), 'Esqueci minha senha');
      await forgot.click();
      await page.waitForURL(`${server.baseUrl}/esqueci-senha`);
      await page.fill('#email', 'reset-e2e@x.com');
      await page.click('#submit-button');
      await page.waitForFunction(() => document.getElementById('request-status').textContent.length > 0);
      assert.equal(await page.textContent('#request-status'), REQUESTED);
      assert.equal(await activeId(page), 'request-status');

      const link = await waitResetLink('reset-e2e@x.com');
      assert.match(link, /\/redefinir-senha#token=[A-Za-z0-9_-]{43}$/);
      await page.goto(link, { waitUntil: 'load' });
      // O fragmento sai da barra de endereço no carregamento (decisão 2).
      assert.equal(page.url(), `${server.baseUrl}/redefinir-senha`);
      assert.equal(await page.isVisible('#reset-form'), true);
      assert.equal(await page.evaluate(() => JSON.stringify([localStorage.length, sessionStorage.length])), '[0,0]');

      // Senha fraca: erro no campo, aria-invalid e foco no campo.
      await page.fill('#password', 'abcdefgh');
      await page.fill('#passwordConfirmation', 'abcdefgh');
      await page.click('#submit-button');
      await page.waitForFunction(() => document.getElementById('password-error').textContent.length > 0);
      assert.equal(await page.textContent('#password-error'), 'A senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.');
      assert.equal(await page.getAttribute('#password', 'aria-invalid'), 'true');
      assert.equal(await activeId(page), 'password');

      // Confirmação diferente.
      await page.fill('#password', NEW_PASSWORD);
      await page.fill('#passwordConfirmation', `${NEW_PASSWORD}x`);
      await page.click('#submit-button');
      await page.waitForFunction(() => document.getElementById('passwordConfirmation-error').textContent.length > 0);
      assert.equal(await page.textContent('#passwordConfirmation-error'), 'As senhas não coincidem.');
      assert.equal(await activeId(page), 'passwordConfirmation');

      // Mostrar senha: aria-pressed.
      await page.click('#toggle-password');
      assert.equal(await page.getAttribute('#toggle-password', 'aria-pressed'), 'true');
      assert.equal(await page.getAttribute('#password', 'type'), 'text');
      await page.click('#toggle-password');
      assert.equal(await page.getAttribute('#password', 'type'), 'password');

      await page.fill('#passwordConfirmation', NEW_PASSWORD);
      await Promise.all([page.waitForURL(`${server.baseUrl}/login`), page.click('#submit-button')]);
      await page.waitForFunction(() => document.getElementById('login-status').textContent.length > 0);
      assert.equal(await page.textContent('#login-status'), 'Senha alterada. Entre com a nova senha.');

      await page.fill('#email', 'reset-e2e@x.com');
      await page.fill('#password', NEW_PASSWORD);
      await Promise.all([page.waitForURL(`${server.baseUrl}/onboarding`), page.click('#submit-button')]);
    } finally {
      await context.close();
    }
  });

  test('link usado mostra a mensagem e o atalho para pedir um novo link (decisão 11)', async () => {
    const { context, page } = await newPage();
    try {
      await requestOnPage(page, 'usado@x.com');
      const link = await waitResetLink('usado@x.com');
      await page.goto(link, { waitUntil: 'load' });
      await page.fill('#password', NEW_PASSWORD);
      await page.fill('#passwordConfirmation', NEW_PASSWORD);
      await Promise.all([page.waitForURL(`${server.baseUrl}/login`), page.click('#submit-button')]);
      await page.goto(link, { waitUntil: 'load' });
      await page.fill('#password', NEW_PASSWORD);
      await page.fill('#passwordConfirmation', NEW_PASSWORD);
      await page.click('#submit-button');
      await page.waitForSelector('#link-invalid', { state: 'visible' });
      assert.equal(await page.isVisible('#reset-form'), false);
      assert.equal(await page.textContent('#link-invalid-message'), 'Link inválido ou expirado. Peça um novo link.');
      assert.equal(await page.getAttribute('#request-new-link', 'href'), '/esqueci-senha');
      assert.equal(await activeId(page), 'request-new-link');
      // Sem token no fragmento: direto o estado de link inválido.
      await page.goto(`${server.baseUrl}/redefinir-senha`, { waitUntil: 'load' });
      assert.equal(await page.isVisible('#link-invalid'), true);
      assert.equal(await page.isVisible('#reset-form'), false);
    } finally {
      await context.close();
    }
  });

  test('link novo aberto na MESMA aba (só o fragmento muda): barra sem token, estado limpo e o token novo vale (QA F1)', async () => {
    const { context, page } = await newPage();
    try {
      await requestOnPage(page, 'mesma-aba@x.com');
      const first = await waitResetLink('mesma-aba@x.com', 1);
      await page.goto(first, { waitUntil: 'load' });
      assert.equal(page.url(), `${server.baseUrl}/redefinir-senha`);
      // Um erro na tela, que deve sumir quando o link novo chegar.
      await page.fill('#password', 'abc');
      await page.fill('#passwordConfirmation', 'abc');
      await page.click('#submit-button');
      await page.waitForFunction(() => document.getElementById('password-error').textContent.length > 0);

      // Pedido novo (outra aba) invalida o link 1; o link 2 é aberto nesta aba.
      const other = await context.newPage();
      await requestOnPage(other, 'mesma-aba@x.com');
      await other.close();
      const second = await waitResetLink('mesma-aba@x.com', 2);
      assert.notEqual(second, first);
      const loads = [];
      page.on('load', () => loads.push(page.url()));
      await page.goto(second);
      await page.waitForFunction(() => window.location.hash === '');
      assert.deepEqual(loads, [], 'navegação só de fragmento, sem recarregar');
      assert.equal(page.url(), `${server.baseUrl}/redefinir-senha`);
      assert.equal(await page.evaluate(() => window.location.href.includes('token')), false);
      assert.equal(await page.textContent('#password-error'), '');
      assert.equal(await page.getAttribute('#password', 'aria-invalid'), null);
      assert.equal(await page.inputValue('#password'), '');
      assert.equal(await page.isVisible('#reset-form'), true);

      const sent = [];
      page.on('request', (req) => {
        if (req.url().endsWith('/api/auth/password-reset/confirm')) sent.push(JSON.parse(req.postData()).token);
      });
      await page.fill('#password', NEW_PASSWORD);
      await page.fill('#passwordConfirmation', NEW_PASSWORD);
      await Promise.all([page.waitForURL(`${server.baseUrl}/login`), page.click('#submit-button')]);
      assert.deepEqual(sent, [second.split('#token=')[1]]);
      // O histórico também não guarda o token: voltar não traz o fragmento de volta.
      assert.equal(await page.evaluate(() => window.location.href.includes('token')), false);
    } finally {
      await context.close();
    }
  });

  test('/login?senha-alterada=1: a confirmação é anunciada (região viva sempre no DOM e foco nela) (Gerente M1)', async () => {
    const { context, page } = await newPage();
    try {
      await page.goto(`${server.baseUrl}/login`, { waitUntil: 'load' });
      const empty = await page.evaluate(() => {
        const el = document.getElementById('login-status');
        return { display: getComputedStyle(el).display, role: el.getAttribute('role'), live: el.getAttribute('aria-live') };
      });
      assert.notEqual(empty.display, 'none', 'a região vazia continua na árvore de acessibilidade');
      assert.deepEqual([empty.role, empty.live], ['status', 'polite']);
      await page.goto(`${server.baseUrl}/login?senha-alterada=1`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('login-status').textContent.length > 0);
      assert.equal(await page.textContent('#login-status'), 'Senha alterada. Entre com a nova senha.');
      assert.equal(await activeId(page), 'login-status');
      const snapshot = await page.locator('#login-status').ariaSnapshot();
      assert.match(snapshot, /status: Senha alterada\. Entre com a nova senha\./);
    } finally {
      await context.close();
    }
  });

  test('a resposta do pedido aparece na mesma região e com o mesmo foco para conta existente e inexistente (critério 41)', async () => {
    const states = [];
    for (const email of ['regiao@x.com', 'nao-existe-regiao@x.com']) {
      const { context, page } = await newPage();
      try {
        await requestOnPage(page, email);
        states.push({
          text: await page.textContent('#request-status'),
          focus: await activeId(page),
          error: await page.textContent('#form-error'),
          html: await page.evaluate(() => document.querySelector('main').outerHTML.replace(/value="[^"]*"/, '')),
        });
      } finally {
        await context.close();
      }
    }
    assert.deepEqual(states[1], states[0]);
    assert.equal(states[0].text, REQUESTED);
  });
});

describe('acessibilidade (critérios 37 a 40)', () => {
  test('rótulos visíveis, autocomplete e regiões aria nas duas telas', async () => {
    const { context, page } = await newPage();
    try {
      for (const [url, ids] of [
        ['/esqueci-senha', ['email']],
        ['/redefinir-senha#token=' + 'A'.repeat(43), ['password', 'passwordConfirmation']],
      ]) {
        await page.goto(`${server.baseUrl}${url}`, { waitUntil: 'load' });
        for (const id of ids) {
          const info = await page.evaluate((fieldId) => {
            const input = document.getElementById(fieldId);
            const label = document.querySelector(`label[for="${fieldId}"]`);
            const box = label.getBoundingClientRect();
            return { label: label.textContent, visible: box.width > 0 && box.height > 0, placeholder: input.placeholder, describedBy: input.getAttribute('aria-describedby') };
          }, id);
          assert.ok(info.label.length > 0 && info.visible, `${url} ${id}`);
          assert.equal(info.placeholder, '');
          assert.match(info.describedBy, new RegExp(`${id}-error`));
        }
        assert.equal(await page.getAttribute('#form-error', 'role'), 'alert');
      }
    } finally {
      await context.close();
    }
  });

  for (const width of [360, 1280]) {
    test(`${width} px: sem rolagem horizontal, alvos de 44 px e contraste AA em vazio, erro e sucesso`, async () => {
      const { context, page } = await newPage(width);
      const check = async (label) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `${label}: scrollWidth ${overflow}`);
        assert.deepEqual(await smallTargets(page, 'main'), [], label);
        assert.deepEqual(await contrastFailures(page, { root: 'main' }), [], label);
      };
      try {
        await page.goto(`${server.baseUrl}/login`, { waitUntil: 'load' });
        assert.deepEqual(await smallTargets(page, '#forgot-password'), []);
        await page.goto(`${server.baseUrl}/esqueci-senha`, { waitUntil: 'load' });
        await check('pedido vazio');
        await page.click('#submit-button');
        await page.waitForFunction(() => document.getElementById('email-error').textContent.length > 0);
        assert.equal(await page.getAttribute('#email', 'aria-invalid'), 'true');
        assert.equal(await activeId(page), 'email');
        await check('pedido com erro');
        await page.fill('#email', `a11y-${width}@x.com`);
        await page.click('#submit-button');
        await page.waitForFunction(() => document.getElementById('request-status').textContent.length > 0);
        await check('pedido com sucesso');

        await page.goto(`${server.baseUrl}/redefinir-senha#token=${'B'.repeat(43)}`, { waitUntil: 'load' });
        await check('redefinição vazia');
        await page.fill('#password', 'abc');
        await page.fill('#passwordConfirmation', 'abd');
        await page.click('#submit-button');
        await page.waitForFunction(() => document.getElementById('password-error').textContent.length > 0);
        await check('redefinição com erro');
        await page.fill('#password', NEW_PASSWORD);
        await page.fill('#passwordConfirmation', NEW_PASSWORD);
        await page.click('#submit-button');
        await page.waitForSelector('#link-invalid', { state: 'visible' });
        await check('link inválido');

        await page.goto(`${server.baseUrl}/login?senha-alterada=1`, { waitUntil: 'load' });
        assert.equal(page.url(), `${server.baseUrl}/login`);
        // O /login é do AF-02 (o link "Criar conta" é anterior); aqui só o que o AF-03 acrescenta.
        assert.deepEqual(await smallTargets(page, '#forgot-password'), []);
        assert.deepEqual(await contrastFailures(page, { root: '#login-status' }), []);
        assert.deepEqual(await contrastFailures(page, { root: '#forgot-password' }), []);
      } finally {
        await context.close();
      }
    });
  }

  test('só teclado: Tab em ordem lógica, foco visível e Enter envia', async () => {
    const { context, page } = await newPage();
    try {
      await page.goto(`${server.baseUrl}/esqueci-senha`, { waitUntil: 'load' });
      const order = [];
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Tab');
        order.push(await page.evaluate(() => {
          const el = document.activeElement;
          const style = getComputedStyle(el);
          return { id: el.id || el.getAttribute('href'), outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px' };
        }));
      }
      assert.deepEqual(order.map((o) => o.id), ['email', 'submit-button', '/login']);
      assert.ok(order.every((o) => o.outline), JSON.stringify(order));
      await page.focus('#email');
      await page.keyboard.type('teclado@x.com');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('request-status').textContent.length > 0);
      assert.equal(await page.textContent('#request-status'), REQUESTED);

      const link = await waitResetLink('teclado@x.com');
      await page.goto(link, { waitUntil: 'load' });
      const resetOrder = [];
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        resetOrder.push(await activeId(page));
      }
      assert.deepEqual(resetOrder, ['password', 'passwordConfirmation', 'toggle-password', 'submit-button']);
      await page.focus('#password');
      await page.keyboard.type(NEW_PASSWORD);
      await page.keyboard.press('Tab');
      await page.keyboard.type(NEW_PASSWORD);
      await Promise.all([page.waitForURL(`${server.baseUrl}/login`), page.keyboard.press('Enter')]);
    } finally {
      await context.close();
    }
  });
});
