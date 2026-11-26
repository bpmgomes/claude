// AF-14 (design 5.4 e 6.1, critério 24): concorrência do cancelamento pelo dono, no padrão do AF-22 e
// do manage.concurrency.test.js: Promise.all de app.inject, rodadas que alternam a ordem de envio e
// asserção de que cada vencedor apareceu ao menos uma vez.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { agendaApp, bookReal, cancelAgenda, agendaVersionOf, spUtc, AGENDA_NOW } from '../helpers/agenda.js';
import { cancelManage, rescheduleManage, versionOf, tokenOfUrl } from '../helpers/manage.js';
import { bookingBody } from '../helpers/appointments.js';
import { createAgendaService } from '../../src/modules/agenda/agenda.service.js';

const WORKER = fileURLToPath(new URL('../helpers/booking-worker.js', import.meta.url));
const DAYS = ['2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'];
const HOURS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
const STARTS = DAYS.flatMap((d) => HOURS.map((h) => `${d}T${h}`));

let ctx;
const db = () => ctx.app.db;
const stateOf = (id) => db().get('SELECT status, cancelled_by, cancelled_at FROM appointments WHERE id = ?', [id]);
const outboxOf = (id) => db().all('SELECT kind FROM email_outbox WHERE appointment_id = ? OR previous_appointment_id = ? ORDER BY kind', [id, id]);
const nextOf = async (id) => (await db().get('SELECT appointment_id FROM appointment_reschedules WHERE previous_appointment_id = ?', [id]))?.appointment_id ?? null;
let ip = 0;
const nextIp = () => {
  ip += 1;
  return `10.3.${Math.trunc(ip / 250)}.${(ip % 250) + 1}`;
};

/** Prepara A (reservado de verdade, com link) e as versões dos dois lados. */
async function prepare(start) {
  const a = await bookReal(ctx.app, ctx, { start });
  return { ...a, ownerVersion: await agendaVersionOf(ctx.app, ctx.business.id, a.id), linkVersion: await versionOf(ctx.app, a.token) };
}
const owner = (a) => () => cancelAgenda(ctx.app, ctx.cookies, a.id, { version: a.ownerVersion, remoteAddress: nextIp() });
const customerCancel = (a) => () => cancelManage(ctx.app, a.token, { version: a.linkVersion, remoteAddress: nextIp() });
const customerReschedule = (a, start) => () => rescheduleManage(ctx.app, a.token, { start, version: a.linkVersion }, { remoteAddress: nextIp() });

// Porta determinística (F2 do QA). Todas as requisições de uma rodada saem juntas (Promise.all de
// app.inject). Os métodos `cancel`/`reschedule` dos serviços do app são embrulhados para rodar sob um
// rótulo de AsyncLocalStorage: 'owner' (agendaService.cancel; em (d), 'x' e 'y' pela ordem de chegada
// ao serviço), 'cancel' (manageService.cancel) e 'reschedule' (manageService.reschedule). O
// `db.transaction` do app (o mesmo objeto usado pelos dois serviços) também é embrulhado: a PRIMEIRA
// chamada de cada rótulo armado na rodada fica parada ANTES de abrir a transação, depois de a
// requisição ter feito tudo o que vem antes dela (sessão, negócio, validação, leituras fora de
// transação). Quando todos os rótulos chegaram, a porta abre as transações na ordem pedida, uma atrás
// da outra na fila da conexão única. Nenhuma requisição responde antes disso, então todas estão em voo
// ao mesmo tempo e leram o mesmo estado inicial. Com [owner, cancel], a transação do dono entra na fila
// primeiro e a do cliente fica na fila atrás dela, e com [cancel, owner] é o contrário: os dois ramos da
// tabela 5.4 rodam de propósito, não por sorte do agendador. Não dá para segurar DENTRO da transação:
// toda consulta da outra requisição (inclusive a leitura da sessão) entra na mesma fila e travaria o
// teste. Se um rótulo não chegar à transação em 5 s, a rodada falha em vez de travar.
const sides = new AsyncLocalStorage();
let gate = null;

let ownerLabels = ['owner'];
let ownerCalls = 0;

function installGate(app) {
  const database = app.db;
  const agenda = app.services.agendaService;
  const manage = app.services.manageService;
  app.services.agendaService = {
    ...agenda,
    cancel: (...args) => sides.run(ownerLabels[ownerCalls++ % ownerLabels.length], () => agenda.cancel(...args)),
  };
  app.services.manageService = {
    ...manage,
    cancel: (...args) => sides.run('cancel', () => manage.cancel(...args)),
    reschedule: (...args) => sides.run('reschedule', () => manage.reschedule(...args)),
  };
  const original = database.transaction.bind(database);
  database.transaction = (fn) => {
    const side = sides.getStore();
    if (!gate || !side || !Object.hasOwn(gate.waiting, side) || gate.waiting[side]) return original(fn);
    return new Promise((resolve, reject) => {
      gate.waiting[side] = { fn, resolve, reject };
      if (Object.values(gate.waiting).every(Boolean)) {
        const g = gate;
        gate = null;
        clearTimeout(g.timer);
        for (const label of g.order) {
          const w = g.waiting[label];
          original(w.fn).then(w.resolve, w.reject);
        }
      }
    });
  };
}

