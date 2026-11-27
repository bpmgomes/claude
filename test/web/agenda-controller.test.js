// AF-14 (design 4.4 e 6.1): lógica da tela da agenda, sem DOM. Roda também com TZ=Asia/Tokyo: nada aqui
// depende do relógio nem do fuso do processo.
import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const {
  parseAgendaUrl,
  buildAgendaUrl,
  rangeOf,
  shift,
  titleOf,
  dayHeading,
  hiddenLabel,
  describeItem,
  cancelQuestion,
  cancelResultMessage,
  chainLabels,
  cancelledLabel,
  safeTelHref,
  detailWhen,
  localLabel,
  failureOf,
  loadAgenda,
  loadAppointment,
  cancelAppointment,
  AGENDA_PAGE_MESSAGES: PM,
  ALL_PROFESSIONALS_LABEL,
} = await import('../../web/js/agenda-controller.js');
const { AGENDA_STATUS_DISPLAY, CANCELLED_BY_LABELS } = await import('../../src/shared/agenda.js');
const { GENERIC_ERROR_MESSAGE } = await import('../../web/js/api.js');

const P = '0f8fad5b-d9cb-469f-a165-70867728950e';
const A = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';
const V = 'a'.repeat(43);

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined });
    if (status === 0) throw new TypeError('Failed to fetch');
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

const appt = (over = {}) => ({
  type: 'appointment',
  id: A,
  version: V,
  start: '2026-11-26T10:00',
  end: '2026-11-26T11:00',
  status: 'confirmed',
  customerName: 'Bia',
  serviceName: 'Corte',
  professional: { id: P, name: 'Ana Souza', removed: false },
  cancelled: null,
  ...over,
});

describe('URL (critério 33)', () => {
  test('parseAgendaUrl: só view, date e professional válidos', () => {
    assert.deepEqual(parseAgendaUrl(''), { view: 'day', date: null, professional: null });
    assert.deepEqual(parseAgendaUrl(`?view=week&date=2026-11-26&professional=${P}`), { view: 'week', date: '2026-11-26', professional: P });
    assert.deepEqual(parseAgendaUrl('?view=month&date=2026-02-30&professional=x'), { view: 'day', date: null, professional: null });
    assert.deepEqual(parseAgendaUrl(`?date=2026-13-01&professional=${P.toUpperCase()}x`), { view: 'day', date: null, professional: null });
    assert.deepEqual(parseAgendaUrl(undefined), { view: 'day', date: null, professional: null });
    assert.deepEqual(parseAgendaUrl(`?professional=${'a'.repeat(5000)}`).professional, null);
  });

  test('buildAgendaUrl: só as três chaves; nunca nome, e-mail ou id de agendamento', () => {
    assert.equal(buildAgendaUrl({ view: 'week', date: '2026-11-26', professional: P }), `?view=week&date=2026-11-26&professional=${P}`);
    assert.equal(buildAgendaUrl({ view: 'day', date: null, professional: null }), '?view=day');
    const url = buildAgendaUrl({ view: 'x', date: 'bad', professional: 'bia@example.com', name: 'Bia', email: 'bia@example.com', appointmentId: A, includeCancelled: true });
    assert.equal(url, '?view=day');
    assert.ok(!url.includes('Bia') && !url.includes('@') && !url.includes('includeCancelled'));
    assert.equal(buildAgendaUrl(undefined), '?view=day');
    // Ida e volta.
    const state = { view: 'week', date: '2026-12-31', professional: P };
    assert.deepEqual(parseAgendaUrl(buildAgendaUrl(state)), state);
  });
});

