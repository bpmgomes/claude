// AF-12: lógica da página de gerenciar (design 4.4 e 6.1).
import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const {
  tokenFromPath,
  manageApiUrl,
  safePageUrl,
  deadlineLabel,
  summaryOf,
  loadManage,
  loadRescheduleDay,
  cancelAppointment,
  rescheduleAppointment,
  rescheduleSummary,
  slotsReadyMessage,
  professionalChoices,
  MANAGE_PAGE_MESSAGES: P,
  STATUS_TITLES,
} = await import('../../web/js/manage-controller.js');

const TOKEN = `${'a'.repeat(21)}_-${'Z9'.repeat(10)}`;
const VERSION = 'v'.repeat(43);

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

const SUMMARY_BODY = {
  appointment: {
    start: '2026-11-27T10:00',
    end: '2026-11-27T11:00',
    weekday: 5,
    timezone: 'America/Sao_Paulo',
    status: 'confirmed',
    service: { name: 'Corte', durationMinutes: 60, durationLabel: '1 h', priceCents: 5000, priceOnRequest: false, priceLabel: 'R$ 50,00' },
    professional: { name: 'Ana Souza' },
    business: {
      name: 'Salão da Ana',
      address: 'Rua A, 10',
      phoneDisplay: '(11) 91234-5678',
      phoneHref: 'tel:+5511912345678',
      pageUrl: 'https://agendafacil.app/salao-da-ana',
    },
  },
  change: {
    canChange: true,
    changeDeadline: '2026-11-27T08:00',
    cancellationLeadMinutes: 120,
    policy: 'Você pode cancelar ou remarcar por este link até 2 h antes do horário.',
    version: VERSION,
    reschedule: { allowed: true, sameProfessional: true, notice: null, today: '2026-11-26', maxDate: '2027-02-24' },
  },
};

describe('URL e token', () => {
  test('tokenFromPath lê o segundo segmento e decodifica; malformado volta cru', () => {
    assert.equal(tokenFromPath(`/agendamento/${TOKEN}`), TOKEN);
    assert.equal(tokenFromPath('/agendamento/a%2Bb'), 'a+b');
    assert.equal(tokenFromPath('/agendamento/%E0%A4%A'), '%E0%A4%A');
    assert.equal(tokenFromPath('/agendamento'), '');
    assert.equal(tokenFromPath(undefined), '');
  });

  test('manageApiUrl codifica o token', () => {
    assert.equal(manageApiUrl(TOKEN), `/api/public/manage/${TOKEN}`);
    assert.equal(manageApiUrl('a/b?c', '/cancel'), '/api/public/manage/a%2Fb%3Fc/cancel');
  });

  test('safePageUrl só aceita http(s)', () => {
    assert.equal(safePageUrl('https://agendafacil.app/x'), 'https://agendafacil.app/x');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relativo', 42, null]) assert.equal(safePageUrl(bad), null, String(bad));
  });

  test('deadlineLabel sem Date: o mesmo texto com TZ diferente; entrada ruim dá vazio', () => {
    const original = process.env.TZ;
    const seen = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        seen.push(deadlineLabel('2026-11-27T08:00'));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.equal(new Set(seen).size, 1);
    assert.match(seen[0], /^Você pode alterar até .*27\/11 às 08:00$/);
    for (const bad of [undefined, '2026-11-27', '2026-13-27T08:00', 'x'.repeat(16)]) assert.equal(deadlineLabel(bad), '');
  });
});

