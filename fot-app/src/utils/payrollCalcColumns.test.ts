import { describe, expect, it } from 'vitest';

import type { IPayrollCalcColumns, IPayrollCardPayoutByMethod, IPayrollTermsRow } from '../services/payrollService';
import {
  calcBrigadeOutputSub,
  calcIssuesNote,
  calcRemainderAmount,
  calcSumAmount,
  cardPayoutLines,
  cardPayoutsTotal,
  emptyPayrollColumns,
  formatCalcRate,
  housingKindsLabel,
  isCalcColumn,
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
  it('сентябрь «Бухгалтерии»: остаток, сумма и выплаты видны, хотя выплат нет; удержания 1С и пустые ФОТ скрыты', () => {
    expect(empty([
      row({
        paid_total: null, paid_deductions_total: null, card_payouts_by_method: null,
        calc: calc({
          rate: { amount: '250000.00', calc_type: 'salary', as_of: '2026-09-30' },
          timesheet: '250000.00', overtime: '1420.45', overtime_hours: 1, travel: '2730.00', net: '254150.45',
        }),
      }),
    ])).toEqual(['deductions', 'calc_vacation', 'calc_sick', 'paid_recalc', 'calc_deductions']);
  });

  it('«Остаток» и «Сумма» видны и у строк без итога ФОТ; «Выплаты на карту» не скрываются никогда', () => {
    const hidden = empty([row({ calc: null, card_payouts_by_method: null })]);
    expect(hidden).not.toContain('calc_remainder');
    expect(hidden).not.toContain('calc_net');
    expect(hidden).not.toContain('card_payouts');
  });

  it('свёрнутые «Доплаты» — переработка + проезд + проживание + плановая и разовая, в копейках; ни одной — null', () => {
    expect(calcSumAmount(row({ calc: calc({ overtime: '0.10', travel: '0.20', housing: null, supplements: '-0.05' }) }), 'calc_supplements'))
      .toBe('0.25');
    expect(calcSumAmount(row({ calc: calc({ travel: '2340.00' }) }), 'calc_supplements')).toBe('2340.00');
    expect(calcSumAmount(row({ calc: calc({ supplements: '0.00' }) }), 'calc_supplements')).toBe('0.00');
    expect(calcSumAmount(row({ calc: calc() }), 'calc_supplements')).toBeNull();
    expect(empty([row({ calc: calc({ housing: '18900.00' }) })])).not.toContain('calc_supplements');
  });

  it('0 и минус — данные; неполный расчёт — данные «Начислено по табелю»; столбцы условий не скрываются', () => {
    const hidden = empty([
      row({
        paid_recalc_prev: '-1200.00',
        calc: calc({ deductions: '0.00', incomplete: [{ month: '2026-09', reasons: ['brigade_output'] }] }),
      }),
    ]);

    expect(hidden).not.toContain('paid_recalc');
    expect(hidden).not.toContain('calc_deductions');
    expect(hidden).not.toContain('calc_timesheet');
    expect(hidden).not.toContain('department');
  });

  it('незакрытый месяц без суммы (1-е число) — не данные: строки нет, столбец «Начислено по табелю» скрыт', () => {
    expect(empty([row({ calc: calc({ open_months: ['2026-10'] }) })])).toContain('calc_timesheet');
  });

  it('отпускные и больничные — из расчёта ФОТ: есть сумма — столбец виден; старый бэкенд без поля — скрыт', () => {
    const grinev = row({ paid_vacation: '999.00', calc: calc({ vacation: '59709.13', net: '181529.13' }) } as Partial<IPayrollTermsRow>);
    expect(calcSumAmount(grinev, 'calc_vacation')).toBe('59709.13');
    expect(calcSumAmount(grinev, 'calc_sick')).toBeNull();
    const hidden = empty([grinev]);
    expect(hidden).not.toContain('calc_vacation');
    expect(hidden).toContain('calc_sick');
    expect(empty([row({ calc: calc({ net: '100.00' }) })])).toEqual(expect.arrayContaining(['calc_vacation', 'calc_sick']));
  });

  it('строк нет — ничего не скрывается', () => {
    expect(empty([])).toEqual([]);
  });
});