describe('período e títulos', () => {
  test('rangeOf: dia e semana de segunda a domingo, virando mês e ano', () => {
    assert.deepEqual(rangeOf('day', '2026-11-26'), { from: '2026-11-26', to: '2026-11-26' });
    assert.deepEqual(rangeOf('week', '2026-11-26'), { from: '2026-11-23', to: '2026-11-29' });
    assert.deepEqual(rangeOf('week', '2026-11-23'), { from: '2026-11-23', to: '2026-11-29' });
    assert.deepEqual(rangeOf('week', '2026-11-29'), { from: '2026-11-23', to: '2026-11-29' });
    assert.deepEqual(rangeOf('week', '2026-12-01'), { from: '2026-11-30', to: '2026-12-06' });
    assert.deepEqual(rangeOf('week', '2027-01-01'), { from: '2026-12-28', to: '2027-01-03' });
  });

  test('shift: ± 1 dia ou ± 7 dias', () => {
    assert.equal(shift('day', '2026-11-30', 1), '2026-12-01');
    assert.equal(shift('day', '2026-01-01', -1), '2025-12-31');
    assert.equal(shift('week', '2026-12-28', 1), '2027-01-04');
    assert.equal(shift('week', '2026-11-26', -1), '2026-11-19');
  });

  test('titleOf e dayHeading', () => {
    assert.equal(titleOf('week', '2026-11-23', '2026-11-29'), 'Semana de 23/11 a 29/11');
    assert.equal(titleOf('day', '2026-11-26', '2026-11-26'), 'quinta-feira, 26/11/2026');
    assert.equal(titleOf('day', '2026-11-29', '2026-11-29'), 'domingo, 29/11/2026');
    assert.equal(dayHeading({ date: '2026-11-26', counts: { active: 6 } }), 'quinta-feira, 26/11 · 6 agendamentos');
    assert.equal(dayHeading({ date: '2026-11-23', counts: { active: 1 } }), 'segunda-feira, 23/11 · 1 agendamento');
    assert.equal(dayHeading({ date: '2026-11-28', counts: { active: 0 } }), 'sábado, 28/11 · nenhum agendamento');
  });

  test('hiddenLabel: 0, 1 e plural', () => {
    assert.equal(hiddenLabel({ active: 3, cancelled: 0, rescheduled: 0 }), '');
    assert.equal(hiddenLabel(undefined), '');
    assert.equal(hiddenLabel({ cancelled: 1, rescheduled: 0 }), '1 cancelado oculto');
    assert.equal(hiddenLabel({ cancelled: 0, rescheduled: 1 }), '1 remarcado oculto');
    assert.equal(hiddenLabel({ cancelled: 2, rescheduled: 1 }), '2 cancelados e 1 remarcado ocultos');
    assert.equal(hiddenLabel({ cancelled: 1, rescheduled: 3 }), '1 cancelado e 3 remarcados ocultos');
  });
});

