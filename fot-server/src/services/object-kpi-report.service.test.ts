/**
 * Сводка по руководителю (п. 3.5): Σfact / Σplan, а НЕ среднее процентов по месяцам.
 * Разница на реальных данных доходит до десятков процентных пунктов, поэтому кейс
 * зафиксирован тестом, а не комментарием.
 *
 * Рядом — окно авто-периода: приоритет источников начала расчёта и оба клампа.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { queryOne } from '../config/postgres.js';
import {
  resolveCalcWindow,
  summarizeCompletion,
  OBJECT_KPI_MAX_AUTO_MONTHS,
  type ObjectKpiReportRow,
} from './object-kpi-report.service.js';

const row = (plan: string | null, fact: string): ObjectKpiReportRow =>
  ({ plan_amount: plan, fact_amount: fact } as ObjectKpiReportRow);

describe('summarizeCompletion', () => {
  it('считает отношение сумм, а не среднее процентов', () => {
    // По месяцам: 100 % и 10 %. Среднее дало бы 55 %, отношение сумм — 19 %.
    const result = summarizeCompletion([
      row('1000000.00', '1000000.00'),
      row('9000000.00', '900000.00'),
    ]);

    expect(result.total_plan).toBe(10_000_000);
    expect(result.total_fact).toBe(1_900_000);
    expect(result.completion_pct).toBe(19);
  });

  it('строки data_incomplete не участвуют ни в одной из сумм', () => {
    // План NULL — данных за месяц не было. Подстановка нуля занизила бы процент.
    const result = summarizeCompletion([
      row('1000000.00', '1000000.00'),
      row(null, '500000.00'),
    ]);

    expect(result.total_plan).toBe(1_000_000);
    expect(result.total_fact).toBe(1_000_000);
    expect(result.completion_pct).toBe(100);
  });

  it('нулевой суммарный план → процент не считается', () => {
    // Полностью закрытый объект не должен выглядеть провалившим KPI.
    expect(summarizeCompletion([row('0.00', '0.00')]).completion_pct).toBeNull();
    expect(summarizeCompletion([]).completion_pct).toBeNull();
  });
});

describe('resolveCalcWindow', () => {
  const OBJECT_ID = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    // Фиксируем «сегодня»: окно строится от текущего месяца по МСК.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T09:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const withStart = (startMonth: string | null) => {
    (queryOne as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ start_month: startMonth });
  };

  it('окно идёт от начала расчёта до текущего месяца', async () => {
    withStart('2025-01');
    await expect(resolveCalcWindow([OBJECT_ID])).resolves.toEqual({ from: '2025-01', to: '2026-08' });
  });

  it('пустой скоуп не ходит в БД: окно из одного текущего месяца', async () => {
    await expect(resolveCalcWindow([])).resolves.toEqual({ from: '2026-08', to: '2026-08' });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('данных нет вовсе → окно из одного текущего месяца', async () => {
    withStart(null);
    await expect(resolveCalcWindow([OBJECT_ID])).resolves.toEqual({ from: '2026-08', to: '2026-08' });
  });

  it('начало глубже потолка подрезается', async () => {
    withStart('2005-03');
    const result = await resolveCalcWindow([OBJECT_ID]);
    // Ровно OBJECT_KPI_MAX_AUTO_MONTHS месяцев включительно: 2016-09 … 2026-08.
    expect(result).toEqual({ from: '2016-09', to: '2026-08' });
    const [fy, fm] = result.from.split('-').map(Number);
    const [ty, tm] = result.to.split('-').map(Number);
    expect((ty * 12 + tm) - (fy * 12 + fm) + 1).toBe(OBJECT_KPI_MAX_AUTO_MONTHS);
  });

  it('начало в будущем не даёт from > to', async () => {
    // Договор с первым расчётным месяцем в следующем году: иначе окно упало бы
    // на собственной валидации «начало периода позже конца».
    withStart('2027-01');
    await expect(resolveCalcWindow([OBJECT_ID])).resolves.toEqual({ from: '2026-08', to: '2026-08' });
  });

  it('приоритет plan_start_month обеспечивается запросом, а не клиентом', async () => {
    withStart('2025-01');
    await resolveCalcWindow([OBJECT_ID]);

    const sql = (queryOne as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    // COALESCE(plan_start_month, LEAST(...)) — явный первый расчётный месяц перекрывает
    // дату договора и первые акты, иначе договор 2020 года открыл бы период с 2020-го.
    expect(sql).toContain('COALESCE(');
    expect(sql.indexOf('s.plan_start_month')).toBeLessThan(sql.indexOf('LEAST('));
  });
});
