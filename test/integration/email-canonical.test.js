// AF-18, achado M1 da revisão de segurança: o e-mail é canonizado na entrada (domínio UTS-46 em
// ASCII, minúsculas), então variantes em largura total e em punycode da mesma caixa viram o MESMO
// cliente. Vale para o teto de 10 e-mails por destinatário (critério 27), para o limite de 3
// agendamentos futuros por cliente (AF-11) e para a conta do dono (AF-01/AF-02).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { domainToASCII } from 'node:url';
import { emailTestApp, seedBusiness, FRIDAY, outboxRows, drain } from '../helpers/email.js';
import { bookingBody, postAppointment } from '../helpers/appointments.js';
import { TEST_PASSWORD } from '../helpers/session.js';
import { normalizeEmail, validateEmail, canonicalEmailDomain } from '../../src/shared/validation.js';
import { validateCustomerEmail } from '../../src/shared/customers.js';
import { toSafeAddress } from '../../src/modules/email/message.js';

const FULLWIDTH = ['victim@example.com', 'victim@ｅxample.com', 'victim@eｘample.com', 'victim@ｅｘａｍｐｌｅ.ｃｏｍ', 'VICTIM@EXAMPLE.COM'];
const PUNYCODE = ['a@bücher.de', 'a@xn--bcher-kva.de', 'A@BÜCHER.DE', 'a@XN--BCHER-KVA.DE'];

describe('normalizeEmail canoniza o domínio (M1)', () => {
  test('variantes em largura total e punycode dão a mesma chave, igual ao endereço de envio', () => {
    for (const group of [FULLWIDTH, PUNYCODE]) {
      const keys = new Set(group.map(normalizeEmail));
      assert.equal(keys.size, 1, JSON.stringify([...keys]));
      const [key] = keys;
      for (const v of group) {
        assert.equal(validateEmail(v), null, v);
        assert.equal(validateCustomerEmail(v), null, v);
      }
      // A chave guardada é exatamente o que o worker manda (toSafeAddress é ponto fixo).
      assert.equal(toSafeAddress(key), key);
    }
    assert.equal(normalizeEmail('victim@ｅｘａｍｐｌｅ.ｃｏｍ'), 'victim@example.com');
    assert.equal(normalizeEmail('a@bücher.de'), 'a@xn--bcher-kva.de');
  });

  test('igual a domainToASCII do Node e idempotente', () => {
    const domains = ['ｅxample.com', 'bücher.de', 'xn--bcher-kva.de', 'EXAMPLE.COM', 'straße.de', '例え.jp', '１２３.com', 'a_b.com', 'example．com'];
    for (const d of domains) {
      const c = canonicalEmailDomain(d);
      assert.equal(c, domainToASCII(d), d);
      assert.equal(canonicalEmailDomain(c), c, `idempotente: ${d}`);
      assert.equal(normalizeEmail(normalizeEmail(`x@${d}`)), normalizeEmail(`x@${d}`));
    }
  });

  test('domínio que não converte ou que o analisador de URL cortaria é recusado', () => {
    for (const v of ['a@xn--a.com', 'a@exa mple.com', 'a@b/c.com', 'a@b\\c.com', 'a@ex%2ecom', 'a@b.c:80', 'a@b?.com', 'a@b#.com', 'a@b..com', 'a@b.com.', 'a@[::1].com']) {
      assert.equal(validateEmail(v), 'Informe um e-mail válido.', v);
      assert.notEqual(validateCustomerEmail(v), null, v);
    }
  });

  test('a parte local só tem NFC e minúsculas (largura total na parte local é outra caixa)', () => {
    assert.equal(normalizeEmail('ＶIctim@example.com'), 'ｖictim@example.com');
    assert.equal(normalizeEmail('João@example.com'), 'joão@example.com');
  });
});

describe('no app', () => {
  let app;
  let transport;
  let keepAlive;

  beforeEach(async () => {
    ({ app, transport } = await emailTestApp());
    keepAlive = setInterval(() => {}, 50);
  });
  afterEach(async () => {
    clearInterval(keepAlive);
    await app.close();
  });

  const book = (seed, { start, email, phone }) =>
    postAppointment(app, seed.slug, bookingBody({ serviceId: seed.service.id, professionalId: seed.professionals[0].id, start, customer: { email, phone } }));

  for (const [label, group] of [['largura total', FULLWIDTH], ['punycode', PUNYCODE]]) {
    test(`limite de 3 futuros (AF-11) com variantes em ${label}: o 4º dá 409 e há um cliente só`, async () => {
      const seed = await seedBusiness(app);
      const starts = ['09:00', '10:00', '11:00', '13:00'];
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const res = await book(seed, { start: `${FRIDAY}T${starts[i]}`, email: group[i], phone: `1191234500${i}` });
        statuses.push(res.statusCode);
        if (i === 3) assert.equal(res.json().error.code, 'BOOKING_LIMIT_REACHED');
      }
      assert.deepEqual(statuses, [201, 201, 201, 409]);
      const customers = await app.db.all('SELECT email FROM customers WHERE business_id = ?', [seed.business.id]);
      assert.deepEqual(customers.map((c) => c.email), [normalizeEmail(group[0])]);
    });

    test(`teto de 10 por destinatário (critério 27) com variantes em ${label}, em 4 negócios: 10 saem, o resto é recipient_limited`, async () => {
      const seeds = [];
      for (let b = 0; b < 4; b++) seeds.push(await seedBusiness(app, { email: `dono-teto-${b}@x.com`, name: `Negócio Teto ${b}` }));
      let k = 0;
      for (const seed of seeds) {
        for (const start of ['09:00', '10:00', '11:00']) {
          const res = await book(seed, { start: `${FRIDAY}T${start}`, email: group[k % group.length], phone: `119123460${String(k).padStart(2, '0')}` });
          assert.equal(res.statusCode, 201, res.body);
          k += 1;
          await drain(app);
        }
      }
      const rows = await outboxRows(app.db);
      assert.equal(rows.length, 12);
      assert.equal(rows.filter((r) => r.status === 'sent').length, 10);
      assert.deepEqual(
        rows.filter((r) => r.status !== 'sent').map((r) => [r.status, r.last_error_code]),
        [['skipped', 'recipient_limited'], ['skipped', 'recipient_limited']],
      );
      assert.equal(transport.messages.length, 10);
      assert.equal(new Set(transport.messages.map((m) => m.to)).size, 1);
    });
  }

  test('conta do dono (AF-01/AF-02): cadastro com punycode depois de Unicode dá 409; login com largura total entra', async () => {
    const signup = (email) => app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Dona', email, password: TEST_PASSWORD } });
    assert.equal((await signup('dona@bücher.de')).statusCode, 201);
    const dup = await signup('dona@xn--bcher-kva.de');
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error.code, 'EMAIL_TAKEN');
    assert.deepEqual(await app.db.all("SELECT email FROM users WHERE email LIKE 'dona@%'"), [{ email: 'dona@xn--bcher-kva.de' }]);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'DONA@ＢÜＣＨＥＲ.ＤＥ', password: TEST_PASSWORD } });
    assert.equal(login.statusCode, 200, login.body);
  });
});
