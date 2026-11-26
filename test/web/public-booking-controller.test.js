import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const {
  availabilityUrl,
  loadAvailability,
  createLatestOnly,
  professionalOptionsFor,
  readSelection,
  selectionToSearch,
  dayLabel,
  selectedSummary,
  emptyDayMessage,
  readyMessage,
  BOOKING_MESSAGES: B,
} = await import('../../web/js/public-booking-controller.js');
const { AVAILABILITY_MESSAGES: M } = await import('../../src/shared/availability.js');

const S = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';
const Q = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const SELECTION = { serviceId: S, professionalId: 'any', date: '2026-11-27' };
const BOUNDS = { today: '2026-11-26', maxDate: '2027-02-24' };

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('no body');
        return body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

const OK_BODY = {
  timezone: 'America/Sao_Paulo',
  now: '2026-11-26T09:00',
  from: '2026-11-27',
  to: '2026-11-27',
  durationMinutes: 60,
  stepMinutes: 15,
  professionals: [P, Q],
  days: [
    {
      date: '2026-11-27',
      weekday: 5,
      slots: [
        { start: '2026-11-27T09:00', end: '2026-11-27T10:00', professionals: [0, 1] },
        { start: '2026-11-27T23:00', end: '2026-11-28T00:00', professionals: [1] },
      ],
    },
  ],
  truncated: false,
};

describe('availabilityUrl', () => {
  test('codifica o slug e os parâmetros, com from = to = data', () => {
    assert.equal(
      availabilityUrl('salao-da-ana', SELECTION),
      `/api/public/salao-da-ana/availability?serviceId=${S}&professionalId=any&from=2026-11-27&to=2026-11-27`,
    );
    assert.equal(
      availabilityUrl('a/b?c', { serviceId: 'x&y', professionalId: 'p q', date: '#' }),
      '/api/public/a%2Fb%3Fc/availability?serviceId=x%26y&professionalId=p%20q&from=%23&to=%23',
    );
  });
});

describe('loadAvailability (critérios 28 e 29)', () => {
  test('200: rótulos HH:MM, ids dos profissionais, fim 24:00 no dia seguinte, fuso e agora do servidor', async () => {
    const fetchFn = fakeFetch(200, OK_BODY);
    const result = await loadAvailability('salao-da-ana', SELECTION, { fetchFn });
    assert.equal(fetchFn.calls[0].url, availabilityUrl('salao-da-ana', SELECTION));
    assert.equal(fetchFn.calls[0].init.method, 'GET');
    assert.deepEqual(result, {
      ok: true,
      day: {
        date: '2026-11-27',
        weekday: 5,
        slots: [
          { label: '09:00', endLabel: '10:00', start: '2026-11-27T09:00', end: '2026-11-27T10:00', professionalIds: [P, Q] },
          { label: '23:00', endLabel: '24:00', start: '2026-11-27T23:00', end: '2026-11-28T00:00', professionalIds: [Q] },
        ],
      },
      timezone: 'America/Sao_Paulo',
      now: '2026-11-26T09:00',
      anyEligible: true,
    });
  });

  test('200 sem elegíveis: anyEligible false', async () => {
    const body = { ...OK_BODY, professionals: [], days: [{ date: '2026-11-27', weekday: 5, slots: [] }] };
    const result = await loadAvailability('s', SELECTION, { fetchFn: fakeFetch(200, body) });
    assert.equal(result.ok, true);
    assert.equal(result.anyEligible, false);
    assert.deepEqual(result.day.slots, []);
  });

  test('400 usa a mensagem fixa do campo; 404, 429, 503, rede e corpo inválido usam as da tabela', async () => {
    const bad = { error: { code: 'VALIDATION_ERROR', message: 'x', fields: { from: M.outOfHorizon } } };
    assert.deepEqual(await loadAvailability('s', SELECTION, { fetchFn: fakeFetch(400, bad) }), {
      ok: false,
      status: 400,
      message: M.outOfHorizon,
    });
    const cases = [
      [404, { error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } }, B.notFound],
      [429, { error: { code: 'RATE_LIMITED', message: 'x' } }, B.rateLimited],
      [503, { error: { code: 'AVAILABILITY_UNAVAILABLE', message: 'x' } }, B.unavailable],
      [500, undefined, B.unavailable],
      [200, { nada: true }, B.unavailable],
    ];
    for (const [status, body, message] of cases) {
      const result = await loadAvailability('s', SELECTION, { fetchFn: fakeFetch(status, body) });
      assert.deepEqual(result, { ok: false, status, message }, String(status));
    }
    const network = await loadAvailability('s', SELECTION, {
      fetchFn: async () => {
        throw new TypeError('offline');
      },
    });
    assert.deepEqual(network, { ok: false, status: 0, message: B.unavailable });
  });

  test('repassa o signal ao fetch', async () => {
    const fetchFn = fakeFetch(200, OK_BODY);
    const controller = new AbortController();
    await loadAvailability('s', SELECTION, { fetchFn, signal: controller.signal });
    assert.equal(fetchFn.calls[0].init.signal, controller.signal);
  });
});

