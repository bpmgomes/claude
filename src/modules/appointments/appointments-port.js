import { createHash } from 'node:crypto';
import { instantToLocal } from '../../shared/zoned-time.js';
import { OUTSIDE_HOURS_SCAN_MAX } from '../../shared/working-hours.js';
import { dayFrameOf, workWindowsForDay } from '../availability/availability-engine.js';

/**
 * Porta para os agendamentos. O AF-11 implementa a porta com o repositório real neste
 * módulo (src/modules/appointments/) e passa a instância em `buildApp`.
 *
 * - AF-06 (decisão 1): ao desativar um serviço, a resposta informa quantos agendamentos
 *   futuros continuam marcados (`countFutureByService`).
 * - AF-07 (critérios 17 e 19): a remoção de um profissional é bloqueada se houver
 *   agendamentos futuros (`countFutureByProfessional`).
 * - AF-08 (critério 20, decisão 4): ao gravar a grade de horários, a resposta informa quantos
 *   agendamentos futuros ficaram fora do novo expediente (`countFutureOutsideHours`). Só avisa,
 *   nunca cancela nem bloqueia.
 *
 * Todos os métodos aceitam `conn` opcional (padrão: o `db` global do repositório). Dentro de uma
 * transação, passe SEMPRE a `tx` (no SQLite, o adapter enfileira e a chamada com o `db` global
 * travaria esperando a própria transação).
 *
 * @typedef {import('../../db/index.js').Database} Database
 * @typedef {{
 *   countFutureByService(businessId: string, serviceId: string, nowIso: string, conn?: Database): Promise<number>,
 *   countFutureByProfessional(businessId: string, professionalId: string, nowIso: string,
 *                             conn: Database): Promise<number>,
 *   countFutureOutsideHours(businessId: string, professionalId: string, nowIso: string, conn?: Database): Promise<number>,
 *   findConflictsForBlock(businessId: string,
 *                         block: { professionalId: string|null, startsAt: string, endsAt: string },
 *                         limit: number,
 *                         conn: Database)
 *     : Promise<{ total: number,
 *                 items: Array<{ id: string, startsAt: string, endsAt: string, serviceName: string,
 *                                professionalId: string, professionalName: string, customerName: string }>,
 *                 versionKey: string }>,
 *   findBusyByBusiness(businessId: string,
 *                      filter: { professionalId: string|null },
 *                      fromIso: string, toIso: string, conn?: Database)
 *     : Promise<Map<string, Array<{ startsAt: string, endsAt: string }>>>,
 * }} AppointmentsPort
 *
 * countFutureByProfessional roda DENTRO da transação de remoção: deve usar só `conn`, nunca o
 * `db` global (no SQLite, o adapter enfileira e a chamada travaria esperando a própria transação).
 * Futuro = não cancelado e com início > nowIso (critério 17).
 *
 * countFutureOutsideHours é chamado DEPOIS do commit da grade, com o `db` global (sem `conn`), como
 * countFutureByService. Futuro = não cancelado, início > nowIso e fora da grade ATUAL do profissional
 * (lida pelo AF-11 com workingHoursRepository.findWeeklyByBusiness, ou findWeekly com no máximo
FIND_WEEKLY_IDS_MAX ids, e convertida no fuso do negócio).
 *
 * findConflictsForBlock (AF-16, critérios 9 a 11) roda DENTRO da transação de criação do bloqueio:
 * usa só `conn`, como countFutureByProfessional. Conflito = não cancelado E starts_at < block.endsAt
 * E ends_at > block.startsAt (intersecção, inclusive o atendimento em andamento), do profissional
 * (ou de todos os ativos, se professionalId for null). `items` vem ordenado por starts_at, id, com
 * até `limit` itens; `total` é o total real. `versionKey` é opaco e muda sempre que o CONJUNTO muda
 * (sugestão para o AF-11: sha256 dos ids ordenados, ou COUNT + MAX(updated_at)).
 * `items[].customerName` é o `customer_name` do snapshot do agendamento (AF-04, design 4.5), nunca
 * `customers.name`: o registro do cliente guarda os dados do primeiro agendamento e não é sobrescrito.
 *
 * findBusyByBusiness (AF-10, design 4.3) alimenta o cálculo de horários disponíveis. Ocupado = NÃO
 * cancelado E starts_at < toIso E ends_at > fromIso (intersecção semiaberta), de profissional ativo
 * (JOIN professionals removed_at IS NULL). `filter.professionalId` null = todos os ativos do negócio.
 * Uma consulta por business_id, sem IN (...) (critério 23), com o índice
 * appointments(business_id, starts_at) do AF-11. Instantes UTC ISO de 24 caracteres, como
 * time_blocks. A disponibilidade chama FORA de transação, com o `db` global; a reserva do AF-11
 * chama DENTRO da transação, com a `tx`. Período de até 32 dias. Profissional
 * sem ocupado não aparece no Map: use `map.get(id) ?? []`. Se lançar, a disponibilidade responde
 * 503 AVAILABILITY_UNAVAILABLE (nunca lista otimista).
 */

