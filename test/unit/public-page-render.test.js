import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPublicPage,
  PUBLIC_PAGE_CSP,
  PUBLIC_MESSAGE_CSP,
  NOT_FOUND_HTML,
  RATE_LIMITED_HTML,
  ERROR_HTML,
  PUBLIC_BOOKING_MODULES,
  PUBLIC_BOOKING_ENTRY,
} from '../../src/modules/public-page/public-page.render.js';
import { tagsOf, tagNamesOf, textOf } from '../helpers/html.js';

const XSS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>'];
const CORTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const BARBA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const ANA_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const BIA_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';

function page({ name = 'Salão da Ana', address = 'Rua A, 10', serviceName = 'Corte', professionalName = 'Ana', logo = true, photo = false, hasOffer = true } = {}) {
  const logoUrl = logo ? '/media/logos/33333333-3333-4333-8333-333333333333.png' : null;
  return {
    business: {
      name,
      slug: 'salao-da-ana',
      address,
      phoneDisplay: '(11) 91234-5678',
      phoneHref: 'tel:+5511912345678',
      logoUrl,
    },
    services: hasOffer
      ? [
          { id: CORTE_ID, name: serviceName, durationMinutes: 30, durationLabel: '30 min', priceLabel: 'R$ 50,00', professionalNames: [professionalName] },
          { id: BARBA_ID, name: 'Barba', durationMinutes: 90, durationLabel: '1 h 30 min', priceLabel: 'Sob consulta', professionalNames: [professionalName, 'Bia'] },
        ]
      : [],
    professionals: hasOffer
      ? [
          {
            id: ANA_ID,
            name: professionalName,
            photoUrl: photo ? '/media/professionals/44444444-4444-4444-8444-444444444444.png' : null,
            serviceIds: [CORTE_ID, BARBA_ID],
            serviceNames: [serviceName, 'Barba'],
          },
          { id: BIA_ID, name: 'Bia', photoUrl: null, serviceIds: [BARBA_ID], serviceNames: ['Barba'] },
        ]
      : [],
    booking: { timezone: 'America/Sao_Paulo', today: '2026-11-26', maxDate: '2027-02-24' },
    hasOffer,
    canonicalUrl: 'https://agendafacil.app/salao-da-ana',
    ogImageUrl: logoUrl ? `https://agendafacil.app${logoUrl}` : null,
    description: `Veja serviços, preços e profissionais de ${name} e agende pelo AgendaFácil.`,
  };
}

const metaContent = (html, attr, value) => tagsOf(html, 'meta').find((m) => m[attr] === value)?.content;

describe('documento (critério 16)', () => {
  test('lang, title, description, OG e canonical', () => {
    const html = renderPublicPage(page());
    assert.match(html, /^<!doctype html>\n<html lang="pt-BR">/);
    assert.match(html, /<title>Salão da Ana · AgendaFácil<\/title>/);
    assert.match(metaContent(html, 'name', 'description'), /Salão da Ana/);
    assert.equal(metaContent(html, 'property', 'og:title'), 'Salão da Ana');
    assert.equal(metaContent(html, 'property', 'og:url'), 'https://agendafacil.app/salao-da-ana');
    assert.equal(
      metaContent(html, 'property', 'og:image'),
      'https://agendafacil.app/media/logos/33333333-3333-4333-8333-333333333333.png',
    );
    assert.equal(tagsOf(html, 'link').find((l) => l.rel === 'canonical').href, 'https://agendafacil.app/salao-da-ana');
  });

  test('sem logo não há og:image', () => {
    const html = renderPublicPage(page({ logo: false }));
    assert.equal(metaContent(html, 'property', 'og:image'), undefined);
  });

  test('sem style= e sem on*=; só o módulo de horários como script (CSP sem unsafe-inline)', () => {
    const pages = [renderPublicPage(page()), renderPublicPage(page({ hasOffer: false }))];
    for (const html of [...pages, NOT_FOUND_HTML.toString(), RATE_LIMITED_HTML.toString(), ERROR_HTML.toString()]) {
      assert.equal(tagNamesOf(html).includes('style'), false);
      assert.doesNotMatch(html, /\sstyle=/);
      assert.doesNotMatch(html, /\son[a-z]+=/i);
    }
    // Com oferta: uma tag <script>, módulo com src, sem conteúdo inline.
    const scripts = tagsOf(pages[0], 'script');
    assert.equal(scripts.length, 1);
    assert.deepEqual(scripts[0], { type: 'module', src: PUBLIC_BOOKING_ENTRY });
    assert.match(pages[0], /<script type="module" src="\/js\/public-booking-page\.js"><\/script>/);
    // Sem oferta e páginas fixas: nenhum script.
    for (const html of [pages[1], NOT_FOUND_HTML.toString(), RATE_LIMITED_HTML.toString(), ERROR_HTML.toString()]) {
      assert.equal(tagNamesOf(html).includes('script'), false);
    }
    assert.doesNotMatch(PUBLIC_PAGE_CSP, /unsafe-inline|unsafe-eval/);
    assert.match(PUBLIC_PAGE_CSP, /script-src 'self'/);
    assert.match(PUBLIC_PAGE_CSP, /connect-src 'self'/);
    assert.match(PUBLIC_PAGE_CSP, /frame-ancestors 'none'/);
  });

  test('um modulepreload por módulo do grafo, antes do script', () => {
    const html = renderPublicPage(page());
    const preloads = tagsOf(html, 'link').filter((l) => l.rel === 'modulepreload').map((l) => l.href);
    assert.deepEqual(preloads, [...PUBLIC_BOOKING_MODULES]);
    assert.equal(new Set(preloads).size, preloads.length);
    assert.ok(html.indexOf('rel="modulepreload"') < html.indexOf('<script'));
    assert.ok(Object.isFrozen(PUBLIC_BOOKING_MODULES));
  });
});

