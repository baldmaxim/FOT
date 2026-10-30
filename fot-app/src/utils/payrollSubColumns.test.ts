import { describe, expect, it } from 'vitest';

import type { IPayrollCalcColumns, IPayrollTermsRow } from '../services/payrollService';
import { calcSumAmount, sumAmounts } from './payrollCalcColumns';
import { PAYROLL_CALC_TABLE_COLUMNS } from './payrollColumns';
import {
  parseExpandedPayrollColumns,
  payrollSubColumns,
  payrollTableColumnList,
  subColumnAmount,
  toggleExpandedColumn,
  type PayrollExpandableColumn,
  type PayrollSubColumn,
} from './payrollSubColumns';

/** Ответ нового бэкенда: разбивка есть (null — без суммы). */
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
  supplements_planned: null,
  supplements_one_time: null,
  deductions: null,
  deductions_by_kind: [],
  net: null,
  open_months: [],
  incomplete: [],
  ...over,
});

/** Ответ старого бэкенда: полей разбивки нет совсем. */
const oldCalc = (over: Partial<IPayrollCalcColumns> = {}): IPayrollCalcColumns => {
  const result = calc(over);
  delete result.supplements_planned;
  delete result.supplements_one_time;
  delete result.deductions_by_kind;
  return result;
};