describe('chamadas: credentials omit e token só na URL (critério 10)', () => {
  test('loadManage, loadRescheduleDay, cancelAppointment e rescheduleAppointment', async () => {
    const f = fakeFetch(200, SUMMARY_BODY);
    await loadManage(TOKEN, { fetchFn: f });
    const day = fakeFetch(200, { timezone: 'America/Sao_Paulo', days: [{ date: '2026-11-27', weekday: 5, slots: [] }] });
    await loadRescheduleDay(TOKEN, { date: '2026-11-27', professionalId: 'same' }, { fetchFn: day });
    await loadRescheduleDay(TOKEN, { date: '2026-11-27', professionalId: 'any' }, { fetchFn: day });
    await cancelAppointment(TOKEN, { version: VERSION }, { fetchFn: f });
    await rescheduleAppointment(TOKEN, { start: '2026-11-27T10:30', professionalId: 'same', version: VERSION }, { fetchFn: f });
    await rescheduleAppointment(TOKEN, { start: '2026-11-27T10:30', professionalId: 'any', version: VERSION }, { fetchFn: f });
    const calls = [...f.calls, ...day.calls];
    for (const { url, init } of calls) {
      assert.equal(init.credentials, 'omit');
      assert.ok(url.includes(TOKEN));
      assert.equal(String(init.body ?? '').includes(TOKEN), false);
      assert.equal(JSON.stringify(init.headers).includes(TOKEN), false);
    }
    assert.equal(day.calls[0].url, `/api/public/manage/${TOKEN}/availability?date=2026-11-27`);
    assert.equal(day.calls[1].url, `/api/public/manage/${TOKEN}/availability?date=2026-11-27&professionalId=any`);
    assert.equal(f.calls[1].url, `/api/public/manage/${TOKEN}/cancel`);
    assert.deepEqual(JSON.parse(f.calls[1].init.body), { version: VERSION });
    assert.equal(f.calls[1].init.method, 'POST');
    assert.deepEqual(JSON.parse(f.calls[2].init.body), { start: '2026-11-27T10:30', version: VERSION });
    assert.deepEqual(JSON.parse(f.calls[3].init.body), { start: '2026-11-27T10:30', version: VERSION, professionalId: 'any' });
  });
});

