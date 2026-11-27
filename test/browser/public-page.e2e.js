// E2E da página pública (AF-09, AF-10 e AF-04): responsividade, acessibilidade, imagens, CLS, XSS,
// a seção de horários e o passo "Seus dados" no Chromium. Fora do `npm test`: `npm run test:e2e`
// (Playwright e Chromium do ambiente, sem throttling). Relógio do servidor fixo: quinta-feira 2026-11-26, 09:00 em São Paulo.
// Globais de navegador usados só nas funções executadas no Chromium (page.evaluate etc.; AF-20, lint).
/* global document, window, getComputedStyle, MutationObserver, DataTransfer, ClipboardEvent */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.js';
import { startServer } from './server.js';
import { seedPublicBusiness } from '../helpers/public-fixture.js';

const VIEWPORTS = [360, 414, 768, 1280];
const LONG_BUSINESS = `Salão e Barbearia ${'Muito Comprida '.repeat(6)}`.slice(0, 100).trim();
const LONG_SERVICE = 'S'.repeat(100);
const LONG_PROFESSIONAL = `Maria ${'Aparecida '.repeat(11)}`.slice(0, 100).trim();
const SCRIPT_PAYLOAD = '<script>window.__x=1</script>';
const IMG_PAYLOAD = '"><img src=x onerror="window.__x=1">';
const NOW = '2026-11-26T12:00:00.000Z';
const FRIDAY = '2026-11-27';
const SATURDAY = '2026-11-28';

let server;
let browser;

before(async () => {
  const { chromium } = loadPlaywright();
  server = await startServer({
    now: NOW,
    seed: async (app) => ({
      reference: await seedPublicBusiness(app, { services: 20, professionals: 10, logo: 'realistic', slug: 'referencia' }),
      long: await seedPublicBusiness(app, {
        services: 3,
        professionals: 2,
        logo: 'realistic',
        slug: 'nomes-longos',
        names: { business: LONG_BUSINESS, service: LONG_SERVICE, professional: LONG_PROFESSIONAL },
      }),
      xss: await seedPublicBusiness(app, {
        services: 2,
        professionals: 2,
        logo: null,
        photos: false,
        slug: 'xss-teste',
        names: { business: SCRIPT_PAYLOAD, address: IMG_PAYLOAD, service: IMG_PAYLOAD, professional: SCRIPT_PAYLOAD },
      }),
      empty: await seedPublicBusiness(app, { services: 0, professionals: 0, logo: null, slug: 'vazio' }),
    }),
  });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

async function open(path, { width = 360, height = 800, baseUrl = server.baseUrl } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'load' });
  return { context, page, response, dialogs };
}

/** Rola até o fim para carregar as imagens lazy e espera todas terminarem. */
async function loadAllImages(page) {
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 50));
    await Promise.all(
      [...document.images].map((img) => {
        img.loading = 'eager';
        if (img.complete) return null;
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      }),
    );
    window.scrollTo(0, 0);
  });
}

describe('responsividade e nomes longos (critérios 13 e 14)', () => {
  for (const width of VIEWPORTS) {
    for (const path of ['/referencia', '/nomes-longos', '/vazio']) {
      test(`${path} em ${width} px: sem rolagem horizontal e nada além da borda`, async () => {
        const { context, page } = await open(path, { width });
        try {
          const result = await page.evaluate(() => {
            const vw = window.innerWidth;
            const overflowing = [];
            for (const el of document.body.querySelectorAll('*')) {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden') continue;
              if (rect.bottom < 0) continue; // fora da tela de propósito (skip link)
              if (rect.right > vw + 0.5) overflowing.push(`${el.tagName}.${el.className} ${rect.right}`);
            }
            return { scrollWidth: document.documentElement.scrollWidth, vw, overflowing };
          });
          assert.ok(result.scrollWidth <= result.vw, `scrollWidth ${result.scrollWidth} > ${result.vw}`);
          assert.deepEqual(result.overflowing, []);
        } finally {
          await context.close();
        }
      });
    }

    test(`nomes de 100 caracteres em ${width} px: profissional com reticências; negócio e serviço quebram dentro do contêiner`, async () => {
      const { context, page } = await open('/nomes-longos', { width });
      try {
        const info = await page.evaluate(() => {
          const longest = (selector) =>
            [...document.querySelectorAll(selector)].sort((x, y) => y.textContent.length - x.textContent.length)[0];
          const pro = longest('.pp-professional-name');
          const name = document.querySelector('.pp-name');
          const service = longest('.pp-service-name');
          const inside = (el) => {
            const r = el.getBoundingClientRect();
            const p = el.parentElement.getBoundingClientRect();
            return r.left >= p.left - 0.5 && r.right <= p.right + 0.5 && el.scrollWidth <= el.clientWidth + 1;
          };
          return {
            proText: pro.textContent,
            proScroll: pro.scrollWidth,
            proClient: pro.clientWidth,
            proOverflow: getComputedStyle(pro).textOverflow,
            nameText: name.textContent,
            nameInside: inside(name),
            serviceText: service.textContent,
            serviceInside: inside(service),
          };
        });
        assert.equal(info.proText.length, 100);
        assert.equal(info.nameText.length, 100);
        assert.equal(info.serviceText.length, 100);
        assert.ok(info.proScroll > info.proClient, `${info.proScroll} <= ${info.proClient}`);
        assert.equal(info.proOverflow, 'ellipsis');
        assert.ok(info.nameInside, 'nome do negócio fora do contêiner');
        assert.ok(info.serviceInside, 'nome do serviço fora do contêiner');
      } finally {
        await context.close();
      }
    });
  }
});