describe('XSS (critério 18)', () => {
  for (const payload of XSS) {
    test(`${payload} em todos os textos do dono não gera tag nem atributo`, () => {
      const html = renderPublicPage(
        page({ name: payload, address: payload, serviceName: payload, professionalName: payload, photo: true }),
      );
      const clean = renderPublicPage(page({ photo: true }));
      assert.deepEqual(tagNamesOf(html), tagNamesOf(clean));
      assert.equal(tagsOf(html, 'script').length, 1);
      assert.equal(tagsOf(html, 'option').length, tagsOf(clean, 'option').length);
      // Dentro de <option> e de data-*, o nome continua literal.
      assert.ok(html.includes(`>${escapeForTest(payload)} · 30 min</option>`));
      assert.ok(html.includes(`value="${ANA_ID}" data-services="${CORTE_ID} ${BARBA_ID}">${escapeForTest(payload)}</option>`));
      assert.equal(tagsOf(html, 'img').length, tagsOf(clean, 'img').length);
      for (const name of new Set(tagNamesOf(html))) {
        for (const attrs of tagsOf(html, name)) {
          for (const key of Object.keys(attrs)) assert.doesNotMatch(key, /^on/i, `${name} ${key}`);
          assert.equal('src' in attrs && attrs.src === 'x', false);
        }
      }
      // O texto exibido é o literal digitado.
      assert.ok(textOf(html).includes(payload));
    });
  }
});

describe('imagens (critérios 2 e 11)', () => {
  test('todo img tem alt, width e height; logo sem loading e com fetchpriority; fotos lazy', () => {
    const html = renderPublicPage(page({ photo: true }));
    const imgs = tagsOf(html, 'img');
    assert.equal(imgs.length, 3);
    for (const img of imgs) {
      assert.ok(img.alt && img.alt.length > 0);
      assert.ok(Number(img.width) > 0 && Number(img.height) > 0);
    }
    const [logo, ...photos] = imgs;
    assert.equal(logo.class, 'pp-logo');
    assert.equal(logo.alt, 'Logo de Salão da Ana');
    assert.equal('loading' in logo, false);
    assert.equal(logo.fetchpriority, 'high');
    for (const photo of photos) {
      assert.equal(photo.loading, 'lazy');
      assert.equal(photo.class, 'pp-avatar');
    }
    assert.equal(photos[0].src, '/media/professionals/44444444-4444-4444-8444-444444444444.png');
    assert.equal(photos[1].src, '/img/avatar-default.svg');
  });

  test('sem logo: placeholder e nenhum img de logo', () => {
    const html = renderPublicPage(page({ logo: false }));
    assert.equal(tagsOf(html, 'img').filter((i) => i.class === 'pp-logo').length, 0);
    assert.ok(tagsOf(html, 'div').some((d) => d.class === 'pp-logo pp-logo-placeholder' && d['aria-hidden'] === 'true'));
  });
});

