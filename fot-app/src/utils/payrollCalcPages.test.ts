import { describe, expect, it } from 'vitest';

import type { IPayrollCalcColumns, IPayrollTermsRow } from '../services/payrollService';
import { emptyPayrollColumns } from './payrollCalcColumns';
import {
  calcColumnsQueryKey,
  calcPageRequests,
  calcQueryEnabled,
  mergeCalcColumns,
  toCalcQueryState,
  type CalcQueryState,
} from './payrollCalcPages';
import { PAYROLL_CALC_TABLE_COLUMNS } from './payrollColumns';

const row = (employeeId: number, over: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => (
  { employee_id: employeeId, ...over } as IPayrollTermsRow
);
const calc = (net: string): IPayrollCalcColumns => ({
  rate: { amount: '100000.00', calc_type: 'salary', as_of: '2026-09-30' },
  timesheet: net, overtime: null, overtime_days: 0, overtime_hours: 0, travel: null, housing: null, housing_kinds: [],
  supplements: null, deductions: null, net, open_months: [], incomplete: [],
});
const success = (rows: Array<{ employee_id: number; calc: IPayrollCalcColumns | null }>, available = true): CalcQueryState => (
  { status: 'success', result: { available, rows } }
);

describe('порции «Расчётов» для расчёта ФОТ', () => {
  it('месяцы — из порции (не текущие), строки старого бэкенда с полем calc — без запроса, даже calc: null', () => {
    const requests = calcPageRequests([
      { rows: [row(1), row(2)], paidMonths: ['2026-08'] },
      { rows: [row(3, { calc: null }), row(4)], paidMonths: ['2026-09'] },
      { rows: [row(5, { calc: calc('1.00') })], paidMonths: ['2026-09'] },
      { rows: [row(6)], paidMonths: null },
    ]);
    expect(requests).toEqual([{ ids: [1, 2], months: ['2026-08'] }, { ids: [4], months: ['2026-09'] }]);
    expect(calcColumnsQueryKey(requests[0])).toEqual(['payroll-terms', 'calc-columns', [1, 2], ['2026-08']]);
  });

  it('по одной: следующая — после завершения предыдущей, даже ошибкой; скрытый экран и «недоступно» — стоп', () => {
    const pending: CalcQueryState = { status: 'pending' };
    const error: CalcQueryState = { status: 'error' };
    expect(calcQueryEnabled(0, [pending, pending], true)).toBe(true);
    expect(calcQueryEnabled(1, [pending, pending], true)).toBe(false);
    expect(calcQueryEnabled(1, [error, pending], true)).toBe(true);
    expect(calcQueryEnabled(1, [success([]), pending], true)).toBe(true);
    expect(calcQueryEnabled(0, [pending], false)).toBe(false);
    expect(calcQueryEnabled(1, [success([], false), pending], true)).toBe(false);
    expect(calcQueryEnabled(2, [success([], false), error, pending], true)).toBe(false);
  });

  it('состояние из кэша: успех с данными, ошибка, иначе — ждём', () => {
    expect(toCalcQueryState(undefined)).toEqual({ status: 'pending' });
    expect(toCalcQueryState({ status: 'error' } as never)).toEqual({ status: 'error' });
    expect(toCalcQueryState({ status: 'success', data: { available: true, rows: [] } } as never))
      .toEqual({ status: 'success', result: { available: true, rows: [] } });
  });
});

describe('подмешивание столбцов ФОТ', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  const requests = [{ ids: [1, 2], months: ['2026-09'] }, { ids: [3, 4], months: ['2026-09'] }];

  it('первая посчитана, вторая считается — «…» у второй, столбцы ФОТ не скрываются', () => {
    const merge = mergeCalcColumns(rows, requests, [success([{ employee_id: 1, calc: calc('10.00') }]), { status: 'pending' }]);
    expect(merge.rows.map(item => [item.employee_id, item.calc?.net ?? null, item.calc_status ?? null])).toEqual([
      [1, '10.00', null], [2, null, null], [3, null, 'pending'], [4, null, 'pending'],
    ]);
    expect(merge).toMatchObject({ ready: false, failed: false });
    expect(emptyPayrollColumns(merge.rows, PAYROLL_CALC_TABLE_COLUMNS, merge.ready)).not.toContain('calc_net');
  });

  it('ошибка одной порции — «—» у её строк, «Повторить», столбцы ФОТ не скрываются', () => {
    const merge = mergeCalcColumns(rows, requests, [{ status: 'error' }, success([{ employee_id: 3, calc: calc('5.00') }])]);
    expect(merge.rows.map(item => item.calc_status ?? null)).toEqual(['error', 'error', null, null]);
    expect(merge).toMatchObject({ ready: false, failed: true });
    expect(emptyPayrollColumns(merge.rows, PAYROLL_CALC_TABLE_COLUMNS, merge.ready)).not.toContain('calc_supplements');
  });

  it('все посчитаны — пустые столбцы ФОТ скрываются', () => {
    const merge = mergeCalcColumns(rows, requests, [
      success([{ employee_id: 1, calc: calc('10.00') }, { employee_id: 2, calc: null }]),
      success([{ employee_id: 3, calc: calc('5.00') }]),
    ]);
    expect(merge.ready).toBe(true);
    const hidden = emptyPayrollColumns(merge.rows, PAYROLL_CALC_TABLE_COLUMNS, merge.ready);
    expect(hidden).toContain('calc_supplements');
    expect(hidden).not.toContain('calc_net');
  });

  it('«ФОТ недоступен» — на весь период: строки без «…», столбцы ФОТ скрыты', () => {
    const merge = mergeCalcColumns(rows, requests, [success([], false), { status: 'pending' }]);
    expect(merge.rows.every(item => !item.calc_status && !('calc' in item))).toBe(true);
    expect(merge).toMatchObject({ ready: true, failed: false });
    expect(emptyPayrollColumns(merge.rows, PAYROLL_CALC_TABLE_COLUMNS, merge.ready)).toContain('calc_net');
  });
});