describe('alvos de toque, contraste e teclado (critérios 13 e 15)', () => {
  for (const path of ['/referencia', '/vazio']) {
    test(`${path}: todo a e button visível tem pelo menos 44x44 px`, async () => {
      const { context, page } = await open(path);
      try {
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('a, button')]
            .map((el) => ({ el, rect: el.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.bottom > 0)
            .filter(({ rect }) => rect.width < 44 || rect.height < 44)
            .map(({ el, rect }) => `${el.tagName}.${el.className} ${rect.width}x${rect.height}`),
        );
        assert.deepEqual(small, []);
      } finally {
        await context.close();
      }
    });

    test(`${path}: contraste AA (WCAG 2.1) em todo texto`, async () => {
      const { context, page } = await open(path);
      try {
        const failures = await page.evaluate(() => {
          const parse = (c) => {
            const m = c.match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
            return { r, g, b, a };
          };
          const lum = ({ r, g, b }) => {
            const ch = (v) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
          };
          const background = (el) => {
            for (let node = el; node; node = node.parentElement) {
              const bg = parse(getComputedStyle(node).backgroundColor);
              if (bg && bg.a > 0) return bg;
            }
            return { r: 255, g: 255, b: 255, a: 1 };
          };
          const out = [];
          for (const el of document.body.querySelectorAll('*')) {
            const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
            if (!hasText) continue;
            const style = getComputedStyle(el);
            const fg = parse(style.color);
            const bg = background(el);
            const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
            const ratio = (l1 + 0.05) / (l2 + 0.05);
            const size = Number.parseFloat(style.fontSize);
            const bold = Number(style.fontWeight) >= 700;
            const large = size >= 24 || (bold && size >= 18.66);
            if (ratio < (large ? 3 : 4.5)) out.push(`${el.tagName}.${el.className}: ${ratio.toFixed(2)}`);
          }
          return out;
        });
        assert.deepEqual(failures, []);
      } finally {
        await context.close();
      }
    });
  }

  test('teclado: Tab passa por skip link e telefone com outline visível; Enter no skip link leva a #servicos', async () => {
    const { context, page } = await open('/referencia');
    try {
      const focused = async () =>
        page.evaluate(() => {
          const el = document.activeElement;
          const style = getComputedStyle(el);
          return {
            className: el.className,
            id: el.id,
            outline: style.outlineStyle,
            outlineWidth: Number.parseFloat(style.outlineWidth),
            visible: el.getBoundingClientRect().bottom > 0,
          };
        });
      await page.keyboard.press('Tab');
      const skip = await focused();
      assert.equal(skip.className, 'skip-link');
      assert.equal(skip.visible, true, 'skip link aparece ao receber foco');
      assert.notEqual(skip.outline, 'none');
      assert.ok(skip.outlineWidth >= 2);
      await page.keyboard.press('Tab');
      const phone = await focused();
      assert.equal(phone.className, 'pp-phone');
      assert.notEqual(phone.outline, 'none');

      await page.keyboard.press('Shift+Tab');
      assert.equal((await focused()).className, 'skip-link');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'servicos');
      assert.equal((await focused()).id, 'servicos');
    } finally {
      await context.close();
    }
  });
});