const row = (employeeId: number, over: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => (
  { employee_id: employeeId, ...over } as IPayrollTermsRow
);

const labels = (subs: readonly PayrollSubColumn[]) => subs.map(sub => sub.label);
const subsTotal = (item: IPayrollTermsRow, subs: readonly PayrollSubColumn[]) => sumAmounts(subs.map(sub => subColumnAmount(item, sub)));

describe('«+» у «Доплат»', () => {
  const abdullaev = row(1, { calc: calc({ travel: '2340.00' }) });
  const barulin = row(2, {
    calc: calc({
      overtime: '0.10', overtime_hours: 1, housing: '18900.00',
      supplements: '20000.20', supplements_planned: '20000.00', supplements_one_time: '0.20',
    }),
  });

  it('подстолбцы по порядку, только с суммой; сумма подстолбцов строки = свёрнутые «Доплаты»', () => {
    const subs = payrollSubColumns([abdullaev, barulin], 'calc_supplements');
    expect(labels(subs)).toEqual(['Переработка', 'Компенсация проезда', 'Проживание', 'Плановая', 'Разовая']);
    expect(subs.map(sub => sub.key)).toEqual([
      'calc_supplements:calc_overtime', 'calc_supplements:calc_travel', 'calc_supplements:calc_housing',
      'calc_supplements:planned', 'calc_supplements:one_time',
    ]);
    for (const item of [abdullaev, barulin]) expect(subsTotal(item, subs)).toBe(calcSumAmount(item, 'calc_supplements'));
    expect(calcSumAmount(abdullaev, 'calc_supplements')).toBe('2340.00');
    expect(calcSumAmount(barulin, 'calc_supplements')).toBe('38900.30');
    // Только проезд в выборке — один подстолбец.
    expect(labels(payrollSubColumns([abdullaev], 'calc_supplements'))).toEqual(['Компенсация проезда']);
  });

  it('старый бэкенд (проезд + общая доплата, разбивки нет) — без «+»: иначе плановая 1 000 потерялась бы', () => {
    const old = row(1, { calc: oldCalc({ travel: '2340.00', supplements: '1000.00' }) });
    expect(calcSumAmount(old, 'calc_supplements')).toBe('3340.00');
    expect(payrollSubColumns([old], 'calc_supplements')).toEqual([]);
    // Хоть одна строка без разбивки — тоже без «+».
    expect(payrollSubColumns([abdullaev, old], 'calc_supplements')).toEqual([]);
  });

  it('null в новых полях — разбивка есть; calc: null, «считается» и ошибка расчёта проверку не ломают', () => {
    const rows = [
      abdullaev,
      row(3, { calc: null }),
      row(4, { calc_status: 'pending' }),
      row(5, { calc_status: 'error' }),
    ];
    expect(labels(payrollSubColumns(rows, 'calc_supplements'))).toEqual(['Компенсация проезда']);
    // Одни строки без расчёта — раскрывать нечего.
    expect(payrollSubColumns(rows.slice(1), 'calc_supplements')).toEqual([]);
  });

  it('«0.00» и минус — тоже суммы', () => {
    const zero = row(1, { calc: calc({ supplements: '0.00', supplements_planned: '0.00' }) });
    const minus = row(2, { calc: calc({ supplements: '-500.00', supplements_one_time: '-500.00' }) });
    const subs = payrollSubColumns([zero, minus], 'calc_supplements');
    expect(labels(subs)).toEqual(['Плановая', 'Разовая']);
    expect(subsTotal(zero, subs)).toBe(calcSumAmount(zero, 'calc_supplements'));
    expect(subsTotal(minus, subs)).toBe('-500.00');
  });
});

describe('«+» у «Удержаний» (1С)', () => {
  it('статьи по порядку ведомости, месяцы — в копейках; незнакомый код — следом; сумма статей = «Удержания»', () => {
    const item = row(1, {
      paid_deductions_total: '-149.40',
      paid_deductions: [
        { month: '2026-09', item: 'prior_debts', amount: '-150.00' },
        { month: '2026-08', item: 'meals', amount: '0.10' },
        { month: '2026-09', item: 'meals', amount: '0.20' },
        { month: '2026-09', item: 'workwear', amount: '0.00' },
        { month: '2026-09', item: 'zz_new' as never, amount: '0.30' },
      ],
    });
    const abdukarimov = row(2, {
      paid_deductions_total: '9454.00',
      paid_deductions: [{ month: '2026-08', item: 'meals', amount: '9454.00' }],
    });
    const subs = payrollSubColumns([item, abdukarimov, row(3, { paid_deductions: null })], 'deductions');

    expect(labels(subs)).toEqual(['Питание', 'Спецодежда', 'Погашение долгов прошлых месяцев', 'zz_new']);
    expect(subs.map(sub => sub.key)).toEqual(['deductions:meals', 'deductions:workwear', 'deductions:prior_debts', 'deductions:zz_new']);
    expect(subColumnAmount(item, subs[0])).toBe('0.30');
    expect(subColumnAmount(item, subs[1])).toBe('0.00');
    expect(subColumnAmount(abdukarimov, subs[0])).toBe('9454.00');
    expect(subColumnAmount(abdukarimov, subs[1])).toBeNull();
    expect(subsTotal(item, subs)).toBe(item.paid_deductions_total);
    expect(subsTotal(abdukarimov, subs)).toBe(abdukarimov.paid_deductions_total);
  });

  it('статей нет ни у кого — раскрывать нечего', () => {
    expect(payrollSubColumns([row(1), row(2, { paid_deductions: [] })], 'deductions')).toEqual([]);
  });
});

describe('«+» у «Удержаний (ФОТ)»', () => {
  it('виды «Справочника» по названию; сумма видов строки = «Удержания (ФОТ)»; старый бэкенд — без «+»', () => {
    const ziyakulov = row(1, {
      calc: calc({
        deductions: '19811.77',
        deductions_by_kind: [
          { kind_id: 3, kind: 'Питание', amount: '8802.00' },
          { kind_id: 7, kind: 'Спецодежда', amount: '11009.77' },
        ],
      }),
    });
    const madrakhimov = row(2, {
      calc: calc({
        deductions: '13035.00',
        deductions_by_kind: [
          { kind_id: 12, kind: '% Займа', amount: '35.00' },
          { kind_id: 11, kind: 'Займ', amount: '13000.00' },
        ],
      }),
    });
    const subs = payrollSubColumns([ziyakulov, madrakhimov], 'calc_deductions');

    expect(labels(subs)).toEqual(['% Займа', 'Займ', 'Питание', 'Спецодежда']);
    expect(subs.map(sub => sub.key)).toEqual(['calc_deductions:12', 'calc_deductions:11', 'calc_deductions:3', 'calc_deductions:7']);
    expect(subsTotal(ziyakulov, subs)).toBe(ziyakulov.calc?.deductions);
    expect(subsTotal(madrakhimov, subs)).toBe(madrakhimov.calc?.deductions);
    expect(payrollSubColumns([row(1, { calc: oldCalc({ deductions: '100.00' }) })], 'calc_deductions')).toEqual([]);
  });
});

describe('список столбцов таблицы', () => {
  const subColumns = new Map<PayrollExpandableColumn, PayrollSubColumn[]>([
    ['deductions', [{ type: 'paid', key: 'deductions:meals', label: 'Питание', item: 'meals' }]],
    ['calc_supplements', [
      { type: 'column', key: 'calc_supplements:calc_travel', label: 'Компенсация проезда', column: 'calc_travel' },
      { type: 'supplement', key: 'calc_supplements:planned', label: 'Плановая', part: 'planned' },
    ]],
    ['calc_deductions', [{ type: 'kind', key: 'calc_deductions:3', label: 'Питание', kindId: 3 }]],
  ]);

  it('за раскрытым — его подстолбцы; свёрнутый — без них; ключи уникальны', () => {
    const list = payrollTableColumnList(PAYROLL_CALC_TABLE_COLUMNS, new Set(['calc_supplements', 'deductions']), subColumns);
    const keys = list.map(entry => entry.key);
    expect(keys.slice(keys.indexOf('deductions'), keys.indexOf('deductions') + 2)).toEqual(['deductions', 'deductions:meals']);
    expect(keys.slice(keys.indexOf('calc_supplements'), keys.indexOf('calc_supplements') + 4)).toEqual([
      'calc_supplements', 'calc_supplements:calc_travel', 'calc_supplements:planned', 'calc_deductions',
    ]);
    expect(keys).not.toContain('calc_deductions:3');
    expect(list).toHaveLength(PAYROLL_CALC_TABLE_COLUMNS.length + 3);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('скрытый шестерёнкой итог — без подстолбцов, даже раскрытый', () => {
    const visible = PAYROLL_CALC_TABLE_COLUMNS.filter(column => column.key !== 'calc_supplements');
    const list = payrollTableColumnList(visible, new Set(['calc_supplements']), subColumns);
    expect(list.map(entry => entry.key).filter(key => key.startsWith('calc_supplements'))).toEqual([]);
    expect(list).toHaveLength(visible.length);
  });

  it('«+» → «−» → «+»; из хранилища — только известные столбцы, мусор — пусто', () => {
    const opened = toggleExpandedColumn(new Set(), 'calc_supplements');
    expect([...opened]).toEqual(['calc_supplements']);
    expect([...toggleExpandedColumn(opened, 'calc_supplements')]).toEqual([]);
    expect([...parseExpandedPayrollColumns('["deductions","calc_net",5,"calc_deductions"]')])
      .toEqual(['deductions', 'calc_deductions']);
    expect(parseExpandedPayrollColumns('{"deductions":true}').size).toBe(0);
    expect(parseExpandedPayrollColumns('не json').size).toBe(0);
    expect(parseExpandedPayrollColumns(null).size).toBe(0);
  });
});
