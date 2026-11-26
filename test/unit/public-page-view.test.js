import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toPublicPage, PUBLIC_PAGE_FIELDS } from '../../src/modules/public-page/public-page.view.js';

// 2026-11-26T12:00Z = 09:00 em São Paulo (quinta-feira).
const NOW_MS = Date.parse('2026-11-26T12:00:00.000Z');
const BASE = { publicBaseUrl: 'https://agendafacil.app', nowMs: NOW_MS };
const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const LOGO_UUID = '33333333-3333-4333-8333-333333333333';
const CREATED = '2026-01-02T03:04:05.000Z';
const UPDATED = '2026-02-03T04:05:06.000Z';

const business = (extra = {}) => ({
  id: BUSINESS_ID,
  ownerId: OWNER_ID,
  name: 'Salão da Ana',
  slug: 'salao-da-ana',
  address: 'Rua A, 10',
  phone: '11912345678',
  timezone: 'America/Sao_Paulo',
  logoKey: `logos/${LOGO_UUID}.png`,
  createdAt: CREATED,
  updatedAt: UPDATED,
  ...extra,
});

let n = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}`;

function service(name, extra = {}) {
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    name,
    nameKey: `key-${name.toLowerCase()}`,
    durationMinutes: 30,
    priceCents: 5000,
    priceOnRequest: false,
    active: true,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...extra,
  };
}

function professional(name, services, extra = {}) {
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    name,
    nameKey: `key-${name.toLowerCase()}`,
    photoKey: null,
    removedAt: null,
    createdAt: CREATED,
    updatedAt: UPDATED,
    services: services.map((s) => ({ id: s.id, name: s.name, active: true })),
    ...extra,
  };
}

/** Compara as chaves de todos os níveis com a lista permitida (recursivo). */
function assertAllowedKeys(page) {
  assert.deepEqual(Object.keys(page).sort(), [...PUBLIC_PAGE_FIELDS.page].sort());
  assert.deepEqual(Object.keys(page.business).sort(), [...PUBLIC_PAGE_FIELDS.business].sort());
  assert.deepEqual(Object.keys(page.booking).sort(), [...PUBLIC_PAGE_FIELDS.booking].sort());
  for (const s of page.services) assert.deepEqual(Object.keys(s).sort(), [...PUBLIC_PAGE_FIELDS.service].sort());
  for (const p of page.professionals) {
    assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_PAGE_FIELDS.professional].sort());
  }
}

describe('lista permitida (critério 17)', () => {
  test('entidades completas: só as chaves de PUBLIC_PAGE_FIELDS e nenhum valor interno', () => {
    const corte = service('Corte');
    const ana = professional('Ana', [corte], { photoKey: 'professionals/44444444-4444-4444-8444-444444444444.png' });
    const page = toPublicPage({ business: business(), services: [corte], professionals: [ana] }, BASE);
    assertAllowedKeys(page);
    assert.equal(page.services.length, 1);
    assert.equal(page.professionals.length, 1);
    const json = JSON.stringify(page);
    for (const secret of [BUSINESS_ID, OWNER_ID, CREATED, UPDATED, corte.nameKey, ana.nameKey]) {
      assert.equal(json.includes(secret), false, secret);
    }
    // AF-10: só os ids de serviço e profissional, a duração e os serviços de cada profissional.
    assert.equal(page.services[0].id, corte.id);
    assert.equal(page.services[0].durationMinutes, 30);
    assert.equal(page.professionals[0].id, ana.id);
    assert.deepEqual(page.professionals[0].serviceIds, [corte.id]);
    assert.equal(/"logos\//.test(json), false);
    assert.equal(/"professionals\//.test(json), false);
    assert.equal(page.professionals[0].photoUrl, '/media/professionals/44444444-4444-4444-8444-444444444444.png');
  });

  test('serviceIds só traz serviços visíveis (desativado e oculto ficam de fora)', () => {
    const corte = service('Corte');
    const off = service('Luzes', { active: false });
    const ana = professional('Ana', [corte, off]);
    const page = toPublicPage({ business: business(), services: [corte, off], professionals: [ana] }, BASE);
    assert.deepEqual(page.professionals[0].serviceIds, [corte.id]);
    assert.equal(JSON.stringify(page).includes(off.id), false);
  });

  test('PUBLIC_PAGE_FIELDS é congelado', () => {
    assert.equal(Object.isFrozen(PUBLIC_PAGE_FIELDS), true);
    for (const list of Object.values(PUBLIC_PAGE_FIELDS)) assert.equal(Object.isFrozen(list), true);
  });
});

describe('visibilidade (critérios 3 a 5, decisões 3 e 4)', () => {
  test('serviço ativo sem profissional listado fica oculto', () => {
    const corte = service('Corte');
    const barba = service('Barba');
    const page = toPublicPage(
      { business: business(), services: [corte, barba], professionals: [professional('Ana', [corte])] },
      BASE,
    );
    assert.deepEqual(
      page.services.map((s) => s.name),
      ['Corte'],
    );
  });

  test('serviço desativado nunca aparece, mesmo vinculado', () => {
    const corte = service('Corte', { active: false });
    const barba = service('Barba');
    const page = toPublicPage(
      { business: business(), services: [corte, barba], professionals: [professional('Ana', [corte, barba])] },
      BASE,
    );
    assert.deepEqual(page.services.map((s) => s.name), ['Barba']);
    assert.deepEqual(page.professionals[0].serviceNames, ['Barba']);
  });

  test('só aparecem os profissionais recebidos (findListedByBusinessId), na ordem recebida', () => {
    const corte = service('Corte');
    const bia = professional('Bia', [corte]);
    const ana = professional('Ana', [corte]);
    const page = toPublicPage({ business: business(), services: [corte], professionals: [ana, bia] }, BASE);
    assert.deepEqual(page.professionals.map((p) => p.name), ['Ana', 'Bia']);
    assert.deepEqual(page.services[0].professionalNames, ['Ana', 'Bia']);
  });

  test('sem serviços ou sem profissionais: hasOffer false e listas vazias (critério 7)', () => {
    const corte = service('Corte');
    for (const data of [
      { services: [], professionals: [] },
      { services: [corte], professionals: [] },
      { services: [], professionals: [professional('Ana', [corte])] },
    ]) {
      const page = toPublicPage({ business: business(), ...data }, BASE);
      assert.equal(page.hasOffer, false);
      assert.deepEqual(page.services, []);
      assert.deepEqual(page.professionals, []);
      assertAllowedKeys(page);
    }
  });
});

describe('formato (critérios 3 e 25)', () => {
  const cases = [
    [{ priceCents: 5000 }, 'R$ 50,00'],
    [{ priceCents: 123456 }, 'R$ 1.234,56'],
    [{ priceCents: 1 }, 'R$ 0,01'],
    [{ priceCents: null, priceOnRequest: true }, 'Sob consulta'],
  ];
  for (const [extra, label] of cases) {
    test(`preço ${label}`, () => {
      const s = service('Corte', extra);
      const page = toPublicPage({ business: business(), services: [s], professionals: [professional('Ana', [s])] }, BASE);
      assert.equal(page.services[0].priceLabel, label);
    });
  }

  for (const [minutes, label] of [
    [15, '15 min'],
    [60, '1 h'],
    [90, '1 h 30 min'],
    [480, '8 h'],
  ]) {
    test(`duração ${minutes} -> ${label}`, () => {
      const s = service('Corte', { durationMinutes: minutes });
      const page = toPublicPage({ business: business(), services: [s], professionals: [professional('Ana', [s])] }, BASE);
      assert.equal(page.services[0].durationLabel, label);
    });
  }
});

describe('contato, OG e descrição (critério 16)', () => {
  test('telefone com tel:+55 e formatado; fixo também', () => {
    let page = toPublicPage({ business: business(), services: [], professionals: [] }, BASE);
    assert.equal(page.business.phoneHref, 'tel:+5511912345678');
    assert.equal(page.business.phoneDisplay, '(11) 91234-5678');
    page = toPublicPage({ business: business({ phone: '1131234567' }), services: [], professionals: [] }, BASE);
    assert.equal(page.business.phoneHref, 'tel:+551131234567');
    assert.equal(page.business.phoneDisplay, '(11) 3123-4567');
  });

  test('ogImageUrl absoluto com publicBaseUrl; null sem logo; canonical pela config', () => {
    let page = toPublicPage({ business: business(), services: [], professionals: [] }, BASE);
    assert.equal(page.business.logoUrl, `/media/logos/${LOGO_UUID}.png`);
    assert.equal(page.ogImageUrl, `https://agendafacil.app/media/logos/${LOGO_UUID}.png`);
    assert.equal(page.canonicalUrl, 'https://agendafacil.app/salao-da-ana');
    page = toPublicPage({ business: business({ logoKey: null }), services: [], professionals: [] }, BASE);
    assert.equal(page.business.logoUrl, null);
    assert.equal(page.ogImageUrl, null);
  });

  test('descrição com o texto do design; com nome de 100, no máximo 168 caracteres', () => {
    let page = toPublicPage({ business: business(), services: [], professionals: [] }, BASE);
    assert.equal(page.description, 'Veja serviços, preços e profissionais de Salão da Ana e agende pelo AgendaFácil.');
    page = toPublicPage({ business: business({ name: 'N'.repeat(100) }), services: [], professionals: [] }, BASE);
    assert.ok(page.description.includes('N'.repeat(100)));
    assert.ok(page.description.length <= 168, String(page.description.length));
  });
});