/**
 * Dispara `calls` ({ rótulo: () => inject }) ao mesmo tempo e abre as transações na ordem `order`
 * (o rótulo de cada chamada é o do serviço que ela atinge; em (d), a ordem de chegada ao serviço).
 * Falha (em vez de travar) se algum rótulo não chegar à transação em 5 s.
 * @returns {Promise<Record<string, object>>} respostas por rótulo
 */
async function ordered(order, calls) {
  let failed = null;
  ownerCalls = 0;
  gate = { order, waiting: Object.fromEntries(order.map((label) => [label, null])) };
  gate.timer = setTimeout(() => {
    const g = gate;
    gate = null;
    failed = `não chegaram à transação: ${order.filter((l) => !g.waiting[l]).join()}`;
    for (const label of order) if (g.waiting[label]) g.waiting[label].reject(new Error(failed));
  }, 5000);
  const labels = Object.keys(calls);
  const results = await Promise.all(labels.map((label) => calls[label]()));
  assert.equal(failed, null, failed);
  assert.equal(gate, null, 'a porta abriu com todos os rótulos');
  const out = {};
  labels.forEach((label, i) => {
    out[label] = results[i];
    assert.ok(![500, 503].includes(results[i].statusCode), results[i].body);
  });
  return out;
}

/** Invariantes de toda rodada: uma gravação, no máximo um e-mail de cancelamento, nunca A e B ativos. */
async function invariants(a) {
  const state = await stateOf(a.id);
  const next = await nextOf(a.id);
  const kinds = (await outboxOf(a.id)).map((r) => r.kind);
  const cancellations = kinds.filter((k) => k === 'appointment_cancelled' || k === 'appointment_cancelled_by_owner');
  assert.ok(cancellations.length <= 1, kinds.join());
  if (state.cancelled_by !== 'owner') assert.ok(!kinds.includes('appointment_cancelled_by_owner'), kinds.join());
  if (next) {
    assert.equal(state.status, 'cancelled');
    assert.equal(state.cancelled_by, 'reschedule', 'nunca B criado com A cancelado pelo dono');
    assert.equal((await stateOf(next)).status, 'confirmed');
  }
  const tokens = await db().all('SELECT revoked_reason FROM appointment_manage_tokens WHERE appointment_id = ?', [a.id]);
  if (state.cancelled_by === 'owner' || state.cancelled_by === 'customer') assert.ok(tokens.every((t) => t.revoked_reason === 'cancelled'));
  return { state, next, kinds };
}