describe('respostas fora de ordem (critério 30)', () => {
  test('duas consultas com a segunda respondendo antes: só a segunda é aplicada e a primeira é abortada', async () => {
    const latest = createLatestOnly();
    const pending = [];
    const fetchFn = (url, init) =>
      new Promise((resolve, reject) => {
        pending.push({ url, init, resolve });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const applied = [];
    async function query(date) {
      const { token, signal } = latest.next();
      const result = await loadAvailability('s', { ...SELECTION, date }, { fetchFn, signal });
      if (latest.isCurrent(token)) applied.push(date);
      return { token, result, signal };
    }
    const first = query('2026-11-27');
    const second = query('2026-11-30');
    const body = (date) => ({ ...OK_BODY, days: [{ date, weekday: 1, slots: [] }] });
    pending[1].resolve({ ok: true, status: 200, json: async () => body('2026-11-30') });
    const secondResult = await second;
    pending[0].resolve({ ok: true, status: 200, json: async () => body('2026-11-27') });
    const firstResult = await first;
    assert.deepEqual(applied, ['2026-11-30']);
    assert.equal(firstResult.signal.aborted, true);
    assert.equal(firstResult.result.ok, false);
    assert.equal(firstResult.result.aborted, true);
    assert.equal(secondResult.result.ok, true);
    assert.equal(latest.isCurrent(firstResult.token), false);
    assert.equal(latest.isCurrent(secondResult.token), true);
  });

  test('mesmo que a resposta antiga chegue depois sem abortar, isCurrent a descarta', () => {
    const latest = createLatestOnly();
    const a = latest.next();
    const b = latest.next();
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, false);
    assert.equal(latest.isCurrent(a.token), false);
    assert.equal(latest.isCurrent(b.token), true);
  });
});

describe('seleção e textos', () => {
  test('professionalOptionsFor filtra pelo serviço e mantém any primeiro', () => {
    const options = [
      { value: P, serviceIds: [S] },
      { value: 'any', serviceIds: [] },
      { value: Q, serviceIds: ['outro'] },
    ];
    assert.deepEqual(professionalOptionsFor(options, S).map((o) => o.value), ['any', P]);
    assert.deepEqual(professionalOptionsFor(options, 'nenhum').map((o) => o.value), ['any']);
    assert.deepEqual(professionalOptionsFor(options, '').map((o) => o.value), ['any', P, Q]);
    assert.deepEqual(professionalOptionsFor([], S).map((o) => o.value), ['any']);
  });

  test('readSelection ignora UUID inválido e data fora de [today, maxDate]', () => {
    assert.deepEqual(readSelection(`?servico=${S}&profissional=${P}&data=2026-11-27`, BOUNDS), {
      serviceId: S,
      professionalId: P,
      date: '2026-11-27',
    });
    assert.deepEqual(readSelection('?servico=x&profissional=<script>&data=2026-11-25', BOUNDS), {
      serviceId: '',
      professionalId: 'any',
      date: '2026-11-26',
    });
    assert.equal(readSelection('?data=2027-02-25', BOUNDS).date, '2026-11-26');
    assert.equal(readSelection('?data=2027-02-24', BOUNDS).date, '2027-02-24');
    assert.equal(readSelection('?data=2026-02-30', BOUNDS).date, '2026-11-26');
    assert.deepEqual(readSelection('', BOUNDS), { serviceId: '', professionalId: 'any', date: '2026-11-26' });
  });

  test('selectionToSearch é o inverso de readSelection (link compartilhável)', () => {
    const selection = { serviceId: S, professionalId: P, date: '2026-11-27' };
    assert.deepEqual(readSelection(selectionToSearch(selection), BOUNDS), selection);
    assert.equal(selectionToSearch({ serviceId: S, professionalId: 'any', date: '2026-11-27' }), `?servico=${S}&data=2026-11-27`);
    assert.equal(selectionToSearch({ serviceId: '', professionalId: 'any', date: '' }), '');
  });

  test('dayLabel, selectedSummary e readyMessage por manipulação de string', () => {
    assert.equal(dayLabel('2026-11-27', 5), 'sex, 27/11');
    assert.equal(dayLabel('2026-11-29', 7), 'dom, 29/11');
    assert.equal(dayLabel('2026-11-28', 6), 'sáb, 28/11');
    assert.equal(
      selectedSummary({ start: '2026-11-27T09:00', end: '2026-11-27T10:00' }, { serviceName: 'Corte', timezone: 'America/Sao_Paulo', weekday: 5 }),
      'Corte · sex, 27/11 · 09:00 – 10:00 (America/Sao_Paulo)',
    );
    assert.equal(
      selectedSummary({ start: '2026-11-27T22:00', end: '2026-11-28T00:00' }, { serviceName: 'Corte', timezone: 'UTC', weekday: 5 }),
      'Corte · sex, 27/11 · 22:00 – 24:00 (UTC)',
    );
    assert.equal(readyMessage(1, '2026-11-27', 5), '1 horário livre em sex, 27/11.');
    assert.equal(readyMessage(3, '2026-11-27', 5), '3 horários livres em sex, 27/11.');
  });

  test('emptyDayMessage nos três casos (critério 29)', () => {
    assert.equal(emptyDayMessage({ any: false, anyEligible: true }), 'Não há horários livres neste dia. Escolha outra data ou outro profissional.');
    assert.equal(emptyDayMessage({ any: true, anyEligible: true }), 'Não há horários livres neste dia. Escolha outra data.');
    assert.equal(emptyDayMessage({ any: true, anyEligible: false }), B.noneOnline);
    assert.equal(B.noneOnline, 'Nenhum profissional atende este serviço pela internet agora. Ligue para o telefone acima.');
    assert.equal(B.loading, 'Carregando horários…');
    assert.equal(Object.isFrozen(B), true);
  });
});

describe('sem relógio do navegador (critérios 12 e 18)', () => {
  test('public-booking-controller.js e public-booking-page.js não usam Date', async () => {
    for (const file of ['public-booking-controller.js', 'public-booking-page.js']) {
      const src = await readFile(fileURLToPath(new URL(`../../web/js/${file}`, import.meta.url)), 'utf8');
      assert.doesNotMatch(src, /\bDate\b/, file);
      assert.doesNotMatch(src, /getTimezoneOffset|Intl\./, file);
    }
  });

  test('a página só escreve texto via textContent (sem innerHTML)', async () => {
    const src = await readFile(fileURLToPath(new URL('../../web/js/public-booking-page.js', import.meta.url)), 'utf8');
    assert.match(src, /textContent/);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