describe('booking: hoje e horizonte no fuso do negócio (AF-10, critérios 18 e 28)', () => {
  test('today e maxDate (hoje + 90) calculados de nowMs no fuso do negócio', () => {
    const page = toPublicPage({ business: business(), services: [], professionals: [] }, BASE);
    assert.deepEqual(page.booking, { timezone: 'America/Sao_Paulo', today: '2026-11-26', maxDate: '2027-02-24' });
  });

  test('23:30 em São Paulo (02:30Z do dia seguinte) continua today local', () => {
    const nowMs = Date.parse('2026-11-27T02:30:00.000Z');
    const page = toPublicPage({ business: business(), services: [], professionals: [] }, { ...BASE, nowMs });
    assert.equal(page.booking.today, '2026-11-26');
  });

  test('outro fuso do negócio muda a data, não o fuso do processo', () => {
    const nowMs = Date.parse('2026-11-26T16:00:00.000Z'); // 01:00 do dia 27 em Tóquio
    const page = toPublicPage(
      { business: business({ timezone: 'Asia/Tokyo' }), services: [], professionals: [] },
      { ...BASE, nowMs },
    );
    assert.deepEqual(page.booking, { timezone: 'Asia/Tokyo', today: '2026-11-27', maxDate: '2027-02-25' });
  });
});