describe('ação de agendar e estado vazio (critérios 7, 8 e 15)', () => {
  test('cada serviço tem o link Ver horários para a seção #agendar (AF-10)', () => {
    const html = renderPublicPage(page());
    const links = tagsOf(html, 'a').filter((a) => a.class === 'pp-book');
    assert.deepEqual(
      links.map((a) => [a.href, a['data-service-id']]),
      [
        [`?servico=${CORTE_ID}#agendar`, CORTE_ID],
        [`?servico=${BARBA_ID}#agendar`, BARBA_ID],
      ],
    );
    assert.equal((html.match(/>Ver horários<\/a>/g) || []).length, 2);
    assert.match(html, /id="agendar-aviso">Veja os horários livres abaixo\. A confirmação online chega em breve; por enquanto, ligue para \(11\) 91234-5678\./);
    assert.ok(tagsOf(html, 'a').some((a) => a.class === 'skip-link' && a.href === '#servicos'));
    assert.ok(tagsOf(html, 'section').some((s) => s.id === 'servicos'));
  });

  test('seção de horários: hidden, data-* do servidor, campos e noscript (critérios 22 e 28)', () => {
    const html = renderPublicPage(page());
    const [section] = tagsOf(html, 'section').filter((s) => s.class === 'pp-booking');
    assert.ok(section);
    assert.equal('hidden' in section, true);
    assert.equal(section['data-slug'], 'salao-da-ana');
    assert.equal(section['data-today'], '2026-11-26');
    assert.equal(section['data-max-date'], '2027-02-24');
    assert.equal(section['data-timezone'], 'America/Sao_Paulo');
    assert.equal(tagsOf(html, 'div').filter((d) => d.id === 'agendar').length, 1);
    // AF-04: o único formulário é o passo "Seus dados", dentro de .pp-confirm.
    assert.deepEqual(tagsOf(html, 'form').map((f) => f.id), ['bk-customer']);
    assert.match(html, /<noscript><p class="pp-notice">Para ver os horários livres, ative o JavaScript ou ligue para <a href="tel:\+5511912345678">\(11\) 91234-5678<\/a>\.<\/p><\/noscript>/);

    const options = tagsOf(html, 'option');
    assert.deepEqual(
      options.map((o) => o.value),
      ['', CORTE_ID, BARBA_ID, 'any', ANA_ID, BIA_ID],
    );
    assert.equal(options[1]['data-duration'], '30');
    assert.equal(options[2]['data-duration'], '90');
    assert.equal(options[4]['data-services'], `${CORTE_ID} ${BARBA_ID}`);
    assert.equal(options[5]['data-services'], BARBA_ID);
    assert.ok(html.includes('>Corte · 30 min</option>'));
    assert.ok(html.includes('>Qualquer profissional</option>'));
    const [date] = tagsOf(html, 'input');
    assert.deepEqual(date, { id: 'bk-date', type: 'date', min: '2026-11-26', max: '2027-02-24', value: '2026-11-26' });
    assert.ok(textOf(html).includes('Horários no fuso America/Sao_Paulo.'));
    for (const id of ['bk-service', 'bk-professional', 'bk-date']) {
      assert.ok(tagsOf(html, 'label').some((l) => l.for === id), id);
    }
  });

  test('Confirmar agendamento desabilitado, com aviso de que o horário não está reservado (critério 22)', () => {
    const html = renderPublicPage(page());
    const buttons = tagsOf(html, 'button');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].class, 'pp-confirm-button');
    assert.equal('disabled' in buttons[0], true);
    assert.equal(buttons[0]['aria-describedby'], 'confirmar-aviso');
    assert.equal(buttons[0].type, 'submit');
    assert.match(html, />Confirmar agendamento<\/button>/);
    assert.match(html, /id="confirmar-aviso" class="pp-notice">A confirmação online chega em breve\. Este horário ainda não está reservado: para garantir, ligue para \(11\) 91234-5678\./);
    assert.ok(tagsOf(html, 'div').some((d) => d.class === 'pp-confirm' && 'hidden' in d));
  });

  test('estado vazio: texto explicativo e link tel:', () => {
    const html = renderPublicPage(page({ hasOffer: false }));
    const text = textOf(html);
    assert.ok(text.includes('Agendamento online indisponível'));
    assert.ok(text.includes('Este negócio ainda não tem serviços disponíveis para agendar pela internet.'));
    assert.ok(tagsOf(html, 'a').some((a) => a.href === 'tel:+5511912345678' && a.class === 'pp-empty-phone'));
    assert.equal(tagsOf(html, 'button').length, 0);
    assert.equal(tagsOf(html, 'section').some((s) => s.class === 'pp-booking'), false);
    assert.ok(tagsOf(html, 'section').some((s) => s.id === 'servicos'));
  });

  test('lista de serviços e profissionais no HTML', () => {
    const text = textOf(renderPublicPage(page()));
    for (const expected of ['Corte', 'Barba', '30 min', 'R$ 50,00', '1 h 30 min', 'Sob consulta', 'Com: Ana, Bia']) {
      assert.ok(text.includes(expected), expected);
    }
  });
});

