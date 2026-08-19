/**
 * Тесты снимка месячного плана: что именно замораживается, когда месяц уже закрыт
 * и кому разрешён пересмотр.
 *
 * Формулы приказа живут в SQL (OBJECT_KPI_REPORT_SQL) и здесь не пересчитываются —
 * проверяется поведение вокруг них: перенос значений отчёта в снимок, идемпотентность
 * фиксации и гард на пересмотр.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./object-kpi-roles-cache.service.js', () => ({
  isEconomicsHead: vi.fn(),
  isEconomicsHeadLive: vi.fn(),
  invalidateObjectKpiRolesCache: vi.fn(),
}));

vi.mock('./object-kpi-history.service.js', () => ({
  recordObjectKpiHistory: vi.fn(),
  requireReasonIfMonthFixed: vi.fn(),
  requireReasonIfObjectHasFixedMonths: vi.fn(),
}));

import { isEconomicsHeadLive } from './object-kpi-roles-cache.service.js';
import { recordObjectKpiHistory } from './object-kpi-history.service.js';
import { fixMonthPlan, normalizeMonth, revisePlan } from './object-kpi-plan.service.js';
import { OBJECT_KPI_REPORT_SQL } from './object-kpi-report.service.js';

const OBJECT_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR = { userId: 'user-1', userName: 'Экономист' };

/** Строка отчёта: только те поля, которые читает снимок. */
const reportRow = (overrides: Record<string, unknown> = {}) => ({
  data_quality: 'ok',
  contract_total: '600000000.00',
  ks2_cumulative_before: '0.00',
  remainder: '600000000.00',
  planned_zos_date_used: '2026-11-30',
  control_date: '2027-02-28',
  months_remaining: 6,
  plan_amount_calc: '100000000.00',
  ...overrides,
});

