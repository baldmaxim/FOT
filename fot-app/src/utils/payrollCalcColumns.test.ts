import { describe, expect, it } from 'vitest';

import type { IPayrollCalcColumns, IPayrollTermsRow } from '../services/payrollService';
import {
  calcIssuesNote,
  calcNotClosed,
  calcTimesheetSub,
  cardPayoutLines,
  emptyPayrollColumns,
  formatCalcRate,
  housingKindsLabel,
  overtimeNote,
} from './payrollCalcColumns';
import { PAYROLL_CALC_TABLE_COLUMNS } from './payrollColumns';

const calc = (over: Partial<IPayrollCalcColumns> = {}): IPayrollCalcColumns => ({
  rate: null,
  timesheet: null,
  overtime: null,
  overtime_days: 0,
  overtime_hours: 0,
  travel: null,
  housing: null,
  housing_kinds: [],
  supplements: null,
  deductions: null,
  net: null,
  open_months: [],
  incomplete: [],
  ...over,
});

const row = (over: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => ({ employee_id: 1, ...over } as IPayrollTermsRow);

const empty = (rows: IPayrollTermsRow[]) => [...emptyPayrollColumns(rows, PAYROLL_CALC_TABLE_COLUMNS)];

describe('столбцы без данных на «Расчётах»', () => {
  it('сентябрь «Бухгалтерии»: оклад, по табелю, переработка, проезд и сумма — 1С и пустые ФОТ скрыты', () => {
    expect(empty([
      row({
        paid_total: null, paid_deductions_total: null, card_payouts: null,
        calc: calc({
          rate: { amount: '250000.00', calc_type: 'salary', as_of: '2026-09-30' },
          timesheet: '250000.00', overtime: '1420.45', overtime_hours: 1, travel: '2730.00', net: '254150.45',
        }),
      }),
    ])).toEqual([
      'payout', 'accrued', 'deductions', 'paid_vacation', 'paid_sick', 'calc_housing', 'paid_recalc',
      'calc_supplements', 'calc_deductions', 'card_payouts',
    ]);
  });

  it('0 и минус — данные; «не закрыт» — данные «Начислено по табелю»; столбцы условий не скрываются', () => {
    const hidden = empty([
      row({ paid_recalc_prev: '-1200.00', calc: calc({ deductions: '0.00', open_months: ['2026-09'] }) }),
    ]);

    expect(hidden).not.toContain('paid_recalc');
    expect(hidden).not.toContain('calc_deductions');
    expect(hidden).not.toContain('calc_timesheet');
    expect(hidden).not.toContain('department');
  });

  it('строк нет — ничего не скрывается', () => {
    expect(empty([])).toEqual([]);
  });
});

describe('ячейки состава зарплаты', () => {
  it('подсказка неполного расчёта: месяцы по порядку, причины словами', () => {
    expect(calcIssuesNote(calc({
      open_months: ['2026-09'],
      incomplete: [{ month: '2026-08', reasons: ['hourly'] }],
    }))).toBe('Неполный расчёт: август — почасовая ставка, ФОТ не считает; сентябрь — табель не закрыт');
    expect(calcIssuesNote(calc())).toBeNull();
    expect(calcIssuesNote(undefined)).toBeNull();
  });

  it('предварительный расчёт: причины одного месяца — одной частью, текущий месяц — «по 27.10»', () => {
    expect(calcIssuesNote(calc({
      timesheet: '55000.00',
      preliminary: [{ month: '2026-09', as_of: '2026-09-30' }],
    }))).toBe('Предварительный расчёт: сентябрь — табель не закрыт, предварительно');
    expect(calcIssuesNote(calc({
      preliminary: [{ month: '2026-10', as_of: '2026-10-27' }],
      incomplete: [{ month: '2026-10', reasons: ['brigade_output'] }, { month: '2026-08', reasons: ['hourly'] }],
    }))).toBe('Неполный расчёт: август — почасовая ставка, ФОТ не считает; '
      + 'октябрь — табель не закрыт, предварительно по 27.10, выработка бригады не введена');
  });

  it('подпись «Начислено по табелю»: только у предварительного расчёта', () => {
    const preliminary = [{ month: '2026-09', as_of: '2026-09-30' }];
    const noOutput = [{ month: '2026-09', reasons: ['brigade_output' as const] }];

    expect(calcTimesheetSub(calc({ timesheet: '55000.00', preliminary }), '55000.00')).toBe('табель не закрыт');
    expect(calcTimesheetSub(calc({ preliminary, incomplete: noOutput }), null)).toBe('выработка не внесена');
    // Закрытый месяц без выработки — как прежде, «—» и ⚠ без подписи.
    expect(calcTimesheetSub(calc({ incomplete: noOutput }), null)).toBeNull();
    // Старый бэкенд — поля нет.
    expect(calcTimesheetSub(calc(), '1000.00')).toBeNull();
  });

  it('предварительный без суммы по табелю — столбец «Начислено по табелю» не скрывается', () => {
    expect(empty([row({ calc: calc({ net: '-3500.00', preliminary: [{ month: '2026-09', as_of: '2026-09-30' }] }) })]))
      .not.toContain('calc_timesheet');
  });

  it('«не закрыт» — только когда суммы нет', () => {
    expect(calcNotClosed(calc({ open_months: ['2026-09'] }))).toBe(true);
    expect(calcNotClosed(calc({ open_months: ['2026-09'], timesheet: '1000.00' }))).toBe(false);
    expect(calcNotClosed(null)).toBe(false);
  });

  it('переработка — из чего: выходы и часы', () => {
    expect(overtimeNote(calc({ overtime: '9000.00', overtime_days: 2, overtime_hours: 6.5 }))).toBe('2 вых. · 6,5 ч');
    expect(overtimeNote(calc({ overtime: '1420.45', overtime_hours: 1 }))).toBe('1 ч');
    expect(overtimeNote(calc())).toBeNull();
  });

  it('выплаты на карту — виды с суммой по порядку; проживание — вид словом', () => {
    expect(cardPayoutLines({ advance: '80000.00', salary: null, premium: '0.00' })).toEqual([
      { label: 'Аванс', amount: '80000.00' },
      { label: 'Премия', amount: '0.00' },
    ]);
    expect(cardPayoutLines(null)).toEqual([]);
    expect(housingKindsLabel(calc({ housing_kinds: ['dormitory', 'apartment'] }))).toBe('общежитие, квартира');
  });

  it('оклад — с копейками, почасовая ставка — до 4 знаков и «₽/ч»', () => {
    expect(formatCalcRate({ amount: '250000.00', calc_type: 'salary', as_of: '2026-09-30' })).toBe('250 000,00');
    expect(formatCalcRate({ amount: '550.1250', calc_type: 'hourly', as_of: '2026-09-30' })).toBe('550,125 ₽/ч');
    expect(formatCalcRate(null)).toBe('—');
  });
});
