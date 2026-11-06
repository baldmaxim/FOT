import { describe, expect, it } from 'vitest';

import type { IPayrollCalcColumns, IPayrollTermsRow } from '../services/payrollService';
import type { PayrollTableColumn } from './payrollColumns';
import { payrollColumnTotals, payrollTotalState } from './payrollCalcTotals';
import type { PayrollSubColumn, PayrollTableColumnEntry } from './payrollSubColumns';

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

const row = (overrides: Partial<IPayrollTermsRow>): IPayrollTermsRow => ({ employee_id: 1, ...overrides } as IPayrollTermsRow);

const column = (key: PayrollTableColumn): PayrollTableColumnEntry => ({ kind: 'column', key, column: { key, label: key } });
const sub = (value: PayrollSubColumn, parent: 'calc_supplements' | 'deductions' = 'calc_supplements'): PayrollTableColumnEntry => (
  { kind: 'sub', key: value.key, parent, sub: value }
);

describe('payrollColumnTotals', () => {
  it('складывает в копейках: 0,10 + 0,20 = 0,30, минус и ноль — тоже суммы', () => {
    const rows = [
      row({ calc: calc({ net: '0.10' }) }),
      row({ calc: calc({ net: '0.20' }) }),
      row({ calc: calc({ net: '-5.00' }) }),
      row({ calc: calc({ net: '0.00' }) }),
    ];
    expect(payrollColumnTotals(rows, [column('calc_net')]).get('calc_net')?.amount).toBe('-4.70');
  });

  it('у текста и оклада итога нет — ключа в ответе нет', () => {
    const totals = payrollColumnTotals([row({ calc: calc({ net: '1.00' }) })], [
      column('department'), column('position'), column('schedule'), column('calc_rate'), column('calc_net'),
    ]);
    expect([...totals.keys()]).toEqual(['calc_net']);
  });

  it('ни одной суммы — null, а не 0', () => {
    expect(payrollColumnTotals([row({ calc: calc() })], [column('calc_vacation')]).get('calc_vacation')?.amount).toBeNull();
  });

  it('«Сумма» без выработки и без условий — в сумму не входят, число и причины в подсказке', () => {
    const rows = [
      row({ calc: calc({ net: '100.00' }) }),
      row({ calc: calc({ incomplete: [{ month: '2026-10', reasons: ['brigade_output'] }] }) }),
      row({ calc: calc({ incomplete: [{ month: '2026-10', reasons: ['no_terms'] }] }) }),
    ];
    expect(payrollColumnTotals(rows, [column('calc_net')]).get('calc_net')).toEqual({
      amount: '100.00',
      fromCalc: true,
      missing: 2,
      title: 'Не вошли 2 чел.: выработка бригады не введена, нет условий оплаты',
    });
  });

  it('«Нет дней в табеле» и пустая «Сумма» без причин — не пропуск', () => {
    const rows = [
      row({ calc: calc({ net: '0.00', incomplete: [{ month: '2026-09', reasons: ['no_days'] }] }) }),
      row({ calc: calc() }),
    ];
    const total = payrollColumnTotals(rows, [column('calc_timesheet'), column('calc_net')]);
    expect(total.get('calc_net')?.missing).toBe(0);
    expect(total.get('calc_timesheet')?.missing).toBe(0);
  });

  it('calc: null (расчёт не вернул сотрудника) и незакрытый месяц — пропуск; без поля calc — нет', () => {
    const rows = [
      row({ calc: null }),
      row({ calc: calc({ open_months: ['2026-11'] }) }),
      row({}),
    ];
    expect(payrollColumnTotals(rows, [column('calc_net')]).get('calc_net')?.missing).toBe(2);
  });

  it('пропуск считается только у «Суммы», «Остатка» и «Начислено»: у доплат «—» — не пропуск', () => {
    const rows = [row({ calc: calc({ incomplete: [{ month: '2026-10', reasons: ['no_terms'] }] }) })];
    const totals = payrollColumnTotals(rows, [column('calc_supplements'), column('calc_remainder'), column('calc_timesheet')]);
    expect(totals.get('calc_supplements')?.missing).toBe(0);
    expect(totals.get('calc_remainder')?.missing).toBe(1);
    expect(totals.get('calc_timesheet')?.missing).toBe(1);
  });

  it('«Остаток» — «Сумма» минус все выплаты; выплаты без известной «Суммы» в остаток не идут', () => {
    const rows = [
      // Давуров: уволен, выплатили больше расчёта — минус.
      row({
        calc: calc({ net: '100625.00' }),
        card_payouts_by_method: [{ method: 'Премии', amount: '54542.00' }, { method: 'Увольнения', amount: '162092.47' }],
      }),
      row({ calc: calc({ net: '1000.00' }) }),
      row({
        calc: calc({ incomplete: [{ month: '2026-09', reasons: ['no_terms'] }] }),
        card_payouts_by_method: [{ method: 'Увольнения', amount: '9125.52' }],
      }),
    ];
    const totals = payrollColumnTotals(rows, [column('calc_net'), column('calc_remainder'), column('card_payouts')]);
    expect(totals.get('calc_net')?.amount).toBe('101625.00');
    expect(totals.get('calc_remainder')?.amount).toBe('-115009.47');
    expect(totals.get('card_payouts')?.amount).toBe('225759.99');
  });

  it('«Выплаты на карту»: одно число, виды — в подсказке теми же подписями и порядком, что в ячейке', () => {
    const rows = [
      row({ card_payouts_by_method: [{ method: 'Зарплата за месяц', amount: '10.10' }, { method: 'Аванс', amount: '5.00' }] }),
      row({ card_payouts_by_method: [{ method: 'Зарплата за месяц', amount: '0.20' }] }),
      row({ card_payouts_by_method: null }),
    ];
    const total = payrollColumnTotals(rows, [column('card_payouts')]).get('card_payouts');
    expect(total?.amount).toBe('15.30');
    expect(total?.fromCalc).toBe(false);
    expect(total?.title).toBe(['Аванс: 5,00', 'Зарплата: 10,30'].join('\n'));
  });

  it('суммы 1С: «Удержания» и «Перерасчёт» готовы без расчёта ФОТ', () => {
    const rows = [
      row({ paid_deductions_total: '100.50', paid_recalc_prev: '-1.00' }),
      row({ paid_deductions_total: null, paid_recalc_prev: '2.00' }),
    ];
    const totals = payrollColumnTotals(rows, [column('deductions'), column('paid_recalc')]);
    expect(totals.get('deductions')).toMatchObject({ amount: '100.50', fromCalc: false });
    expect(totals.get('paid_recalc')).toMatchObject({ amount: '1.00', fromCalc: false });
  });

  it('подстолбцы: виды ФОТ ждут расчёт, статьи 1С — нет; сумма подстолбцов равна итогу «Доплат»', () => {
    const rows = [
      row({
        calc: calc({ overtime: '10.00', travel: '2.50', supplements: '1.25', supplements_planned: '1.00', supplements_one_time: '0.25' }),
        paid_deductions: [{ month: '2026-09', item: 'meals', amount: '7.00' }],
      }),
    ];
    const entries = [
      column('calc_supplements'),
      sub({ type: 'column', key: 'calc_supplements:calc_overtime', label: 'Переработка', column: 'calc_overtime' }),
      sub({ type: 'column', key: 'calc_supplements:calc_travel', label: 'Проезд', column: 'calc_travel' }),
      sub({ type: 'supplement', key: 'calc_supplements:planned', label: 'Плановая', part: 'planned' }),
      sub({ type: 'supplement', key: 'calc_supplements:one_time', label: 'Разовая', part: 'one_time' }),
      sub({ type: 'paid', key: 'deductions:meals', label: 'Питание', item: 'meals' }, 'deductions'),
    ];
    const totals = payrollColumnTotals(rows, entries);
    expect(totals.get('calc_supplements')?.amount).toBe('13.75');
    expect(totals.get('calc_supplements:planned')).toMatchObject({ amount: '1.00', fromCalc: true });
    expect(totals.get('deductions:meals')).toMatchObject({ amount: '7.00', fromCalc: false });
  });
});

describe('payrollTotalState', () => {
  it('пока не все строки — итога нет ни у какого столбца', () => {
    expect(payrollTotalState({ rows: 'pending', calc: 'ready' }, false)).toBe('pending');
    expect(payrollTotalState({ rows: 'failed', calc: 'ready' }, true)).toBe('failed');
  });

  it('все строки есть: суммы 1С готовы, столбцам ФОТ нужен расчёт', () => {
    expect(payrollTotalState({ rows: 'ready', calc: 'pending' }, false)).toBe('ready');
    expect(payrollTotalState({ rows: 'ready', calc: 'pending' }, true)).toBe('pending');
    expect(payrollTotalState({ rows: 'ready', calc: 'failed' }, true)).toBe('failed');
    expect(payrollTotalState({ rows: 'ready', calc: 'ready' }, true)).toBe('ready');
  });
});