describe('«Остаток к выплате»', () => {
  const pay = (...amounts: string[]): IPayrollCardPayoutByMethod[] => amounts.map((amount, index) => ({ method: `Вид ${index}`, amount }));

  it('«Сумма» минус все виды выплат: Алюшева, Абдурахманов Б., Калязин за сентябрь', () => {
    expect(calcRemainderAmount(row({
      calc: calc({ net: '185926.20' }), card_payouts_by_method: pay('60504.45', '52595.19', '36998.20'),
    }))).toBe('35828.36');
    expect(calcRemainderAmount(row({ calc: calc({ net: '181630.00' }), card_payouts_by_method: pay('35000.00', '35000.00') }))).toBe('111630.00');
    expect(calcRemainderAmount(row({
      calc: calc({ net: '244856.71' }), card_payouts_by_method: pay('84930.71', '24913.36', '10246.28'),
    }))).toBe('124766.36');
  });

  it('единственный вид выплаты тоже вычитается, хотя «Итого» у него нет', () => {
    const payouts = pay('167000.00');
    expect(cardPayoutsTotal(cardPayoutLines(payouts))).toBeNull();
    expect(calcRemainderAmount(row({ calc: calc({ net: '200000.00' }), card_payouts_by_method: payouts }))).toBe('33000.00');
  });

  it('выплат нет — вся «Сумма», ноль — ноль', () => {
    expect(calcRemainderAmount(row({ calc: calc({ net: '256260.00' }), card_payouts_by_method: null }))).toBe('256260.00');
    expect(calcRemainderAmount(row({ calc: calc({ net: '256260.00' }), card_payouts_by_method: [] }))).toBe('256260.00');
    expect(calcRemainderAmount(row({ calc: calc({ net: '0.00' }), card_payouts_by_method: [] }))).toBe('0.00');
  });

  it('выплачено больше расчёта — минус; счёт в копейках', () => {
    expect(calcRemainderAmount(row({ calc: calc({ net: '110630.00' }), card_payouts_by_method: pay('161630.00') }))).toBe('-51000.00');
    expect(calcRemainderAmount(row({ calc: calc({ net: '0.30' }), card_payouts_by_method: pay('0.10', '0.20') }))).toBe('0.00');
  });

  it('итог ФОТ неизвестен — суммы нет, даже если выплаты есть', () => {
    const payouts = pay('58132.18');
    expect(calcRemainderAmount(row({ calc: calc({ net: null }), card_payouts_by_method: payouts }))).toBeNull();
    expect(calcRemainderAmount(row({ calc: null, card_payouts_by_method: payouts }))).toBeNull();
    expect(calcRemainderAmount(row({ card_payouts_by_method: payouts }))).toBeNull();
  });

  it('столбец расчёта ФОТ: пока считается — «…»; calcSumAmount отдаёт то же число', () => {
    expect(isCalcColumn('calc_remainder')).toBe(true);
    const item = row({ calc: calc({ net: '100.00' }), card_payouts_by_method: pay('40.00') });
    expect(calcSumAmount(item, 'calc_remainder')).toBe('60.00');
    expect(calcSumAmount(item, 'calc_net')).toBe('100.00');
  });
});

