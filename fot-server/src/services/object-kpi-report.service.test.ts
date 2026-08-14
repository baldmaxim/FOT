/**
 * Сводка по руководителю (п. 3.5): Σfact / Σplan, а НЕ среднее процентов по месяцам.
 * Разница на реальных данных доходит до десятков процентных пунктов, поэтому кейс
 * зафиксирован тестом, а не комментарием.
 */
import { describe, it, expect } from 'vitest';

import { summarizeCompletion, type ObjectKpiReportRow } from './object-kpi-report.service.js';

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