/**
 * Implementação nula: nunca há agendamentos. Desde o AF-11, `buildApp` usa a porta real
 * (`createAppointmentsPort`); esta fica para os testes que simulam a porta.
 * @type {AppointmentsPort}
 */
export const noAppointments = Object.freeze({
  countFutureByService: async () => 0,
  countFutureByProfessional: async () => 0,
  countFutureOutsideHours: async () => 0,
  findConflictsForBlock: async () => ({ total: 0, items: [], versionKey: '' }),
  findBusyByBusiness: async () => new Map(),
});

/** `versionKey` do conjunto de conflitos: 43 caracteres base64url (sha256 de id|updated_at por id). */
export function conflictsVersionKey(rows) {
  const text = (Array.isArray(rows) ? rows : []).map((r) => `${r.id}|${r.updated_at}`).join('\n');
  return createHash('sha256').update(text).digest('base64url');
}

/**
 * Implementação real da porta (AF-11, critérios 31 a 37). Delega ao repositório e, em
 * countFutureOutsideHours, ao motor do AF-10 para converter a grade em instantes.
 * @param {{
 *   appointmentsRepository: ReturnType<typeof import('./appointments.repository.js').createAppointmentsRepository>,
 *   workingHoursRepository: ReturnType<typeof import('../working-hours/working-hours.repository.js').createWorkingHoursRepository>,
 * }} deps
 * @returns {AppointmentsPort}
 */
export function createAppointmentsPort({ appointmentsRepository, workingHoursRepository }) {
  const repo = appointmentsRepository;
  return Object.freeze({
    countFutureByService(businessId, serviceId, nowIso, conn) {
      return repo.countFutureByService(businessId, serviceId, nowIso, conn);
    },

    countFutureByProfessional(businessId, professionalId, nowIso, conn) {
      return repo.countFutureByProfessional(businessId, professionalId, nowIso, conn);
    },

    /**
     * Futuros não cancelados fora da grade ATUAL (design 5.5). Varre no máximo
     * OUTSIDE_HOURS_SCAN_MAX agendamentos; nesse teto, o número é um limite inferior. Só avisa.
     */
    async countFutureOutsideHours(businessId, professionalId, nowIso, conn) {
      const { rows, timezone } = await repo.findFutureByProfessional(
        businessId,
        professionalId,
        nowIso,
        OUTSIDE_HOURS_SCAN_MAX,
        conn,
      );
      if (rows.length === 0) return 0;
      const weekly = await workingHoursRepository.findByProfessional(businessId, professionalId, conn);
      const windowsByDate = new Map();
      let outside = 0;
      for (const row of rows) {
        const startMs = Date.parse(row.startsAt);
        const endMs = Date.parse(row.endsAt);
        const date = instantToLocal(startMs, timezone).slice(0, 10);
        let windows = windowsByDate.get(date);
        if (!windows) {
          windows = workWindowsForDay(weekly, date, timezone, dayFrameOf(date, timezone));
          windowsByDate.set(date, windows);
        }
        if (!windows.some((w) => w.startMs <= startMs && endMs <= w.endMs)) outside += 1;
      }
      return outside;
    },

    async findConflictsForBlock(businessId, block, limit, conn) {
      const [total, items, rows] = [
        await repo.countConflicts(businessId, block, conn),
        await repo.listConflicts(businessId, block, limit, conn),
        await repo.conflictVersionRows(businessId, block, conn),
      ];
      return { total, items, versionKey: conflictsVersionKey(rows) };
    },

    async findBusyByBusiness(businessId, { professionalId = null } = {}, fromIso, toIso, conn) {
      const rows = await repo.findBusy(businessId, professionalId ?? null, fromIso, toIso, conn);
      const map = new Map();
      for (const row of rows) {
        if (!map.has(row.professionalId)) map.set(row.professionalId, []);
        map.get(row.professionalId).push({ startsAt: row.startsAt, endsAt: row.endsAt });
      }
      return map;
    },
  });
}