describe('mesmo processo (critério 24)', () => {
  beforeEach(async () => {
    ctx = await agendaApp();
    installGate(ctx.app);
    ownerLabels = ['owner'];
  });
  afterEach(() => ctx.app.close());

  test('(a) dono × cliente cancela, 10 rodadas com a ordem forçada: o primeiro da fila vence, o outro recebe a repetição', async () => {
    const winners = { owner: 0, customer: 0 };
    for (let round = 0; round < 10; round++) {
      const a = await prepare(STARTS[round]);
      const ownerFirst = round % 2 === 0;
      const { owner: o, cancel: c } = await ordered(ownerFirst ? ['owner', 'cancel'] : ['cancel', 'owner'], {
        owner: owner(a),
        cancel: customerCancel(a),
      });
      assert.equal(o.statusCode, 200, o.body);
      assert.equal(c.statusCode, 200, c.body);
      const { state, kinds } = await invariants(a);
      winners[state.cancelled_by] += 1;
      assert.equal(state.cancelled_by, ownerFirst ? 'owner' : 'customer');
      if (ownerFirst) {
        assert.equal(o.json().outcome, 'cancelled');
        assert.ok(kinds.includes('appointment_cancelled_by_owner') && !kinds.includes('appointment_cancelled'));
      } else {
        assert.equal(o.json().outcome, 'unchanged');
        assert.equal(o.json().appointment.cancelled.by, 'customer');
        assert.ok(kinds.includes('appointment_cancelled'));
      }
    }
    assert.deepEqual(winners, { owner: 5, customer: 5 });
  });

  test('(b) dono × cliente remarca, 10 rodadas com a ordem forçada: um 200 e um 409 CHANGED; nunca remarcado para o nada', async () => {
    const winners = { owner: 0, reschedule: 0 };
    for (let round = 0; round < 10; round++) {
      const a = await prepare(STARTS[2 * round]);
      const ownerFirst = round % 2 === 0;
      const { owner: o, reschedule: r } = await ordered(ownerFirst ? ['owner', 'reschedule'] : ['reschedule', 'owner'], {
        owner: owner(a),
        reschedule: customerReschedule(a, STARTS[2 * round + 1]),
      });
      const { state, next } = await invariants(a);
      assert.equal(state.cancelled_by, ownerFirst ? 'owner' : 'reschedule');
      if (ownerFirst) {
        winners.owner += 1;
        assert.equal(o.statusCode, 200, o.body);
        assert.equal(r.statusCode, 409, r.body);
        assert.equal(r.json().error.code, 'APPOINTMENT_CHANGED');
        assert.equal(next, null);
        const atTarget = await db().get("SELECT COUNT(*) AS n FROM appointments WHERE starts_at = ? AND status <> 'cancelled'", [spUtc(STARTS[2 * round + 1])]);
        assert.equal(Number(atTarget.n), 0);
      } else {
        winners.reschedule += 1;
        assert.equal(r.statusCode, 200, r.body);
        assert.equal(o.statusCode, 409, o.body);
        assert.equal(o.json().error.code, 'APPOINTMENT_CHANGED');
        assert.ok(next);
      }
    }
    assert.deepEqual(winners, { owner: 5, reschedule: 5 });
  });

  test('(c) dono × cliente cancela × cliente remarca, 9 rodadas com as três ordens de chegada: o primeiro da fila decide', async () => {
    const orders = [
      ['owner', 'cancel', 'reschedule'],
      ['cancel', 'reschedule', 'owner'],
      ['reschedule', 'owner', 'cancel'],
    ];
    const expected = { owner: 'owner', cancel: 'customer', reschedule: 'reschedule' };
    for (let round = 0; round < 9; round++) {
      const a = await prepare(STARTS[2 * round]);
      const order = orders[round % 3];
      const res = await ordered(order, {
        owner: owner(a),
        cancel: customerCancel(a),
        reschedule: customerReschedule(a, STARTS[2 * round + 1]),
      });
      const { state } = await invariants(a);
      assert.equal(state.cancelled_by, expected[order[0]], order.join());
      assert.equal(res[order[0]].statusCode, 200, res[order[0]].body);
    }
  });

  test('(d) dono × dono com a mesma version, 10 rodadas com a ordem forçada: um cancelled e um unchanged, um e-mail', async () => {
    // Os dois lados chamam o mesmo serviço: 'x' é quem chegou primeiro ao serviço, 'y' o segundo. As
    // rodadas pares abrem a transação de 'x' primeiro e as ímpares a de 'y' (quem chegou depois).
    ownerLabels = ['x', 'y'];
    for (let round = 0; round < 10; round++) {
      const a = await prepare(STARTS[round]);
      const res = await ordered(round % 2 === 0 ? ['x', 'y'] : ['y', 'x'], { x: owner(a), y: owner(a) });
      assert.equal(res.x.statusCode, 200);
      assert.equal(res.y.statusCode, 200);
      assert.deepEqual([res.x.json().outcome, res.y.json().outcome].sort(), ['cancelled', 'unchanged']);
      assert.deepEqual(res.x.json().appointment, res.y.json().appointment);
      const { state, kinds } = await invariants(a);
      assert.equal(state.cancelled_by, 'owner');
      assert.equal(kinds.filter((k) => k === 'appointment_cancelled_by_owner').length, 1);
    }
  });

  test('changes === 1 (mutação permanente): cancelIfConfirmed que devolve 0 sem gravar não revoga nem enfileira', async () => {
    const s = ctx.app.services;
    ctx.app.services.agendaService = createAgendaService({
      db: db(),
      businessesRepository: s.businessesRepository,
      professionalsRepository: s.professionalsRepository,
      appointmentsRepository: { ...s.appointmentsRepository, cancelIfConfirmed: async () => ({ changes: 0 }) },
      timeBlocksRepository: s.timeBlocksRepository,
      customersRepository: s.customersRepository,
      manageTokensRepository: s.manageTokensRepository,
      reschedulesRepository: s.reschedulesRepository,
      emailEnabled: false,
      now: () => new Date(AGENDA_NOW),
    });
    const a = await prepare(STARTS[0]);
    const res = await owner(a)();
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'APPOINTMENT_NOT_CHANGEABLE');
    assert.equal((await stateOf(a.id)).status, 'confirmed');
    assert.deepEqual((await outboxOf(a.id)).map((r) => r.kind), ['appointment_confirmed']);
    const tokens = await db().all('SELECT revoked_at FROM appointment_manage_tokens WHERE appointment_id = ?', [a.id]);
    assert.ok(tokens.every((t) => t.revoked_at === null));
  });
});

