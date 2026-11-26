import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import { signupAndLogin, createBusinessFor } from '../helpers/session.js';
import { validCustomer, countCustomers } from '../helpers/customers.js';
import { ValidationError } from '../../src/http/errors.js';
import { CUSTOMER_MESSAGES as M } from '../../src/shared/customers.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW = '2026-11-26T12:00:00.000Z';

let app;
let logs;
let clock;
let service;
let repo;
let businessA;
let businessB;
let seq = 0;

before(async () => {
  clock = createClock(NOW);
  ({ app, logs } = await buildTestApp({ now: clock.now }));
  service = app.services.customersService;
  repo = app.services.customersRepository;
  businessA = (await createBusinessFor(app, await signupAndLogin(app, { email: 'dono-a@x.com' }), { name: 'Negócio A' })).id;
  businessB = (await createBusinessFor(app, await signupAndLogin(app, { email: 'dono-b@x.com' }), { name: 'Negócio B' })).id;
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  seq += 1;
});

/** E-mail único por teste (o banco é compartilhado entre os testes do arquivo). */
const email = (tag = '') => `cliente${seq}${tag}@example.com`;

const inTx = (fn) => app.db.transaction(fn);

describe('findOrCreate (critérios 8 a 15)', () => {
  test('criar: customerId UUID v4 e snapshot normalizado e congelado', async () => {
    const input = validCustomer({ email: ` ${email().toUpperCase()} ` });
    const result = await inTx((tx) => service.findOrCreate(businessA, input, tx));
    assert.deepEqual(Object.keys(result).sort(), ['customerId', 'snapshot']);
    assert.match(result.customerId, UUID_V4);
    assert.deepEqual(result.snapshot, { name: 'Ana Souza', phone: '11912345678', email: email() });
    assert.ok(Object.isFrozen(result.snapshot));
    const row = await repo.findById(result.customerId, businessA);
    assert.deepEqual(row, {
      id: result.customerId,
      businessId: businessA,
      name: 'Ana Souza',
      phone: '11912345678',
      email: email(),
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  test('reaproveitar sem sobrescrever (decisão 1): mesmo id, snapshot novo, linha antiga', async () => {
    const first = await inTx((tx) => service.findOrCreate(businessA, validCustomer({ email: email() }), tx));
    clock.advance(60_000);
    const second = await inTx((tx) =>
      service.findOrCreate(businessA, { name: 'Outra Pessoa', phone: '+55 21 3123-4567', email: `  ${email().toUpperCase()}` }, tx),
    );
    assert.equal(second.customerId, first.customerId);
    assert.deepEqual(second.snapshot, { name: 'Outra Pessoa', phone: '2131234567', email: email() });
    const row = await repo.findById(first.customerId, businessA);
    assert.equal(row.name, 'Ana Souza');
    assert.equal(row.phone, '11912345678');
    assert.equal(row.updatedAt, row.createdAt);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM customers WHERE email = ?', [email()])).n, 1);
  });

  test('mesmo formato na criação e no reaproveitamento (critério 11)', async () => {
    const shape = (r) => ({
      keys: Object.keys(r).sort(),
      types: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v])),
      snapshotKeys: Object.keys(r.snapshot).sort(),
    });
    const created = await inTx((tx) => service.findOrCreate(businessA, validCustomer({ email: email() }), tx));
    const reused = await inTx((tx) => service.findOrCreate(businessA, validCustomer({ email: email() }), tx));
    assert.deepEqual(shape(created), shape(reused));
    assert.deepEqual(created, reused);
    assert.equal('created' in created, false);
  });

  test('por negócio: o mesmo e-mail em dois negócios dá ids diferentes (critério 9)', async () => {
    const a = await inTx((tx) => service.findOrCreate(businessA, validCustomer({ email: email() }), tx));
    const b = await inTx((tx) => service.findOrCreate(businessB, validCustomer({ email: email(), name: 'Bia' }), tx));
    assert.notEqual(a.customerId, b.customerId);
    assert.equal(await repo.findById(a.customerId, businessB), undefined);
    assert.equal((await repo.findById(b.customerId, businessB)).name, 'Bia');
  });

  test('transação (critério 13): falha depois do findOrCreate não deixa cliente; commit deixa 1', async () => {
    const before = await countCustomers(app.db, businessA);
    await assert.rejects(
      inTx(async (tx) => {
        await service.findOrCreate(businessA, validCustomer({ email: email() }), tx);
        throw new Error('agendamento falhou');
      }),
      /agendamento falhou/,
    );
    assert.equal(await countCustomers(app.db, businessA), before);
    await inTx((tx) => service.findOrCreate(businessA, validCustomer({ email: email() }), tx));
    assert.equal(await countCustomers(app.db, businessA), before + 1);
  });

  test('concorrência (critério 12): 20 transações simultâneas com o mesmo e-mail dão 1 linha e o mesmo id', async () => {
    const variants = Array.from({ length: 20 }, (_, i) => (i % 2 ? `  ${email().toUpperCase()} ` : email()));
    const results = await Promise.all(
      variants.map((e, i) => inTx((tx) => service.findOrCreate(businessA, validCustomer({ email: e, name: `Pessoa ${i}` }), tx))),
    );
    assert.equal(new Set(results.map((r) => r.customerId)).size, 1);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM customers WHERE email = ?', [email()])).n, 1);
    assert.equal((await repo.findById(results[0].customerId, businessA)).name, 'Pessoa 0');
  });

  test('concorrência fora de transação (conn = db): 20 chamadas, 1 linha, sem rejeição', async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => service.findOrCreate(businessA, validCustomer({ email: email() }), app.db)),
    );
    assert.deepEqual(settled.filter((s) => s.status === 'rejected'), []);
    assert.equal(new Set(settled.map((s) => s.value.customerId)).size, 1);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM customers WHERE email = ?', [email()])).n, 1);
  });

  test('sem conn: TypeError e nada gravado', async () => {
    const before = await countCustomers(app.db);
    for (const conn of [undefined, null, {}]) {
      await assert.rejects(service.findOrCreate(businessA, validCustomer({ email: email() }), conn), TypeError);
    }
    assert.equal(await countCustomers(app.db), before);
  });

  test('entrada inválida: ValidationError com fields e nada gravado', async () => {
    const before = await countCustomers(app.db);
    await assert.rejects(
      inTx((tx) => service.findOrCreate(businessA, { name: 'A', phone: '1234', email: 'x' }, tx)),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.deepEqual(err.fields, { name: M.nameLength, phone: M.phoneInvalid, email: M.emailInvalid });
        return true;
      },
    );
    assert.equal(await countCustomers(app.db), before);
  });
});