/** Мини-клиент: отдаёт заготовленные ответы по порядку вызовов. */
function makeClient(responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let index = 0;
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const response = responses[index] ?? { rows: [] };
      index += 1;
      return { rows: response.rows, rowCount: response.rowCount ?? response.rows.length };
    }),
  };
  return { client, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('normalizeMonth', () => {
  it('приводит YYYY-MM и YYYY-MM-DD к первому числу', () => {
    expect(normalizeMonth('2026-09')).toBe('2026-09-01');
    expect(normalizeMonth('2026-09-17')).toBe('2026-09-01');
  });

  it('отвергает мусор', () => {
    expect(() => normalizeMonth('сентябрь')).toThrow();
  });
});

describe('fixMonthPlan', () => {
  it('замораживает семёрку величин из отчёта', async () => {
    const { client, calls } = makeClient([
      { rows: [reportRow()] },
      { rows: [{ id: 'plan-1', status: 'fixed' }] },
    ]);

    const row = await fixMonthPlan(client as never, ACTOR, OBJECT_ID, '2026-09', 'manual');

    expect(row).toEqual({ id: 'plan-1', status: 'fixed' });
    // Первый запрос — тот самый отчётный SQL, а не отдельная реализация формул.
    expect(calls[0].sql).toBe(OBJECT_KPI_REPORT_SQL);
    expect(calls[0].params).toEqual(['2026-09-01', '2026-09-01', [OBJECT_ID]]);
    // В снимок ушли значения отчёта и статус fixed.
    expect(calls[1].params).toEqual(expect.arrayContaining([
      '600000000.00', '0.00', '100000000.00', 'fixed', 'manual',
    ]));
    expect(recordObjectKpiHistory).toHaveBeenCalledTimes(1);
  });

  it('при неполных данных пишет data_incomplete и NULL вместо нуля', async () => {
    const { client, calls } = makeClient([
      { rows: [reportRow({ data_quality: 'no_planned_zos_date', plan_amount_calc: null })] },
      { rows: [{ id: 'plan-2', status: 'data_incomplete' }] },
    ]);

    await fixMonthPlan(client as never, ACTOR, OBJECT_ID, '2026-09', 'auto');

    const params = calls[1].params;
    expect(params).toContain('data_incomplete');
    // Ноль в знаменателе совокупного KPI занизил бы процент — только NULL.
    expect(params).not.toContain(0);
    expect(params).not.toContain('0.00');
  });

  it('возвращает null, если месяц уже закрыт (ON CONFLICT ... WHERE status = open)', async () => {
    const { client } = makeClient([
      { rows: [reportRow()] },
      { rows: [] },
    ]);

    const row = await fixMonthPlan(client as never, ACTOR, OBJECT_ID, '2026-09', 'auto');

    expect(row).toBeNull();
    expect(recordObjectKpiHistory).not.toHaveBeenCalled();
  });

  it('404, если объект не участвует в расчёте за месяц', async () => {
    const { client } = makeClient([{ rows: [] }]);

    await expect(fixMonthPlan(client as never, ACTOR, OBJECT_ID, '2026-09', 'auto'))
      .rejects.toMatchObject({ __save: { http: 404, code: 'month_not_applicable' } });
  });
});

describe('revisePlan', () => {
  it('без основания — 400, до любых запросов в БД', async () => {
    const { client } = makeClient([]);

    await expect(revisePlan(
      client as never, ACTOR, 42, false, OBJECT_ID, '2026-09', { reason: '   ' },
    )).rejects.toMatchObject({ __save: { http: 400, code: 'reason_required' } });

    expect(client.query).not.toHaveBeenCalled();
  });

  it('не руководителю эк.отдела — 403, даже если страница доступна', async () => {
    (isEconomicsHeadLive as Mock).mockResolvedValue(false);
    const { client } = makeClient([]);

    await expect(revisePlan(
      client as never, ACTOR, 42, false, OBJECT_ID, '2026-09', { reason: 'ошибка в договоре' },
    )).rejects.toMatchObject({ __save: { http: 403 } });
  });

  it('создаёт новую ревизию и гасит предыдущую', async () => {
    (isEconomicsHeadLive as Mock).mockResolvedValue(true);
    const { client, calls } = makeClient([
      { rows: [{ id: 'plan-1', revision: 1, status: 'fixed' }] },  // текущая ревизия FOR UPDATE
      { rows: [reportRow()] },                      // пересчёт отчёта
      { rows: [] },                                 // UPDATE ... is_current = false
      { rows: [{ id: 'plan-2', revision: 2 }] },    // INSERT новой ревизии
    ]);

    const row = await revisePlan(
      client as never, ACTOR, 42, false, OBJECT_ID, '2026-09',
      { reason: 'исправлена стоимость договора', override_plan_amount: '90000000.00' },
    );

    expect(row).toEqual({ id: 'plan-2', revision: 2 });
    expect(calls[2].sql).toContain('is_current = false');
    expect(calls[3].params).toEqual(expect.arrayContaining([
      2, '90000000.00', 'исправлена стоимость договора',
    ]));
  });

  it('открытый месяц без строки — заводится ревизия 1 со статусом open', async () => {
    (isEconomicsHeadLive as Mock).mockResolvedValue(true);
    const { client, calls } = makeClient([
      { rows: [] },                                // текущей строки нет
      { rows: [reportRow()] },                     // пересчёт отчёта
      { rows: [{ id: 'plan-1', revision: 1 }] },   // INSERT
    ]);

    await revisePlan(
      client as never, ACTOR, 42, false, OBJECT_ID, '2026-09',
      { reason: 'план согласован с заказчиком', override_plan_amount: '90000000.00' },
    );

    // Месяц НЕ закрывается: ручной становится только сумма плана.
    expect(calls[2].sql).toContain("'open'");
    expect(calls[2].sql).toContain('INSERT INTO object_kpi_month_plans');
    expect(calls[2].params).toEqual(expect.arrayContaining([
      '90000000.00', 'план согласован с заказчиком',
    ]));
    // Гашения предыдущей ревизии нет — гасить нечего.
    expect(calls.some(call => call.sql.includes('is_current = false'))).toBe(false);
  });

  it('повторная правка открытого месяца обновляет ту же строку, ревизии не растут', async () => {
    (isEconomicsHeadLive as Mock).mockResolvedValue(true);
    const { client, calls } = makeClient([
      { rows: [{ id: 'plan-1', revision: 1, status: 'open' }] },
      { rows: [reportRow()] },
      { rows: [{ id: 'plan-1', revision: 1 }] },   // UPDATE ... RETURNING
    ]);

    const row = await revisePlan(
      client as never, ACTOR, 42, false, OBJECT_ID, '2026-09',
      { reason: 'уточнение', override_plan_amount: '95000000.00' },
    );

    expect(row).toMatchObject({ revision: 1 });
    expect(calls[2].sql).toContain('UPDATE object_kpi_month_plans');
    expect(calls[2].params[0]).toBe('plan-1');
    expect(calls.some(call => call.sql.includes('INSERT INTO object_kpi_month_plans'))).toBe(false);
  });

  it('пустая сумма очищает ручной план, строка остаётся', async () => {
    (isEconomicsHeadLive as Mock).mockResolvedValue(true);
    const { client, calls } = makeClient([
      { rows: [{ id: 'plan-1', revision: 1, status: 'open' }] },
      { rows: [reportRow()] },
      { rows: [{ id: 'plan-1', revision: 1 }] },
    ]);

    await revisePlan(
      client as never, ACTOR, 42, false, OBJECT_ID, '2026-09',
      { reason: 'вернули расчётный план' },
    );

    expect(calls[2].sql).toContain('UPDATE object_kpi_month_plans');
    expect(calls[2].params).toContain(null);
  });

  it('строка data_incomplete правится на месте и переходит в open', async () => {
    (isEconomicsHeadLive as Mock).mockResolvedValue(true);
    const { client, calls } = makeClient([
      { rows: [{ id: 'plan-1', revision: 1, status: 'data_incomplete' }] },
      { rows: [reportRow()] },
      { rows: [{ id: 'plan-1', revision: 1 }] },
    ]);

    await revisePlan(
      client as never, ACTOR, 42, false, OBJECT_ID, '2026-09',
      { reason: 'план задан вручную', override_plan_amount: '80000000.00' },
    );

    // Иначе ручная сумма осталась бы невидимой: отчёт берёт её только у статуса open.
    expect(calls[2].sql).toContain("status = 'open'");
  });

  it('админ проходит без роли economics_head', async () => {
    (isEconomicsHeadLive as Mock).mockResolvedValue(false);
    const { client } = makeClient([
      { rows: [{ id: 'plan-1', revision: 1, status: 'corrected' }] },
      { rows: [reportRow()] },
      { rows: [] },
      { rows: [{ id: 'plan-2', revision: 2 }] },
    ]);

    await expect(revisePlan(
      client as never, ACTOR, 42, true, OBJECT_ID, '2026-09', { reason: 'админ-правка' },
    )).resolves.toMatchObject({ revision: 2 });

    expect(isEconomicsHeadLive).not.toHaveBeenCalled();
  });
});