describe('mapeamento das respostas', () => {
  test('200: resumo com título, prazo, política, versão e links conferidos', async () => {
    const res = await loadManage(TOKEN, { fetchFn: fakeFetch(200, SUMMARY_BODY) });
    assert.equal(res.ok, true);
    const s = res.summary;
    assert.equal(s.title, STATUS_TITLES.confirmed);
    assert.equal(s.canChange, true);
    assert.equal(s.version, VERSION);
    assert.equal(s.phoneHref, 'tel:+5511912345678');
    assert.equal(s.pageUrl, 'https://agendafacil.app/salao-da-ana');
    assert.match(s.deadline, /27\/11 às 08:00/);
    assert.equal(s.reschedule.allowed, true);
    const evil = structuredClone(SUMMARY_BODY);
    evil.appointment.business.pageUrl = 'javascript:alert(1)';
    evil.appointment.business.phoneHref = 'javascript:alert(1)';
    evil.appointment.status = 'cancelled';
    const bad = summaryOf(evil);
    assert.equal(bad.pageUrl, null);
    assert.notEqual(bad.phoneHref, 'javascript:alert(1)');
    assert.equal(bad.title, STATUS_TITLES.cancelled);
  });

  test('200 com corpo malformado e corpo ausente: unavailable', async () => {
    for (const body of [{}, { appointment: 'x', change: {} }, null, undefined]) {
      const res = await loadManage(TOKEN, { fetchFn: fakeFetch(200, body) });
      assert.deepEqual(res, { ok: false, kind: 'unavailable', message: P.unavailable }, JSON.stringify(body));
    }
  });

  test('400, 404, 409 (cada code), 429, 503 e rede', async () => {
    const err = (code, message, extra = {}) => ({ error: { code, message, ...extra } });
    const cases = [
      [400, err('VALIDATION_ERROR', 'Requisição inválida.', { fields: { start: 'Escolha um horário válido.' } }), { kind: 'fields', message: 'Escolha um horário válido.' }],
      [400, err('VALIDATION_ERROR', 'Requisição inválida.'), { kind: 'fields', message: P.badRequest }],
      [404, err('NOT_FOUND', 'Link inválido ou expirado.'), { kind: 'notFound', message: P.notFound }],
      [409, err('APPOINTMENT_CHANGED', 'do servidor'), { kind: 'changed', message: 'do servidor' }],
      [409, err('APPOINTMENT_NOT_CHANGEABLE', 'outro texto'), { kind: 'notChangeable', message: 'outro texto' }],
      [409, err('RESCHEDULE_LIMIT_REACHED', 'limite'), { kind: 'limit', message: 'limite' }],
      [409, err('ALGO_NOVO', '<b>x</b>'), { kind: 'unavailable', message: P.unavailable }],
      [429, err('RATE_LIMITED', 'x'), { kind: 'rateLimited', message: P.rateLimited }],
      [503, err('MANAGE_UNAVAILABLE', 'x'), { kind: 'unavailable', message: P.unavailable }],
      [500, undefined, { kind: 'unavailable', message: P.unavailable }],
    ];
    for (const [status, body, expected] of cases) {
      const res = await cancelAppointment(TOKEN, { version: VERSION }, { fetchFn: fakeFetch(status, body) });
      assert.deepEqual(res, { ok: false, ...expected }, `${status} ${JSON.stringify(body)}`);
    }
    const offline = async () => {
      throw new TypeError('offline');
    };
    assert.deepEqual(await loadManage(TOKEN, { fetchFn: offline }), { ok: false, kind: 'network', message: P.unavailable });
  });

  test('409 SLOT_UNAVAILABLE com e sem sugestões: só {start,end} válidos, até 3, com rótulo de outro dia', async () => {
    const suggestions = [
      { start: '2026-11-27T11:00', end: '2026-11-27T12:00' },
      { start: '<img>', end: '2026-11-27T12:00' },
      { start: '2026-11-27T13:00', end: '2026-11-27T14:00' },
      { start: '2026-11-30T09:00', end: '2026-11-30T10:00' },
      { start: '2026-11-30T10:00', end: '2026-11-30T11:00' },
    ];
    const res = await rescheduleAppointment(
      TOKEN,
      { start: '2026-11-27T10:30', professionalId: 'same', version: VERSION },
      { fetchFn: fakeFetch(409, { error: { code: 'SLOT_UNAVAILABLE', message: 'Este horário acabou de ser ocupado.', suggestions } }) },
    );
    assert.equal(res.kind, 'slot');
    assert.equal(res.message, 'Este horário acabou de ser ocupado.');
    assert.deepEqual(res.suggestions.map((s) => s.start), ['2026-11-27T11:00', '2026-11-27T13:00', '2026-11-30T09:00']);
    assert.equal(res.suggestions[0].dateLabel, undefined);
    assert.ok(res.suggestions[2].dateLabel);
    const none = await rescheduleAppointment(
      TOKEN,
      { start: '2026-11-27T10:30', version: VERSION },
      { fetchFn: fakeFetch(409, { error: { code: 'SLOT_UNAVAILABLE', message: 'x' } }) },
    );
    assert.deepEqual(none.suggestions, []);
  });

  test('loadRescheduleDay: rótulos HH:MM, 24:00 no fim do dia e slots inválidos descartados', async () => {
    const body = {
      timezone: 'America/Sao_Paulo',
      days: [
        {
          date: '2026-11-27',
          weekday: 5,
          slots: [
            { start: '2026-11-27T10:00', end: '2026-11-27T11:00' },
            { start: 'x', end: 'y' },
            { start: '2026-11-27T23:00', end: '2026-11-28T00:00' },
          ],
        },
      ],
    };
    const res = await loadRescheduleDay(TOKEN, { date: '2026-11-27', professionalId: 'same' }, { fetchFn: fakeFetch(200, body) });
    assert.equal(res.ok, true);
    assert.deepEqual(res.day.slots.map((s) => [s.label, s.endLabel]), [['10:00', '11:00'], ['23:00', '24:00']]);
    assert.match(rescheduleSummary(res.day.slots[0], { weekday: 5, timezone: 'America/Sao_Paulo' }), /10:00 – 11:00 \(America\/Sao_Paulo\)$/);
    assert.match(slotsReadyMessage(1, '2026-11-27', 5), /^1 horário livre em /);
    assert.match(slotsReadyMessage(2, '2026-11-27', 5), /^2 horários livres em /);
    const missing = await loadRescheduleDay(TOKEN, { date: '2026-11-28', professionalId: 'same' }, { fetchFn: fakeFetch(200, body) });
    assert.equal(missing.kind, 'unavailable');
    const controller = new AbortController();
    controller.abort();
    const aborted = await loadRescheduleDay(TOKEN, { date: '2026-11-27' }, { fetchFn: fakeFetch(200, body), signal: controller.signal });
    assert.equal(aborted.aborted, true);
  });

  test('professionalChoices: "Mesmo" só quando ainda atende; "Qualquer" sempre', () => {
    const s = summaryOf(SUMMARY_BODY);
    assert.deepEqual(professionalChoices(s).map((c) => c.value), ['same', 'any']);
    assert.match(professionalChoices(s)[0].label, /Ana Souza/);
    s.reschedule.sameProfessional = false;
    assert.deepEqual(professionalChoices(s).map((c) => c.value), ['any']);
  });
});

test('manage-*.js sem Date, localStorage, sessionStorage nem innerHTML (critérios 9 e 13)', async () => {
  for (const file of ['manage-controller.js', 'manage-page.js']) {
    const src = await readFile(fileURLToPath(new URL(`../../web/js/${file}`, import.meta.url)), 'utf8');
    for (const re of [/\bDate\b/, /localStorage/, /sessionStorage/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/]) {
      assert.doesNotMatch(src, re, `${file}: ${re}`);
    }
  }
});