describe('dois processos sobre o mesmo arquivo SQLite (critério 24)', () => {
  // Aqui não há porta: cada processo tem a sua conexão e o SQLite serializa as escritas por
  // BEGIN IMMEDIATE / busy_timeout. O teste só garante as INVARIANTES (nenhum 500/503, uma gravação,
  // no máximo um e-mail de cancelamento, nunca B criado com A cancelado pelo dono, respostas coerentes
  // com o estado final). Qual lado vence em cada rodada depende do agendador e NÃO é verificado.
  test('dono no processo A e cliente cancela/remarca no B, 5 rodadas: nenhum 500/503 e estados consistentes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af14-'));
    const databasePath = join(dir, 'agenda.sqlite');
    const workers = [];
    const outcomes = [];
    try {
      ctx = await agendaApp({ databasePath });
      const { business, service, pros, cookies } = ctx;
      await ctx.app.close();
      const ports = await Promise.all(
        [0, 1].map(
          () =>
            new Promise((resolve, reject) => {
              const child = fork(WORKER, [databasePath, AGENDA_NOW], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
              workers.push(child);
              child.once('message', (msg) => resolve(msg.port));
              child.once('error', reject);
              child.once('exit', (code) => reject(new Error(`worker saiu com ${code}`)));
            }),
        ),
      );
      const base = (i) => `http://127.0.0.1:${ports[i]}`;
      const post = (url, payload, extra = {}) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra },
          body: JSON.stringify(payload),
        }).then(async (res) => ({ status: res.status, body: await res.json() }));
      const cookie = { cookie: `af_session=${cookies.af_session}` };

      for (let round = 0; round < 5; round++) {
        const seed = STARTS[2 * round];
        const target = STARTS[2 * round + 1];
        const booked = await post(
          `${base(1)}/api/public/${business.slug}/appointments`,
          bookingBody({ serviceId: service.id, professionalId: pros[0].id, start: seed, customer: { name: `Proc ${round}`, phone: `1193${String(1000000 + round).padStart(7, '0')}`, email: `proc${round}@example.com` } }),
        );
        assert.equal(booked.status, 201, JSON.stringify(booked.body));
        const token = tokenOfUrl(booked.body.manage.url);
        const summary = await (await fetch(`${base(1)}/api/public/manage/${token}`)).json();
        const day = seed.slice(0, 10);
        const list = await (await fetch(`${base(0)}/api/agenda?from=${day}&to=${day}`, { headers: cookie })).json();
        const item = list.days[0].items.find((i) => i.start === seed);
        const ownerCall = () => post(`${base(0)}/api/agenda/appointments/${item.id}/cancel`, { version: item.version }, cookie);
        const customerCall =
          round % 2 === 0
            ? () => post(`${base(1)}/api/public/manage/${token}/cancel`, { version: summary.change.version })
            : () => post(`${base(1)}/api/public/manage/${token}/reschedule`, { start: target, version: summary.change.version });
        const [o, c] = round % 2 === 0 ? await Promise.all([ownerCall(), customerCall()]) : (await Promise.all([customerCall(), ownerCall()])).reverse();
        for (const r of [o, c]) assert.ok(![500, 503].includes(r.status), JSON.stringify(r));
        outcomes.push({ id: item.id, reschedule: round % 2 === 1, o, c });
      }
    } finally {
      await Promise.all(
        workers.map(
          (child) =>
            new Promise((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.removeAllListeners('exit');
              child.once('exit', resolve);
              child.send('stop');
            }),
        ),
      );
      const raw = new DatabaseSync(databasePath);
      try {
        for (const { id, o } of outcomes) {
          const a = raw.prepare('SELECT status, cancelled_by FROM appointments WHERE id = ?').get(id);
          assert.equal(a.status, 'cancelled');
          const next = raw.prepare('SELECT appointment_id FROM appointment_reschedules WHERE previous_appointment_id = ?').get(id);
          const kinds = raw.prepare('SELECT kind FROM email_outbox WHERE appointment_id = ?').all(id).map((r) => r.kind);
          assert.ok(kinds.filter((k) => k.startsWith('appointment_cancelled')).length <= 1, kinds.join());
          if (next) {
            assert.equal(a.cancelled_by, 'reschedule');
            assert.equal(o.status, 409);
            assert.equal(raw.prepare('SELECT status FROM appointments WHERE id = ?').get(next.appointment_id).status, 'confirmed');
          } else if (a.cancelled_by === 'owner') {
            assert.equal(o.body.outcome, 'cancelled');
            assert.ok(kinds.includes('appointment_cancelled_by_owner'));
          } else {
            assert.equal(a.cancelled_by, 'customer');
            assert.equal(o.body.outcome, 'unchanged');
            assert.ok(!kinds.includes('appointment_cancelled_by_owner'));
          }
        }
        assert.equal(outcomes.length, 5);
      } finally {
        raw.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
