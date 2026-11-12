import { describe, expect, it } from 'vitest';

import type { IPayrollCalcColumns, IPayrollTermsRow } from '../services/payrollService';
import {
  applyPayrollAmountView,
  countPayrollAmountFilters,
  describePayrollAmountFilters,
  EMPTY_PAYROLL_AMOUNT_VIEW,
  isPayrollAmountViewColumn,
  payrollAmountFilterOptions,
  visiblePayrollAmountView,
} from './payrollCalcView';
import type { PayrollTableColumn } from './payrollColumns';
import { formatPaidAmount } from './payrollPaid';
import type { ITableView } from './tableView';

const calc = (overrides: Partial<IPayrollCalcColumns> = {}): IPayrollCalcColumns => ({
  rate: null,
  timesheet: null,
  overtime: null,
  overtime_days: 0,
  overtime_hours: 0,
  travel: null,
  vacation: null,
  sick_leave: null,
  housing: null,
  housing_kinds: [],
  supplements: null,
  supplements_planned: null,
  supplements_one_time: null,
  deductions: null,
  deductions_by_kind: [],
  net: null,
  open_months: [],
  preliminary: [],
  incomplete: [],
  ...overrides,
} as IPayrollCalcColumns);

const row = (id: number, overrides: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => (
  { employee_id: id, ...overrides } as IPayrollTermsRow
);

const view = (overrides: Partial<ITableView>): ITableView => ({ ...EMPTY_PAYROLL_AMOUNT_VIEW, ...overrides });
/** Текст суммы как в ячейке: ru-RU ставит неразрывный пробел между разрядами. */
const money = (value: number): string => formatPaidAmount(value);
const ids = (rows: IPayrollTermsRow[]): number[] => rows.map(item => item.employee_id);

const ROWS = [
  row(1, { calc: calc({ net: '1500.00' }) }),
  row(2, { calc: calc({ net: '0.00' }) }),
  row(3, { calc: calc({ net: null }) }),
  row(4, { calc: calc({ net: '-200.50' }) }),
  row(5, { calc: calc({ net: '0.00' }) }),
];

describe('applyPayrollAmountView', () => {
  it('«0,00» в «Сумме» отбирает нули, порядок сервера сохраняется', () => {
    expect(ids(applyPayrollAmountView(ROWS, view({ filters: { calc_net: ['0,00'] } })))).toEqual([2, 5]);
  });

  it('«—» отбирает непосчитанных', () => {
    expect(ids(applyPayrollAmountView(ROWS, view({ filters: { calc_net: ['—'] } })))).toEqual([3]);
  });

  it('сортировка по числу: минус до нуля, пустые в конце при любом направлении', () => {
    expect(ids(applyPayrollAmountView(ROWS, view({ sort: 'calc_net', dir: 'asc' })))).toEqual([4, 2, 5, 1, 3]);
    expect(ids(applyPayrollAmountView(ROWS, view({ sort: 'calc_net', dir: 'desc' })))).toEqual([1, 2, 5, 4, 3]);
  });

  it('пока ФОТ считается — «…»: фильтр не пропускает, сортировка ставит в конец', () => {
    const rows = [row(1, { calc_status: 'pending' }), row(2, { calc: calc({ net: '0.00' }) })];
    expect(ids(applyPayrollAmountView(rows, view({ filters: { calc_net: ['0,00'] } })))).toEqual([2]);
    expect(ids(applyPayrollAmountView(rows, view({ sort: 'calc_net', dir: 'desc' })))).toEqual([2, 1]);
  });

  it('«Выплаты на карту» — по сумме всех видов, как «Итого» ячейки', () => {
    const rows = [
      row(1, { card_payouts_by_method: [{ method: 'Аванс', amount: '100.10' }, { method: 'Премии', amount: '0.20' }] }),
      row(2, { card_payouts_by_method: [] }),
    ];
    expect(ids(applyPayrollAmountView(rows, view({ filters: { card_payouts: ['100,30'] } })))).toEqual([1]);
    expect(ids(applyPayrollAmountView(rows, view({ filters: { card_payouts: ['—'] } })))).toEqual([2]);
  });

  it('«Оклад» — текст ставки, сортировка по сумме', () => {
    const rows = [
      row(1, { calc: calc({ rate: { amount: '90000.00', calc_type: 'salary', as_of: '2026-10-31' } }) }),
      row(2, { calc: calc({ rate: { amount: '500.0000', calc_type: 'hourly', as_of: '2026-10-31' } }) }),
    ];
    expect(ids(applyPayrollAmountView(rows, view({ sort: 'calc_rate', dir: 'asc' })))).toEqual([2, 1]);
    expect(ids(applyPayrollAmountView(rows, view({ filters: { calc_rate: [money(90000)] } })))).toEqual([1]);
  });
});

describe('payrollAmountFilterOptions', () => {
  it('значения по возрастанию со счётчиком, «—» в конце, без фильтра самого столбца', () => {
    const options = payrollAmountFilterOptions(ROWS, view({ filters: { calc_net: ['0,00'] } }), 'calc_net');
    expect(options).toEqual([
      { value: '-200,50', count: 1 },
      { value: '0,00', count: 2 },
      { value: money(1500), count: 1 },
      { value: '—', count: 1 },
    ]);
  });

  it('«…» не предлагается', () => {
    const rows = [row(1, { calc_status: 'pending' }), row(2, { calc: calc({ net: '0.00' }) })];
    expect(payrollAmountFilterOptions(rows, EMPTY_PAYROLL_AMOUNT_VIEW, 'calc_net').map(option => option.value)).toEqual(['0,00']);
  });
});

describe('visiblePayrollAmountView', () => {
  it('скрытый столбец не фильтрует и не сортирует', () => {
    const hidden = new Set<PayrollTableColumn>(['calc_vacation']);
    const result = visiblePayrollAmountView(
      view({ sort: 'calc_vacation', dir: 'desc', filters: { calc_vacation: ['—'], calc_net: ['0,00'] } }),
      hidden,
    );
    expect(result).toEqual({ sort: '', dir: 'desc', filters: { calc_net: ['0,00'] } });
  });

  it('ничего не скрыто — тот же объект', () => {
    const current = view({ sort: 'calc_net', filters: { calc_net: ['0,00'] } });
    expect(visiblePayrollAmountView(current, new Set())).toBe(current);
  });
});

describe('описание и счётчик', () => {
  it('подписи шапки в порядке таблицы', () => {
    const current = view({ filters: { calc_remainder: ['—'], calc_net: ['0,00', money(1500)] } });
    expect(describePayrollAmountFilters(current)).toBe(`Сумма: 0,00, ${money(1500)}; Остаток к выплате: —`);
    expect(countPayrollAmountFilters(current)).toBe(2);
    expect(describePayrollAmountFilters(EMPTY_PAYROLL_AMOUNT_VIEW)).toBe('');
  });

  it('столбцы вида — суммы «Расчётов», не отдел и не подстолбцы', () => {
    expect(isPayrollAmountViewColumn('calc_net')).toBe(true);
    expect(isPayrollAmountViewColumn('department')).toBe(false);
    expect(isPayrollAmountViewColumn('calc_supplements:planned')).toBe(false);
  });
});