describe('ячейки состава зарплаты', () => {
  it('подсказка неполного расчёта: месяцы по порядку, причины словами; про закрытие табеля — ни слова', () => {
    expect(calcIssuesNote(calc({
      open_months: ['2026-10'],
      preliminary: [{ month: '2026-09', as_of: '2026-09-30' }],
      incomplete: [{ month: '2026-09', reasons: ['brigade_no_hours'] }, { month: '2026-08', reasons: ['hourly', 'no_terms'] }],
    }))).toBe('Неполный расчёт: август — почасовая ставка: нет часов табеля, нет условий оплаты; '
      + 'сентябрь — нет учтённых часов бригады');
    expect(calcIssuesNote(calc({ preliminary: [{ month: '2026-09', as_of: '2026-09-30' }] }))).toBeNull();
    expect(calcIssuesNote(calc())).toBeNull();
    expect(calcIssuesNote(undefined)).toBeNull();
  });

  it('выработка не введена — без ⚠ (подсказки нет), подпись «выработка не внесена»; ошибка бригады — ⚠', () => {
    const noOutput = calc({ incomplete: [{ month: '2026-09', reasons: ['brigade_output'] }] });
    expect(calcIssuesNote(noOutput)).toBeNull();
    expect(calcBrigadeOutputSub(noOutput)).toBe('выработка не внесена');
    // С другой причиной в том же месяце — ⚠ только с ней.
    const mixed = calc({ incomplete: [{ month: '2026-09', reasons: ['brigade_output', 'no_norm'] }] });
    expect(calcIssuesNote(mixed)).toBe('Неполный расчёт: сентябрь — нет нормы');
    const error = calc({ incomplete: [{ month: '2026-09', reasons: ['brigade_error'] }] });
    expect(calcIssuesNote(error)).toBe('Неполный расчёт: сентябрь — ошибка расчёта бригады');
    expect(calcBrigadeOutputSub(error)).toBeNull();
    expect(calcBrigadeOutputSub(calc({ timesheet: '1000.00' }))).toBeNull();
  });

  it('выработка не введена — «Начислено по табелю» и «Сумма» не скрываются, хотя сумм нет', () => {
    const hidden = empty([row({ calc: calc({ incomplete: [{ month: '2026-09', reasons: ['brigade_output'] }] }) })]);
    expect(hidden).not.toContain('calc_timesheet');
    expect(hidden).not.toContain('calc_net');
  });

  it('переработка — из чего: выходы и часы', () => {
    expect(overtimeNote(calc({ overtime: '9000.00', overtime_days: 2, overtime_hours: 6.5 }))).toBe('2 вых. · 6,5 ч');
    expect(overtimeNote(calc({ overtime: '1420.45', overtime_hours: 1 }))).toBe('1 ч');
    expect(overtimeNote(calc())).toBeNull();
  });

  it('выплаты на карту — каждый способ 1С по порядку, незнакомые следом; «Итого» в копейках; проживание — словом', () => {
    const lines = cardPayoutLines([
      { method: 'Материальная помощь', amount: '100000.00' },
      { method: 'Премии', amount: '59547.00' },
      { method: 'Новый способ', amount: '0.10' },
      { method: 'Аванс', amount: '56550.00' },
      { method: 'Зарплата за месяц', amount: '10966.73' },
      { method: 'Отпуска', amount: '24265.56' },
      { method: 'Вознаграждение сотрудникам по договорам ГПХ', amount: '0.20' },
    ]);
    expect(lines.map(line => [line.method, line.label])).toEqual([
      ['Аванс', 'Аванс'],
      ['Зарплата за месяц', 'Зарплата'],
      ['Премии', 'Премии'],
      ['Отпуска', 'Отпуска'],
      ['Вознаграждение сотрудникам по договорам ГПХ', 'ГПХ'],
      ['Материальная помощь', 'Мат. помощь'],
      ['Новый способ', 'Новый способ'],
    ]);
    // 0,10 + 0,20 в рублях дали бы 0,30000000000000004 — сложение в копейках.
    expect(cardPayoutsTotal(lines)).toBe('251329.59');
    expect(cardPayoutsTotal(lines.slice(0, 1))).toBeNull();
    expect(cardPayoutLines(null)).toEqual([]);
    // Старый бэкенд отдавал объект трёх видов — не массив, ячейка пустая.
    expect(cardPayoutLines({ advance: '1.00' } as unknown as IPayrollCardPayoutByMethod[])).toEqual([]);
    expect(housingKindsLabel(calc({ housing_kinds: ['dormitory', 'apartment'] }))).toBe('общежитие, квартира');
  });

  it('оклад — с копейками, почасовая ставка — до 4 знаков и «₽/ч»', () => {
    expect(formatCalcRate({ amount: '250000.00', calc_type: 'salary', as_of: '2026-09-30' })).toBe('250 000,00');
    expect(formatCalcRate({ amount: '550.1250', calc_type: 'hourly', as_of: '2026-09-30' })).toBe('550,125 ₽/ч');
    expect(formatCalcRate(null)).toBe('—');
  });
});