describe('describeItem (critérios 31 e 36)', () => {
  test('cada chave do mapa: rótulo, ícone e classe do mapa', () => {
    const cases = [
      [appt(), 'confirmed'],
      [appt({ status: 'completed' }), 'completed'],
      [appt({ status: 'no_show' }), 'no_show'],
      [appt({ status: 'cancelled', cancelled: { by: 'owner', at: '2026-11-25T18:40' } }), 'cancelled'],
      [appt({ status: 'cancelled', cancelled: { by: 'reschedule', at: '2026-11-25T18:40' } }), 'rescheduled'],
      [{ type: 'block', id: A, start: '2026-11-26T14:00', end: '2026-11-26T18:00', allDay: false, professional: null, reason: null }, 'block'],
      [appt({ status: '<img src=x>', className: 'evil' }), 'unknown'],
    ];
    for (const [item, key] of cases) {
      const d = describeItem(item, { date: '2026-11-26' });
      assert.equal(d.key, key);
      assert.equal(d.statusLabel, AGENDA_STATUS_DISPLAY[key].label);
      assert.equal(d.icon, AGENDA_STATUS_DISPLAY[key].icon);
      assert.equal(d.className, AGENDA_STATUS_DISPLAY[key].className);
      assert.match(d.className, /^ag-status-[a-z-]+$/);
    }
    // Todos os rótulos e ícones distintos (cor não é o único sinal).
    const keys = Object.keys(AGENDA_STATUS_DISPLAY);
    assert.equal(new Set(keys.map((k) => AGENDA_STATUS_DISPLAY[k].label)).size, keys.length);
    assert.equal(new Set(keys.map((k) => AGENDA_STATUS_DISPLAY[k].icon)).size, keys.length);
  });

  test('agendamento: horário, serviço, cliente, profissional; com e sem "Todos"', () => {
    const d = describeItem(appt(), { date: '2026-11-26' });
    assert.deepEqual(
      { timeLabel: d.timeLabel, primary: d.primary, secondary: d.secondary, professional: d.professional, struck: d.struck, origin: d.origin },
      { timeLabel: '10:00 às 11:00', primary: 'Corte', secondary: 'Bia', professional: 'Ana Souza', struck: false, origin: '' },
    );
    assert.equal(describeItem(appt(), { date: '2026-11-26', showProfessional: false }).professional, '');
  });

  test('removido ganha " (removido)"; fim em outro dia: "até 27/11 00:30"', () => {
    assert.equal(describeItem(appt({ professional: { id: P, name: 'Ana', removed: true } })).professional, 'Ana (removido)');
    const late = describeItem(appt({ start: '2026-11-26T23:30', end: '2026-11-27T00:30' }), { date: '2026-11-26' });
    assert.equal(late.timeLabel, '23:30 até 27/11 00:30');
  });

  test('cancelado e remarcado: riscados e com a origem', () => {
    for (const [by, key] of [['customer', 'cancelled'], ['owner', 'cancelled'], ['reschedule', 'rescheduled']]) {
      const d = describeItem(appt({ status: 'cancelled', cancelled: { by, at: '2026-11-25T18:40' } }));
      assert.equal(d.key, key);
      assert.equal(d.struck, true);
      assert.equal(d.origin, key === 'cancelled' ? CANCELLED_BY_LABELS[by] : '');
    }
    const legacy = describeItem(appt({ status: 'cancelled', cancelled: { by: null, at: null } }));
    assert.equal(legacy.origin, '');
    const weird = describeItem(appt({ status: 'cancelled', cancelled: { by: '__proto__', at: null } }));
    assert.equal(weird.origin, '');
  });

  test('bloqueio: "todos", do profissional, motivo e dia inteiro em vários dias', () => {
    const all = describeItem(
      { type: 'block', id: A, start: '2026-11-25T00:00', end: '2026-11-28T00:00', allDay: true, professional: null, reason: { kind: 'holiday', note: 'Feriado local' } },
      { date: '2026-11-26' },
    );
    assert.equal(all.timeLabel, 'Dia inteiro');
    assert.equal(all.primary, ALL_PROFESSIONALS_LABEL);
    assert.ok(all.secondary.endsWith('Feriado local'));
    assert.equal(all.struck, false);
    const pro = describeItem(
      { type: 'block', id: A, start: '2026-11-25T14:00', end: '2026-11-26T12:00', allDay: false, professional: { id: P, name: 'Ana' }, reason: { kind: 'weird', note: null } },
      { date: '2026-11-26' },
    );
    assert.equal(pro.timeLabel, '25/11 14:00 até 12:00');
    assert.equal(pro.primary, 'Ana');
    assert.equal(pro.secondary, '');
  });

  test('nunca lança com entrada estranha', () => {
    for (const item of [null, undefined, {}, [], 'x', { type: 'block' }, { status: 'confirmed' }]) {
      const d = describeItem(item);
      assert.equal(typeof d.className, 'string');
    }
  });
});