describe('imagens e layout (critérios 2, 11 e 15)', () => {
  test('todo img tem alt e nenhum está quebrado; fotos lazy carregam ao rolar', async () => {
    const { context, page } = await open('/referencia', { width: 414 });
    try {
      await loadAllImages(page);
      const images = await page.evaluate(() =>
        [...document.images].map((img) => ({ alt: img.alt, src: img.getAttribute('src'), w: img.naturalWidth, cls: img.className })),
      );
      assert.equal(images.length, 11);
      for (const img of images) {
        assert.ok(img.alt.length > 0, img.src);
        assert.ok(img.w > 0, `imagem quebrada: ${img.src}`);
      }
      assert.equal(images[0].cls, 'pp-logo');
    } finally {
      await context.close();
    }
  });

  test('sem logo: placeholder e nenhuma imagem quebrada; avatar padrão carrega', async () => {
    const { context, page } = await open('/xss-teste');
    try {
      await loadAllImages(page);
      const info = await page.evaluate(() => ({
        placeholder: Boolean(document.querySelector('.pp-logo-placeholder')),
        logos: document.querySelectorAll('img.pp-logo').length,
        broken: [...document.images].filter((i) => i.naturalWidth === 0).map((i) => i.src),
        avatars: [...document.images].map((i) => i.getAttribute('src')),
      }));
      assert.equal(info.placeholder, true);
      assert.equal(info.logos, 0);
      assert.deepEqual(info.broken, []);
      assert.ok(info.avatars.length > 0 && info.avatars.every((src) => src === '/img/avatar-default.svg'));
    } finally {
      await context.close();
    }
  });

  test('sem salto de layout: CLS < 0,1 na carga', async () => {
    const { context, page } = await open('/referencia', { width: 412 });
    try {
      const cls = await page.evaluate(
        () =>
          new Promise((resolve) => {
            let total = 0;
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) if (!entry.hadRecentInput) total += entry.value;
            }).observe({ type: 'layout-shift', buffered: true });
            setTimeout(() => resolve(total), 300);
          }),
      );
      assert.ok(cls < 0.1, `CLS ${cls}`);
    } finally {
      await context.close();
    }
  });
});

describe('XSS (critério 18)', () => {
  test('<script> e "><img onerror> nos nomes e no endereço não executam e aparecem literais', async () => {
    const { context, page, dialogs } = await open('/xss-teste');
    try {
      await loadAllImages(page);
      const info = await page.evaluate(() => ({
        x: window.__x,
        scripts: document.querySelectorAll('script').length,
        badImages: [...document.images].filter((i) => i.getAttribute('src') === 'x').length,
        handlers: [...document.querySelectorAll('*')].flatMap((el) =>
          [...el.attributes].filter((a) => a.name.startsWith('on')).map((a) => `${el.tagName} ${a.name}`),
        ),
        name: document.querySelector('.pp-name').textContent,
        address: document.querySelector('.pp-address').textContent,
        professional: document.querySelector('.pp-professional-name').textContent,
        title: document.title,
      }));
      assert.deepEqual(dialogs, []);
      assert.equal(info.x, undefined);
      assert.equal(info.scripts, 1, 'só o módulo de horários');
      assert.equal(info.badImages, 0);
      assert.deepEqual(info.handlers, []);
      assert.equal(info.name, SCRIPT_PAYLOAD);
      assert.equal(info.address, IMG_PAYLOAD);
      assert.equal(info.professional, SCRIPT_PAYLOAD);
      assert.equal(info.title, `${SCRIPT_PAYLOAD} · AgendaFácil`);
      const services = await page.locator('.pp-service-name').allTextContents();
      assert.ok(services.includes(IMG_PAYLOAD));
    } finally {
      await context.close();
    }
  });
});

describe('ação de agendar e 404 (critérios 6, 8 e 13)', () => {
  test('link Ver horários leva à seção, escolhe o serviço e consulta (AF-10)', async () => {
    const { context, page } = await open('/referencia');
    try {
      const { services } = server.data.reference;
      assert.equal(await page.locator('.pp-book').count(), 20);
      const link = page.locator('.pp-book').first();
      assert.equal(await link.textContent(), 'Ver horários');
      assert.equal(await link.getAttribute('href'), `?servico=${services[0].id}#agendar`);
      assert.match(await page.locator('#agendar-aviso').textContent(), /Escolha um horário livre abaixo e confirme online/);
      await link.click();
      await waitReady(page);
      assert.equal(await page.locator('#bk-service').inputValue(), services[0].id);
      assert.ok((await page.locator('.pp-slot').count()) > 0);
      assert.match(page.url(), new RegExp(`servico=${services[0].id}`));
      const inView = await page.evaluate(() => {
        const r = document.querySelector('.pp-booking').getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      });
      assert.equal(inView, true);
    } finally {
      await context.close();
    }
  });

  test('estado vazio mostra o texto explicativo e o telefone', async () => {
    const { context, page } = await open('/vazio');
    try {
      const text = await page.locator('main').textContent();
      assert.match(text, /Agendamento online indisponível/);
      assert.match(text, /\(11\) 91234-5678/);
      assert.equal(await page.locator('.pp-book').count(), 0);
      assert.equal(await page.locator('.pp-booking').count(), 0);
      assert.equal(await page.locator('script').count(), 0);
    } finally {
      await context.close();
    }
  });

  test('404 (slug inexistente) a 360 px sem rolagem horizontal', async () => {
    const { context, page, response } = await open('/nao-existe-esse', { width: 360 });
    try {
      assert.equal(response.status(), 404);
      const widths = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth }));
      assert.ok(widths.sw <= widths.vw);
      assert.match(await page.locator('h1').textContent(), /Página não encontrada/);
    } finally {
      await context.close();
    }
  });
});