describe('validate', () => {
  test('devolve o valor normalizado; inválido lança ValidationError', () => {
    assert.deepEqual(service.validate(validCustomer()), { name: 'Ana Souza', phone: '11912345678', email: 'ana@example.com' });
    assert.throws(() => service.validate(null), (err) => err instanceof ValidationError && Object.keys(err.fields).length === 3);
  });
});

describe('logs (critério 20)', () => {
  test('criar e reaproveitar não escrevem nome, telefone nem e-mail no log', async () => {
    const input = { name: 'Clarice Lispector', phone: '(31) 98877-6655', email: `Clarice.${seq}@Example.org` };
    await inTx((tx) => service.findOrCreate(businessA, input, tx));
    await inTx((tx) => service.findOrCreate(businessA, input, tx));
    await assert.rejects(inTx((tx) => service.findOrCreate(businessA, { ...input, phone: '31 1234' }, tx)), ValidationError);
    const text = logs().toLowerCase();
    for (const needle of ['clarice', 'lispector', '98877', '31988776655', 'example.org']) {
      assert.equal(text.includes(needle), false, needle);
    }
  });

  test('REDACT_PATHS cobre o corpo do AF-11 (customer)', async () => {
    const { REDACT_PATHS } = await import('../../src/app.js');
    assert.ok(REDACT_PATHS.includes('body.customer'));
    assert.ok(REDACT_PATHS.includes('*.customer'));
    app.log.info(
      {
        customer: { name: 'Nivel Zero' },
        body: { customer: { name: 'Nome Secreto' } },
        other: { customer: 'x@secreto.com' },
        req: { body: { customer: { phone: '31977776666' } } },
        err: { details: { body: { customer: { email: 'fundo@secreto.com' } } } },
        list: [{ customer: 'Item Secreto' }],
      },
      'teste',
    );
    for (const needle of ['Nivel Zero', 'Nome Secreto', 'x@secreto.com', '31977776666', 'fundo@secreto.com', 'Item Secreto']) {
      assert.equal(logs().includes(needle), false, needle);
    }
    assert.match(logs(), /"msg":"teste"/);
  });
});