describe('passo "Seus dados" (AF-04, critérios 19, 21, 22 e 25)', () => {
  /** Trecho de .pp-confirm (do div até o fim do form). */
  function confirmBlock(html) {
    const start = html.indexOf('<div class="pp-confirm" hidden>');
    const end = html.indexOf('</form>', start);
    assert.ok(start >= 0 && end > start);
    return html.slice(start, end + '</form>'.length);
  }

  test('form novalidate sem action nem method, dentro de .pp-confirm', () => {
    const html = renderPublicPage(page());
    const block = confirmBlock(html);
    const forms = tagsOf(block, 'form');
    assert.equal(forms.length, 1);
    const [form] = forms;
    assert.equal(form.id, 'bk-customer');
    assert.equal(form.class, 'pp-customer');
    assert.equal('novalidate' in form, true);
    assert.equal('action' in form, false);
    assert.equal('method' in form, false);
    assert.equal(form['aria-labelledby'], 'dados-titulo');
    assert.match(block, /<h3 id="dados-titulo">Seus dados<\/h3>/);
  });

  test('campos com autocomplete, inputmode e type; label for; aria-describedby; sem maxlength', () => {
    const html = renderPublicPage(page());
    const block = confirmBlock(html);
    const inputs = Object.fromEntries(tagsOf(block, 'input').map((i) => [i.id, i]));
    assert.deepEqual(Object.keys(inputs), ['bk-name', 'bk-phone', 'bk-email']);
    assert.equal(inputs['bk-name'].type, 'text');
    assert.equal(inputs['bk-name'].autocomplete, 'name');
    assert.equal(inputs['bk-name'].name, 'name');
    assert.equal(inputs['bk-phone'].type, 'tel');
    assert.equal(inputs['bk-phone'].inputmode, 'tel');
    assert.equal(inputs['bk-phone'].autocomplete, 'tel-national');
    assert.equal(inputs['bk-phone'].name, 'phone');
    assert.equal(inputs['bk-email'].type, 'email');
    assert.equal(inputs['bk-email'].autocomplete, 'email');
    assert.equal(inputs['bk-email'].name, 'email');
    assert.equal(inputs['bk-name']['aria-describedby'], 'bk-name-erro');
    assert.equal(inputs['bk-phone']['aria-describedby'], 'bk-phone-dica bk-phone-erro');
    assert.equal(inputs['bk-email']['aria-describedby'], 'bk-email-erro');
    const ids = new Set([...block.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const labels = tagsOf(block, 'label').map((l) => l.for);
    for (const input of Object.values(inputs)) {
      assert.ok(labels.includes(input.id), `${input.id} sem label`);
      assert.equal('required' in input, true);
      assert.equal('maxlength' in input, false);
      for (const ref of input['aria-describedby'].split(' ')) assert.ok(ids.has(ref), `${input.id} -> ${ref}`);
    }
    for (const id of ['bk-name-erro', 'bk-phone-erro', 'bk-email-erro']) {
      const [error] = tagsOf(block, 'p').filter((p) => p.id === id);
      assert.equal(error.class, 'pp-field-error');
      // Live region sempre presente (vazio sem erro): anunciado ao receber a mensagem (critério 23).
      assert.equal(error['aria-live'], 'polite');
      assert.equal('hidden' in error, false);
      assert.equal('role' in error, false, 'sem role=alert (anúncio assertivo duplicado)');
    }
    assert.doesNotMatch(html, /maxlength/i);
  });

  test('botão submit desabilitado no formulário, com o aviso; texto sem promessa', () => {
    const html = renderPublicPage(page());
    const block = confirmBlock(html);
    const [button] = tagsOf(block, 'button');
    assert.equal(button.type, 'submit');
    assert.equal('disabled' in button, true);
    assert.equal(button['aria-describedby'], 'confirmar-aviso');
    const text = textOf(html).toLowerCase();
    assert.equal(text.includes('confirmado'), false);
    assert.equal(text.includes('reservado para você'), false);
    assert.ok(textOf(block).includes('Este horário ainda não está reservado'));
  });

  test('aviso de privacidade com o nome do negócio (critério 21)', () => {
    const html = renderPublicPage(page());
    const [privacy] = tagsOf(html, 'p').filter((p) => p.id === 'dados-privacidade');
    assert.equal(privacy.class, 'pp-privacy');
    assert.ok(
      textOf(html).includes(
        'Usamos seu nome, telefone e e-mail só para fazer este agendamento e avisar você sobre ele. Os dados são recebidos por Salão da Ana. Não pedimos senha nem criamos conta.',
      ),
    );
  });

  for (const payload of XSS) {
    test(`XSS no nome do negócio (${payload}) sai escapado no aviso de privacidade`, () => {
      const html = renderPublicPage(page({ name: payload }));
      const block = confirmBlock(html);
      const clean = confirmBlock(renderPublicPage(page()));
      assert.deepEqual(tagNamesOf(block), tagNamesOf(clean));
      assert.ok(block.includes(`Os dados são recebidos por ${escapeForTest(payload)}.`));
      for (const name of new Set(tagNamesOf(block))) {
        for (const attrs of tagsOf(block, name)) {
          for (const key of Object.keys(attrs)) assert.doesNotMatch(key, /^(on|style$)/i, `${name} ${key}`);
        }
      }
    });
  }

  test('sem oferta, sem formulário', () => {
    assert.equal(tagsOf(renderPublicPage(page({ hasOffer: false })), 'form').length, 0);
  });

  test('os dois módulos do AF-04 estão no grafo pré-carregado', () => {
    assert.ok(PUBLIC_BOOKING_MODULES.includes('/js/customer-form-controller.js'));
    assert.ok(PUBLIC_BOOKING_MODULES.includes('/shared/customers.js'));
  });
});

describe('CSP das páginas fixas (AF-10 item 2)', () => {
  test('PUBLIC_MESSAGE_CSP sem script-src e sem connect-src; 404, 429 e 500 sem script nem modulepreload', () => {
    assert.doesNotMatch(PUBLIC_MESSAGE_CSP, /script-src|connect-src|unsafe/);
    assert.match(PUBLIC_MESSAGE_CSP, /^default-src 'none';/);
    assert.match(PUBLIC_MESSAGE_CSP, /form-action 'none'/);
    assert.match(PUBLIC_MESSAGE_CSP, /frame-ancestors 'none'/);
    assert.match(PUBLIC_MESSAGE_CSP, /style-src 'self'/);
    for (const buffer of [NOT_FOUND_HTML, RATE_LIMITED_HTML, ERROR_HTML]) {
      const html = buffer.toString();
      assert.equal(tagsOf(html, 'script').length, 0);
      assert.equal(tagsOf(html, 'link').filter((l) => l.rel === 'modulepreload').length, 0);
    }
  });
});

describe('404 constante (critérios 6 e 21)', () => {
  test('NOT_FOUND_HTML é Buffer e tem os mesmos bytes em duas cargas do módulo', async () => {
    const other = await import(`../../src/modules/public-page/public-page.render.js?reload=${Date.now()}`);
    assert.ok(Buffer.isBuffer(NOT_FOUND_HTML));
    assert.ok(NOT_FOUND_HTML.equals(other.NOT_FOUND_HTML));
    assert.notEqual(NOT_FOUND_HTML, other.NOT_FOUND_HTML);
  });
});

/** Mesmo escape da tag `html` (para procurar o texto no HTML gerado). */
function escapeForTest(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  return text.replace(/[&<>"'`]/g, (c) => map[c]);
}