/** Espera a lista renderizada (data-state="ready") com o texto de status esperado. */
async function waitReady(page, statusIncludes = '') {
  await page.waitForFunction(
    (text) => {
      const section = document.querySelector('.pp-booking');
      const status = document.querySelector('.pp-status');
      return section && section.dataset.state === 'ready' && status && status.textContent.includes(text);
    },
    statusIncludes,
  );
}

async function chooseInPage(page, { serviceId, professionalId = 'any', date }) {
  await page.selectOption('#bk-service', serviceId);
  if (professionalId) await page.selectOption('#bk-professional', professionalId);
  if (date) await page.fill('#bk-date', date);
}

describe('horários disponíveis (AF-10, critérios 22 e 28 a 30)', () => {
  for (const width of [360, 414]) {
    test(`${width} px: serviço, Qualquer profissional e 27/11 listam os horários sem rolagem horizontal; alvos de 44 px; fuso visível`, async () => {
      const { context, page } = await open('/referencia', { width });
      try {
        assert.equal(await page.locator('.pp-booking').isVisible(), true);
        await chooseInPage(page, { serviceId: server.data.reference.services[0].id, date: FRIDAY });
        await waitReady(page, 'sex, 27/11');
        const info = await page.evaluate(() => {
          const slots = [...document.querySelectorAll('.pp-slot')].map((b) => {
            const r = b.getBoundingClientRect();
            return { w: r.width, h: r.height, text: b.textContent };
          });
          const vw = window.innerWidth;
          const overflowing = [...document.querySelectorAll('.pp-booking *')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.right > vw + 0.5)
            .map(({ el, r }) => `${el.tagName}.${el.className} ${r.right}`);
          return {
            slots,
            scrollWidth: document.documentElement.scrollWidth,
            vw,
            overflowing,
            timezone: document.querySelector('.pp-timezone').textContent,
            fields: [...document.querySelectorAll('#bk-service, #bk-professional, #bk-date')].map((el) => el.getBoundingClientRect().height),
          };
        });
        assert.ok(info.slots.length > 0);
        assert.equal(info.slots[0].text, '09:00');
        for (const slot of info.slots) assert.ok(slot.w >= 44 && slot.h >= 44, `${slot.text} ${slot.w}x${slot.h}`);
        for (const h of info.fields) assert.ok(h >= 44, `campo com ${h} px`);
        assert.ok(info.scrollWidth <= info.vw, `scrollWidth ${info.scrollWidth} > ${info.vw}`);
        assert.deepEqual(info.overflowing, []);
        assert.equal(info.timezone, 'Horários no fuso do estabelecimento: Horário de Brasília (America/Sao_Paulo).');
      } finally {
        await context.close();
      }
    });
  }

  test('escolher um horário mostra o resumo e Confirmar agendamento visível e habilitado, sem o aviso antigo (critério 22; AF-11)', async () => {
    const { context, page } = await open('/referencia');
    try {
      const [service] = server.data.reference.services;
      await chooseInPage(page, { serviceId: service.id, date: FRIDAY });
      await waitReady(page, 'sex, 27/11');
      assert.equal(await page.locator('.pp-confirm').isVisible(), false);
      const slot = page.locator('.pp-slot').first();
      await slot.click();
      assert.equal(await slot.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.pp-slot[aria-pressed="true"]').count(), 1);
      const confirm = page.locator('.pp-confirm-button');
      assert.equal(await confirm.isVisible(), true);
      assert.equal(await confirm.isDisabled(), false);
      assert.equal(await confirm.textContent(), 'Confirmar agendamento');
      const end = `09:${String(service.durationMinutes % 60).padStart(2, '0')}`;
      assert.equal(await page.locator('.pp-selected').textContent(), `${service.name} · sex, 27/11 · 09:00 – ${end} (Horário de Brasília, America/Sao_Paulo)`);
      assert.equal(await page.locator('#confirmar-aviso').count(), 0);
      const box = await confirm.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44);
    } finally {
      await context.close();
    }
  });

  test('sábado (sem grade) mostra o estado vazio com a sugestão de outra data (critério 29)', async () => {
    const { context, page } = await open('/referencia');
    try {
      await chooseInPage(page, { serviceId: server.data.reference.services[0].id, date: SATURDAY });
      await waitReady(page, 'Não há horários livres neste dia. Escolha outra data.');
      assert.equal(await page.locator('.pp-slot').count(), 0);
      // Com um profissional específico, a sugestão inclui outro profissional.
      await page.selectOption('#bk-professional', server.data.reference.professionals[0].id);
      await waitReady(page, 'Escolha outra data ou outro profissional.');
    } finally {
      await context.close();
    }
  });

  test('profissional que não realiza o serviço fica escondido; trocar o serviço volta para Qualquer profissional', async () => {
    const { context, page } = await open('/referencia');
    try {
      const { services, professionals } = server.data.reference;
      const doesService = (p, s) => p.services.some((x) => x.id === s.id);
      const first = services[0];
      const other = services.find((s) => !doesService(professionals[0], s) && professionals.some((p) => doesService(p, s)));
      await page.selectOption('#bk-service', first.id);
      const visible = await page.evaluate(() =>
        [...document.querySelectorAll('#bk-professional option')].filter((o) => !o.hidden && !o.disabled).map((o) => o.value),
      );
      const expected = ['any', ...professionals.filter((p) => doesService(p, first)).map((p) => p.id)];
      assert.deepEqual(new Set(visible), new Set(expected));
      const hidden = professionals.find((p) => !doesService(p, first));
      assert.equal(await page.locator(`#bk-professional option[value="${hidden.id}"]`).isDisabled(), true);

      await page.selectOption('#bk-professional', professionals[0].id);
      await waitReady(page);
      await page.selectOption('#bk-service', other.id);
      assert.equal(await page.locator('#bk-professional').inputValue(), 'any');
      await waitReady(page);
    } finally {
      await context.close();
    }
  });

  test('?servico=<id>&data=2026-11-27 na URL já abre com os horários', async () => {
    const [service] = server.data.reference.services;
    const { context, page } = await open(`/referencia?servico=${service.id}&data=${FRIDAY}`);
    try {
      await waitReady(page, 'sex, 27/11');
      assert.equal(await page.locator('#bk-service').inputValue(), service.id);
      assert.equal(await page.locator('#bk-date').inputValue(), FRIDAY);
      assert.equal(await page.locator('#bk-date').getAttribute('min'), '2026-11-26');
      assert.equal(await page.locator('#bk-date').getAttribute('max'), '2027-02-24');
      assert.ok((await page.locator('.pp-slot').count()) > 0);
    } finally {
      await context.close();
    }
  });

  test('sem serviço na URL, a carga não chama a API', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    const api = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/')) api.push(req.url());
    });
    try {
      await page.goto(`${server.baseUrl}/referencia`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('.pp-booking')?.dataset.state === 'idle');
      assert.deepEqual(api, []);
    } finally {
      await context.close();
    }
  });

  test('XSS: nomes maliciosos aparecem literais nas opções; o único script é o módulo', async () => {
    const { context, page, dialogs } = await open('/xss-teste');
    try {
      await page.selectOption('#bk-service', server.data.xss.services[0].id);
      await waitReady(page);
      const info = await page.evaluate(() => ({
        x: window.__x,
        scripts: [...document.querySelectorAll('script')].map((s) => ({ src: s.getAttribute('src'), type: s.type, text: s.textContent })),
        services: [...document.querySelectorAll('#bk-service option')].map((o) => o.textContent),
        professionals: [...document.querySelectorAll('#bk-professional option')].map((o) => o.textContent),
        badImages: [...document.images].filter((i) => i.getAttribute('src') === 'x').length,
      }));
      assert.deepEqual(dialogs, []);
      assert.equal(info.x, undefined);
      assert.deepEqual(info.scripts, [{ src: '/js/public-booking-page.js', type: 'module', text: '' }]);
      assert.ok(info.services.some((t) => t.startsWith(`${IMG_PAYLOAD} · `)), info.services.join(' | '));
      assert.ok(info.professionals.includes(SCRIPT_PAYLOAD));
      assert.equal(info.badImages, 0);
    } finally {
      await context.close();
    }
  });

  test('sem JavaScript: a seção fica oculta e o texto do <noscript> aparece', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto(`${server.baseUrl}/referencia`, { waitUntil: 'load' });
      assert.equal(await page.locator('.pp-booking').isVisible(), false);
      const text = await page.locator('#agendar').innerText();
      assert.match(text, /Para ver os horários livres, ative o JavaScript ou ligue para \(11\) 91234-5678\./);
      assert.equal(await page.locator('.pp-service-name').count(), 20);
      // AF-04: o formulário "Seus dados" também fica oculto.
      assert.equal(await page.locator('#bk-customer').count(), 1);
      assert.equal(await page.locator('#bk-customer').isVisible(), false);
      assert.equal(await page.locator('#bk-name').isVisible(), false);
    } finally {
      await context.close();
    }
  });
});