describe('textos do detalhe e do cancelamento (critério 39)', () => {
  const detail = {
    emailEnabled: true,
    appointment: {
      start: '2026-11-27T10:00',
      customer: { name: 'Bia' },
      cancelled: null,
      rescheduledFrom: { start: '2026-11-26T15:00' },
      rescheduledTo: null,
    },
  };

  test('cancelQuestion com e sem e-mail', () => {
    assert.equal(cancelQuestion(detail, true), 'Cancelar o agendamento de Bia em 27/11 às 10:00? O cliente será avisado por e-mail.');
    assert.equal(cancelQuestion(detail, false), 'Cancelar o agendamento de Bia em 27/11 às 10:00? O e-mail está desativado: avise o cliente por telefone.');
  });

  test('cancelResultMessage: cancelado (com e sem e-mail) e repetição', () => {
    assert.equal(cancelResultMessage('cancelled', true), 'Agendamento cancelado. O aviso ao cliente será enviado por e-mail.');
    assert.equal(cancelResultMessage('cancelled', false), 'Agendamento cancelado. O cliente não será avisado por e-mail. Avise por telefone.');
    assert.equal(cancelResultMessage('unchanged', true), 'Este agendamento já estava cancelado.');
    assert.equal(cancelResultMessage('unchanged', false), PM.alreadyCancelled);
  });

  test('chainLabels e cancelledLabel', () => {
    assert.deepEqual(chainLabels(detail), ['Remarcado de 26/11 15:00']);
    assert.deepEqual(chainLabels({ appointment: { rescheduledFrom: null, rescheduledTo: { start: '2026-11-27T11:00' } } }), ['Remarcado para 27/11 11:00']);
    assert.deepEqual(chainLabels(null), []);
    assert.equal(cancelledLabel(detail), '');
    assert.equal(cancelledLabel({ appointment: { cancelled: { by: 'owner', at: '2026-11-25T18:40' } } }), 'Cancelado pelo estabelecimento em 25/11 às 18:40');
    assert.equal(cancelledLabel({ appointment: { cancelled: { by: null, at: null } } }), 'Cancelado');
  });

  test('detailWhen e localLabel', () => {
    assert.equal(detailWhen({ appointment: { start: '2026-11-27T10:00', end: '2026-11-27T11:00' } }), 'sexta-feira, 27/11/2026, 10:00 às 11:00');
    assert.equal(detailWhen({ appointment: { start: '2026-11-27T23:30', end: '2026-11-28T00:30' } }), 'sexta-feira, 27/11/2026, 23:30 até 28/11 00:30');
    assert.equal(localLabel('2026-11-20T14:12'), '20/11/2026 14:12');
    assert.equal(localLabel('2026-11-20T14:12:00.000Z'), '');
    assert.equal(localLabel(null), '');
  });

  test('safeTelHref: só tel:+55 com 10 ou 11 dígitos', () => {
    assert.equal(safeTelHref('tel:+5511912345678'), 'tel:+5511912345678');
    assert.equal(safeTelHref('tel:+551133334444'), 'tel:+551133334444');
    for (const bad of ['javascript:alert(1)', 'tel:+55119123456789', 'tel:+5511', 'tel:+1 555', ' tel:+5511912345678', null, 42]) {
      assert.equal(safeTelHref(bad), null, String(bad));
    }
  });
});

