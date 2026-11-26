import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderPublicPage, PUBLIC_PAGE_CSP, NOT_FOUND_HTML } from '../../src/modules/public-page/public-page.render.js';
import { tagsOf, tagNamesOf, textOf } from '../helpers/html.js';

const XSS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>'];

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
          { name: serviceName, durationLabel: '30 min', priceLabel: 'R$ 50,00', professionalNames: [professionalName] },
          { name: 'Barba', durationLabel: '1 h 30 min', priceLabel: 'Sob consulta', professionalNames: [professionalName, 'Bia'] },
        ]
      : [],
    professionals: hasOffer
      ? [
          {
            name: professionalName,
            photoUrl: photo ? '/media/professionals/44444444-4444-4444-8444-444444444444.png' : null,
            serviceNames: [serviceName, 'Barba'],
          },
          { name: 'Bia', photoUrl: null, serviceNames: ['Barba'] },
        ]
      : [],
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

  test('sem script, sem style= e sem on*= (CSP sem unsafe-inline)', () => {
    for (const html of [renderPublicPage(page()), renderPublicPage(page({ hasOffer: false })), NOT_FOUND_HTML.toString()]) {
      assert.equal(tagNamesOf(html).includes('script'), false);
      assert.equal(tagNamesOf(html).includes('style'), false);
      assert.doesNotMatch(html, /\sstyle=/);
      assert.doesNotMatch(html, /\son[a-z]+=/i);
    }
    assert.doesNotMatch(PUBLIC_PAGE_CSP, /unsafe-inline/);
    assert.match(PUBLIC_PAGE_CSP, /frame-ancestors 'none'/);
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
  test('cada serviço tem botão Agendar desabilitado ligado ao aviso', () => {
    const html = renderPublicPage(page());
    const buttons = tagsOf(html, 'button');
    assert.equal(buttons.length, 2);
    for (const b of buttons) {
      assert.equal('disabled' in b, true);
      assert.equal(b['aria-describedby'], 'agendar-aviso');
    }
    assert.match(html, /id="agendar-aviso">Agendamento online em breve/);
    assert.ok(tagsOf(html, 'a').some((a) => a.class === 'skip-link' && a.href === '#servicos'));
    assert.ok(tagsOf(html, 'section').some((s) => s.id === 'servicos'));
  });

  test('estado vazio: texto explicativo e link tel:', () => {
    const html = renderPublicPage(page({ hasOffer: false }));
    const text = textOf(html);
    assert.ok(text.includes('Agendamento online indisponível'));
    assert.ok(text.includes('Este negócio ainda não tem serviços disponíveis para agendar pela internet.'));
    assert.ok(tagsOf(html, 'a').some((a) => a.href === 'tel:+5511912345678' && a.class === 'pp-empty-phone'));
    assert.equal(tagsOf(html, 'button').length, 0);
    assert.ok(tagsOf(html, 'section').some((s) => s.id === 'servicos'));
  });

  test('lista de serviços e profissionais no HTML', () => {
    const text = textOf(renderPublicPage(page()));
    for (const expected of ['Corte', 'Barba', '30 min', 'R$ 50,00', '1 h 30 min', 'Sob consulta', 'Com: Ana, Bia']) {
      assert.ok(text.includes(expected), expected);
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