/**
 * Servidor próprio do passo "Seus dados", com o rate limit padrão LIGADO: cada teste consulta os
 * horários ao menos uma vez, e o teto de custo de horários (30 por minuto e por IP) do servidor
 * principal já é quase todo usado pelos testes do AF-10.
 */
let customerServer;

/** Abre a página, escolhe o 1º serviço, sexta 27/11 e o primeiro horário. */
async function openCustomerStep(path = '/dados', options = {}) {
  const opened = await open(path, { ...options, baseUrl: customerServer.baseUrl });
  const data = path === '/xss-dados' ? customerServer.data.xss : customerServer.data.reference;
  await chooseInPage(opened.page, { serviceId: data.services[0].id, date: FRIDAY });
  await waitReady(opened.page, 'sex, 27/11');
  await opened.page.locator('.pp-slot').first().click();
  await opened.page.locator('#bk-customer').waitFor({ state: 'visible' });
  return opened;
}

describe('passo "Seus dados" (AF-04)', () => {
  before(async () => {
    customerServer = await startServer({
      now: NOW,
      seed: async (app) => ({
        reference: await seedPublicBusiness(app, { services: 2, professionals: 2, logo: null, photos: false, slug: 'dados' }),
        xss: await seedPublicBusiness(app, {
          services: 1,
          professionals: 1,
          logo: null,
          photos: false,
          slug: 'xss-dados',
          names: { business: SCRIPT_PAYLOAD, address: IMG_PAYLOAD, service: IMG_PAYLOAD, professional: SCRIPT_PAYLOAD },
        }),
      }),
    });
  });

  after(async () => {
    if (customerServer) await customerServer.close();
  });

  test('escolher o horário mostra os três campos, o aviso de privacidade e o botão habilitado (critérios 21, 22 e 25; AF-11)', async () => {
    const { context, page } = await openCustomerStep();
    try {
      for (const id of ['#bk-name', '#bk-phone', '#bk-email']) assert.equal(await page.locator(id).isVisible(), true, id);
      assert.equal(await page.locator('#dados-titulo').textContent(), 'Seus dados');
      assert.equal(await page.locator('label[for="bk-name"]').textContent(), 'Nome');
      assert.equal(await page.locator('#bk-phone').getAttribute('inputmode'), 'tel');
      assert.equal(await page.locator('#bk-phone').getAttribute('autocomplete'), 'tel-national');
      assert.equal(await page.locator('#bk-email').getAttribute('type'), 'email');
      const privacy = await page.locator('#dados-privacidade').textContent();
      assert.match(privacy, /Usamos seu nome, telefone e e-mail só para fazer este agendamento/);
      assert.ok(privacy.includes(customerServer.data.reference.business.name));
      const button = page.locator('#bk-customer .pp-confirm-button');
      assert.equal(await button.isVisible(), true);
      assert.equal(await button.isDisabled(), false);
      assert.equal(await button.textContent(), 'Confirmar agendamento');
      const text = (await page.locator('.pp-confirm').innerText()).toLowerCase();
      assert.equal(text.includes('confirmado'), false);
      assert.equal(text.includes('ainda não está reservado'), false);
    } finally {
      await context.close();
    }
  });

  for (const width of [360, 414]) {
    test(`${width} px: sem rolagem horizontal; campos e botão com pelo menos 44 px (critério 23)`, async () => {
      const { context, page } = await openCustomerStep('/dados', { width });
      try {
        const info = await page.evaluate(() => {
          const vw = window.innerWidth;
          const heights = [...document.querySelectorAll('#bk-customer input, #bk-customer button')].map((el) => ({
            id: el.id || el.className,
            h: el.getBoundingClientRect().height,
            w: el.getBoundingClientRect().width,
          }));
          const overflowing = [...document.querySelectorAll('#bk-customer *')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.right > vw + 0.5)
            .map(({ el, r }) => `${el.tagName}.${el.className} ${r.right}`);
          const fontSizes = [...document.querySelectorAll('#bk-customer input')].map((el) => Number.parseFloat(getComputedStyle(el).fontSize));
          return { vw, scrollWidth: document.documentElement.scrollWidth, heights, overflowing, fontSizes };
        });
        assert.ok(info.scrollWidth <= info.vw, `scrollWidth ${info.scrollWidth} > ${info.vw}`);
        assert.deepEqual(info.overflowing, []);
        assert.equal(info.heights.length, 4);
        for (const el of info.heights) assert.ok(el.h >= 44 && el.w >= 44, `${el.id} ${el.w}x${el.h}`);
        for (const size of info.fontSizes) assert.ok(size >= 16, `fonte ${size}px`);
      } finally {
        await context.close();
      }
    });
  }

  test('erro por campo ao sair do telefone; corrigir remove o erro e formata; os outros campos ficam intactos (critérios 3, 7, 23 e 24)', async () => {
    const { context, page } = await openCustomerStep();
    try {
      await page.fill('#bk-name', 'Ana Souza');
      await page.fill('#bk-email', 'ana@example.com');
      const phone = page.locator('#bk-phone');
      await phone.fill('12345');
      await phone.blur();
      const error = page.locator('#bk-phone-erro');
      assert.equal(await error.isVisible(), true);
      assert.equal(await error.textContent(), 'Informe um celular ou telefone fixo com DDD, ex.: (11) 91234-5678.');
      assert.equal(await phone.getAttribute('aria-invalid'), 'true');
      assert.ok((await phone.getAttribute('aria-describedby')).split(' ').includes('bk-phone-erro'));
      // Live region polido; o mesmo erro ao sair de novo não reescreve o texto (sem anúncio repetido).
      assert.equal(await error.getAttribute('aria-live'), 'polite');
      assert.equal(await error.getAttribute('role'), null);
      await page.evaluate(() => {
        window.__mutations = 0;
        new MutationObserver((list) => {
          window.__mutations += list.length;
        }).observe(document.querySelector('#bk-phone-erro'), { childList: true, characterData: true, subtree: true });
      });
      await phone.focus();
      await phone.blur();
      await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
      assert.equal(await page.evaluate(() => window.__mutations), 0, 'o erro igual foi reescrito');
      assert.equal(await phone.inputValue(), '12345', 'o valor inválido continua no campo');
      assert.equal(await page.locator('#bk-name').inputValue(), 'Ana Souza');
      assert.equal(await page.locator('#bk-email').inputValue(), 'ana@example.com');
      assert.equal(await page.locator('#bk-name-erro').isVisible(), false);

      await phone.fill('+55 (11) 91234-5678');
      assert.equal(await error.isVisible(), false, 'o erro sai ao ficar válido, durante a digitação');
      assert.equal(await phone.getAttribute('aria-invalid'), null);
      assert.equal(await phone.inputValue(), '+55 (11) 91234-5678', 'sem máscara durante a digitação');
      await phone.blur();
      assert.equal(await phone.inputValue(), '(11) 91234-5678');
      assert.equal(await error.isVisible(), false);
      assert.equal(await page.locator('#bk-name').inputValue(), 'Ana Souza');
      assert.equal(await page.locator('#bk-email').inputValue(), 'ana@example.com');

      // Nome e e-mail inválidos também ganham o erro do próprio campo.
      await page.fill('#bk-name', 'A');
      await page.locator('#bk-name').blur();
      assert.equal(await page.locator('#bk-name-erro').textContent(), 'O nome deve ter de 2 a 80 caracteres.');
      await page.fill('#bk-email', 'ana@');
      await page.locator('#bk-email').blur();
      assert.equal(await page.locator('#bk-email-erro').textContent(), 'Informe um e-mail válido.');
      assert.equal(await phone.inputValue(), '(11) 91234-5678');
    } finally {
      await context.close();
    }
  });

  test('colar 011 91234 5678 não é bloqueado nem reescrito durante a digitação (critério 24)', async () => {
    const { context, page } = await openCustomerStep();
    try {
      const phone = page.locator('#bk-phone');
      await phone.fill('011 91234 5678');
      assert.equal(await phone.inputValue(), '011 91234 5678');
      await phone.fill('');
      await phone.focus();
      const prevented = await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', '011 91234 5678');
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        document.querySelector('#bk-phone').dispatchEvent(event);
        return event.defaultPrevented;
      });
      assert.equal(prevented, false, 'o paste foi bloqueado');
      await page.keyboard.insertText('011 91234 5678');
      assert.equal(await phone.inputValue(), '011 91234 5678');
      await phone.blur();
      assert.equal(await phone.inputValue(), '011 91234 5678');
      assert.equal(await page.locator('#bk-phone-erro').isVisible(), true);
    } finally {
      await context.close();
    }
  });

  test('trocar a data esconde o passo; escolher um horário de novo mostra os mesmos valores e erros (critério 7)', async () => {
    const { context, page } = await openCustomerStep();
    try {
      await page.fill('#bk-name', 'Ana Souza');
      await page.fill('#bk-phone', '123');
      await page.locator('#bk-phone').blur();
      await page.fill('#bk-email', 'ana@example.com');
      await page.fill('#bk-date', '2026-11-30');
      await waitReady(page, 'seg, 30/11');
      assert.equal(await page.locator('#bk-customer').isVisible(), false);
      await page.locator('.pp-slot').first().click();
      await page.locator('#bk-customer').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#bk-name').inputValue(), 'Ana Souza');
      assert.equal(await page.locator('#bk-phone').inputValue(), '123');
      assert.equal(await page.locator('#bk-email').inputValue(), 'ana@example.com');
      assert.equal(await page.locator('#bk-phone-erro').isVisible(), true);
      // Outro horário só atualiza o resumo.
      await page.locator('.pp-slot').nth(1).click();
      assert.equal(await page.locator('#bk-name').inputValue(), 'Ana Souza');
      assert.match(await page.locator('.pp-selected').textContent(), /seg, 30\/11/);
    } finally {
      await context.close();
    }
  });

  test('Enter no passo envia uma vez pelo fetch (AF-11; antes, decisão 3: nenhuma requisição); envio nativo bloqueado e nada na URL', async () => {
    const { context, page } = await openCustomerStep();
    try {
      const requests = [];
      page.on('request', (req) => requests.push(`${req.method()} ${req.url()}`));
      await page.fill('#bk-name', 'Ana Souza');
      await page.fill('#bk-phone', '(11) 91234-5678');
      await page.fill('#bk-email', 'ana@example.com');
      await page.locator('#bk-email').press('Enter');
      await page.locator('.pp-success').waitFor({ state: 'visible' });
      const posts = requests.filter((r) => r.startsWith('POST '));
      assert.equal(posts.length, 1);
      assert.match(posts[0], /\/api\/public\/dados\/appointments$/);
      assert.equal(new URL(page.url()).search, '');
      for (const value of ['Ana', 'ana%40example', '91234']) assert.equal(page.url().includes(value), false);
      const stored = await page.evaluate(() => localStorage.length + sessionStorage.length);
      assert.equal(stored, 0);
    } finally {
      await context.close();
    }
  });

  test('sem cookie (AF-10 item 5): a consulta de horários não envia o cookie de sessão do dono (critério 16)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    await context.addCookies([{ name: 'af_session', value: 'sessao-do-dono', url: customerServer.baseUrl }]);
    const page = await context.newPage();
    const seen = [];
    page.on('request', (req) => seen.push(req));
    try {
      await page.goto(`${customerServer.baseUrl}/dados`, { waitUntil: 'load' });
      await chooseInPage(page, { serviceId: customerServer.data.reference.services[0].id, date: FRIDAY });
      await waitReady(page, 'sex, 27/11');
      const documentRequest = seen.find((r) => r.resourceType() === 'document');
      assert.match((await documentRequest.allHeaders()).cookie || '', /af_session=sessao-do-dono/, 'o cookie existe no contexto');
      const api = seen.filter((r) => r.url().includes('/api/public/'));
      assert.ok(api.length > 0);
      for (const req of api) assert.equal((await req.allHeaders()).cookie, undefined, req.url());
    } finally {
      await context.close();
    }
  });

  test('XSS: o nome malicioso do negócio aparece literal no aviso de privacidade (critério 19)', async () => {
    const { context, page, dialogs } = await openCustomerStep('/xss-dados');
    try {
      const privacy = await page.locator('#dados-privacidade').textContent();
      assert.ok(privacy.includes(`Os dados são recebidos por ${SCRIPT_PAYLOAD}.`), privacy);
      assert.equal(await page.evaluate(() => window.__x), undefined);
      assert.equal(await page.locator('#dados-privacidade *').count(), 0);
      assert.deepEqual(dialogs, []);
    } finally {
      await context.close();
    }
  });
});