describe('falhas da API', () => {
  const err = (code, message = 'Mensagem do servidor', extra = {}) => ({ error: { code, message, ...extra } });
  const cases = [
    [400, err('VALIDATION_ERROR', 'Verifique os campos destacados.', { fields: { from: 'Data inválida.', x: 1 } }), 'fields', undefined],
    [401, err('UNAUTHENTICATED'), 'unauthenticated', '/login'],
    [404, err('APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.'), 'notFound', undefined],
    [409, err('APPOINTMENT_CHANGED', 'Mudou.'), 'changed', undefined],
    [409, err('APPOINTMENT_NOT_CHANGEABLE', 'Não pode.'), 'notChangeable', undefined],
    [409, err('BUSINESS_REQUIRED'), 'businessRequired', '/onboarding'],
    [429, err('RATE_LIMITED', 'Muitas tentativas.'), 'rateLimited', undefined],
    [503, err('AGENDA_UNAVAILABLE', 'Não foi possível carregar a agenda agora.'), 'unavailable', undefined],
  ];

  test('kind e redirectTo por status e código', () => {
    for (const [status, body, kind, redirectTo] of cases) {
      const f = failureOf({ ok: false, status, error: body.error });
      assert.equal(f.kind, kind, `${status} ${body.error.code}`);
      assert.equal(f.redirectTo, redirectTo);
      assert.equal(f.ok, false);
    }
    const fields = failureOf({ ok: false, status: 400, error: cases[0][1].error });
    assert.deepEqual(fields.fields, { from: 'Data inválida.' });
  });

  test('código inesperado: mensagem do servidor ignorada', () => {
    const f = failureOf({ ok: false, status: 500, error: { code: 'INTERNAL', message: '<script>x</script>' } });
    assert.equal(f.kind, 'unavailable');
    assert.equal(f.message, GENERIC_ERROR_MESSAGE);
    assert.equal(failureOf({ ok: false, status: 418 }).message, GENERIC_ERROR_MESSAGE);
  });

  test('loadAgenda: rede, sucesso, query e falhas', async () => {
    const network = await loadAgenda({}, { fetchFn: fakeFetch(0) });
    assert.equal(network.kind, 'network');
    const ok = fakeFetch(200, { days: [], now: '2026-11-26T09:00' });
    assert.equal((await loadAgenda({}, { fetchFn: ok })).ok, true);
    assert.equal(ok.calls[0].url, '/api/agenda');
    const q = fakeFetch(200, { days: [] });
    await loadAgenda({ from: '2026-11-23', to: '2026-11-29', professionalId: P, includeCancelled: true }, { fetchFn: q });
    assert.equal(q.calls[0].url, `/api/agenda?from=2026-11-23&to=2026-11-29&professionalId=${P}&includeCancelled=true`);
    const noCancelled = fakeFetch(200, { days: [] });
    await loadAgenda({ from: '2026-11-23', to: '2026-11-29', includeCancelled: false }, { fetchFn: noCancelled });
    assert.equal(noCancelled.calls[0].url, '/api/agenda?from=2026-11-23&to=2026-11-29');
    for (const [status, body, kind] of cases) {
      assert.equal((await loadAgenda({}, { fetchFn: fakeFetch(status, body) })).kind, kind);
    }
    assert.equal((await loadAgenda({}, { fetchFn: fakeFetch(200, { nope: true }) })).ok, false);
  });

  test('loadAppointment e cancelAppointment: id fora do formato não chama o servidor', async () => {
    const f = fakeFetch(200, {});
    for (const bad of ['x', `${A}x`, '../agenda', null]) {
      assert.equal((await loadAppointment(bad, { fetchFn: f })).kind, 'notFound');
      assert.equal((await cancelAppointment(bad, { version: V }, { fetchFn: f })).kind, 'notFound');
    }
    assert.equal(f.calls.length, 0);

    const detail = fakeFetch(200, { appointment: { id: A } });
    assert.equal((await loadAppointment(A, { fetchFn: detail })).ok, true);
    assert.equal(detail.calls[0].url, `/api/agenda/appointments/${A}`);

    const cancel = fakeFetch(200, { outcome: 'unchanged', appointment: { id: A } });
    const res = await cancelAppointment(A, { version: V }, { fetchFn: cancel });
    assert.deepEqual([res.ok, res.outcome], [true, 'unchanged']);
    assert.equal(cancel.calls[0].url, `/api/agenda/appointments/${A}/cancel`);
    assert.equal(cancel.calls[0].init.method, 'POST');
    assert.deepEqual(cancel.calls[0].body, { version: V });

    for (const [status, body, kind] of cases) {
      assert.equal((await cancelAppointment(A, { version: V }, { fetchFn: fakeFetch(status, body) })).kind, kind);
      assert.equal((await loadAppointment(A, { fetchFn: fakeFetch(status, body) })).kind, kind);
    }
  });
});

test('varredura de agenda-controller.js e agenda-page.js (critérios 31, 33 e 35)', async () => {
  const forbidden = [
    'innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write', 'eval(', 'new Function', 'localStorage',
    'sessionStorage', 'new Date', 'Date.now', 'getTimezoneOffset', 'style=', '.style.', 'Intl.', 'mailto:',
  ];
  for (const file of ['agenda-controller.js', 'agenda-page.js']) {
    const src = await readFile(fileURLToPath(new URL(`../../web/js/${file}`, import.meta.url)), 'utf8');
    for (const word of forbidden) assert.ok(!src.includes(word), `${file}: ${word}`);
  }
});
