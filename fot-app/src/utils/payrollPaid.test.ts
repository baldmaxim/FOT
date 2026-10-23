import { describe, expect, it } from 'vitest';

import {
  formatPaidAmount,
  formatPaidPeriod,
  paidAmountMonths,
  paidCellKey,
  paidHistory,
  paidItemTotal,
  paidPayout,
  paidMonthsRange,
  paidTotals,
  PAYROLL_PAID_ALL_FROM,
  PAYROLL_PAID_GROUPS,
  pickPaidKind,
  pickPaidRows,
  toPaidAmounts,
  visiblePaidGroups,
} from './payrollPaid';

const ITEMS = PAYROLL_PAID_GROUPS.flatMap(group => group.items);

describe('статьи', () => {
  it('39 статей без повторов, в порядке ведомости', () => {
    expect(ITEMS).toHaveLength(39);
    expect(new Set(ITEMS.map(item => item.code)).size).toBe(39);
    expect(PAYROLL_PAID_GROUPS.map(group => group.items.map(item => item.label))).toEqual([
      ['По трудовому договору', 'Премиальная', 'Больничный', 'Отпуска'],
      ['Компенсация проживания', 'Проезд', 'Переработка', 'Перерасчёт за предыдущий период',
        'Выходное пособие при увольнении', 'Разовая доплата', 'Плановая доплата', 'Займ',
        'KPI', 'Премия', 'Премия % по договору', 'Выплата по договору ГПХ', 'Допработы', 'Замещение',
        'Компенсация использования личного а/м', 'Депонент', 'Оплата по дневному тарифу', 'Спецодежда (начисление)'],
      ['Питание', 'Спецодежда', 'Нарушение техники безопасности', 'Штрафы', 'Удержание по исп. листу',
        'Оплата отпуска (удержание)', 'Погашение займа', '% Займа', 'Квартиры', 'Подотчёт',
        'Удержание в пользу третьего лица', 'Транспортные затраты', 'Моб. телефон',
        'Банковские издержки по исп. листам', 'Алименты', 'ТМЦ', 'Удержание по договору аренды а/м'],
    ]);
  });

  it('подписи не повторяются — заголовки столбцов xlsx «Свода» уникальны', () => {
    expect(new Set(ITEMS.map(item => item.label)).size).toBe(ITEMS.length);
  });

  it('исп. лист — в удержаниях, займ и плановая доплата — в начислениях', () => {
    const kindOf = (code: string) => PAYROLL_PAID_GROUPS.find(group => group.items.some(item => item.code === code))?.kind;
    expect(kindOf('writ_deduction')).toBe('deducted');
    expect(kindOf('loan')).toBe('accrued');
    expect(kindOf('planned_supplement')).toBe('accrued');
    expect(kindOf('premium_contract')).toBe('accrued');
    expect(kindOf('loan_repayment')).toBe('deducted');
    expect(kindOf('bank_fees')).toBe('deducted');
    expect(kindOf('day_rate')).toBe('accrued');
    expect(kindOf('workwear_accrual')).toBe('accrued');
    expect(kindOf('workwear')).toBe('deducted');
    expect(kindOf('alimony')).toBe('deducted');
    expect(kindOf('tmc')).toBe('deducted');
    expect(kindOf('car_rent')).toBe('deducted');
  });
});

describe('суммы с сервера', () => {
  it('по ключу ячейки, числом', () => {
    const amounts = toPaidAmounts([
      { month: '2026-08', item: 'contract', amount: '175000.00' },
      { month: '2026-08', item: 'recalc_prev', amount: '-1500.50' },
    ]);
    expect(amounts.get(paidCellKey('2026-08', 'contract'))).toBe(175000);
    expect(amounts.get(paidCellKey('2026-08', 'recalc_prev'))).toBe(-1500.5);
  });

  it('сумма в ячейке: разряды, копейки только если есть', () => {
    expect(formatPaidAmount(175000).replace(/\s/g, ' ')).toBe('175 000');
    expect(formatPaidAmount(55057.3).replace(/\s/g, ' ')).toBe('55 057,30');
  });
});

describe('видимые строки', () => {
  it('только статьи с суммой; группа без сумм не показывается; порядок — как в ведомости', () => {
    const amounts = toPaidAmounts([
      { month: '2026-08', item: 'travel', amount: '1430.00' },
      { month: '2026-08', item: 'contract', amount: '68095.00' },
      { month: '2026-08', item: 'vacation', amount: '59245.00' },
      { month: '2026-07', item: 'meals', amount: '5248.00' }, // вне окна
    ]);
    const groups = visiblePaidGroups(['2026-08'], amounts);
    expect(groups.map(group => [group.label, group.items.map(item => item.code)])).toEqual([
      [null, ['contract', 'vacation']],
      ['Доп. начисления', ['travel']],
    ]);
  });

  it('сумм нет — строк нет', () => {
    expect(visiblePaidGroups(['2026-08'], toPaidAmounts([]))).toEqual([]);
  });
});

describe('итоги', () => {
  it('бр. Менгбоев, июль, Абдужабборов: начислено и удержано', () => {
    const { byMonth } = paidTotals(['2026-07'], toPaidAmounts([
      { month: '2026-07', item: 'contract', amount: '89176.14' },
      { month: '2026-07', item: 'housing', amount: '160.00' },
      { month: '2026-07', item: 'meals', amount: '5248.00' },
      { month: '2026-07', item: 'workwear', amount: '3050.51' },
    ]));
    expect(byMonth['2026-07']).toEqual({ accrued: 89336.14, deducted: 8298.51 });
  });

  it('удержаний нет — «—», не 0; минусовой перерасчёт уменьшает начислено', () => {
    const { byMonth } = paidTotals(['2026-08'], toPaidAmounts([
      { month: '2026-08', item: 'contract', amount: '100000.00' },
      { month: '2026-08', item: 'planned_supplement', amount: '20000.00' },
      { month: '2026-08', item: 'recalc_prev', amount: '-1500.50' },
    ]));
    expect(byMonth['2026-08']).toEqual({ accrued: 118499.5, deducted: null });
  });

  it('итог окна — сумма месяцев; пустые месяцы — «—»; копейки без ошибки float', () => {
    const { byMonth, overall } = paidTotals(['2026-06', '2026-07', '2026-08'], toPaidAmounts([
      { month: '2026-07', item: 'meals', amount: '0.10' },
      { month: '2026-08', item: 'meals', amount: '0.20' },
      { month: '2026-08', item: 'workwear', amount: '0.00' },
    ]));
    expect(byMonth['2026-06']).toEqual({ accrued: null, deducted: null });
    expect(overall).toEqual({ accrued: null, deducted: 0.3 });
  });

  it('«Итого» статьи — сумма выбранных месяцев; сумм нет — «—»; копейки без ошибки float', () => {
    const amounts = toPaidAmounts([
      { month: '2026-06', item: 'meals', amount: '9.99' },
      { month: '2026-07', item: 'meals', amount: '0.10' },
      { month: '2026-09', item: 'meals', amount: '0.20' },
    ]);
    // Месяцы вразброс: июнь и август в выбор не входят.
    expect(paidItemTotal(['2026-07', '2026-09'], amounts, 'meals')).toBe(0.3);
    expect(paidItemTotal(['2026-07', '2026-09'], amounts, 'contract')).toBeNull();
  });
});

describe('«Расчёты»: месяцы и период сумм', () => {
  it('месяцы окна удержаний — из самих сумм: по возрастанию, без повторов (работает и для «весь период»)', () => {
    expect(paidAmountMonths([
      { month: '2026-08', item: 'meals', amount: '5248.00' },
      { month: '2026-07', item: 'fines', amount: '2000.00' },
      { month: '2026-08', item: 'fines', amount: '0.00' },
    ])).toEqual(['2026-07', '2026-08']);
    expect(paidAmountMonths([])).toEqual([]);
  });

  it('период: выбранные месяцы — как у пикера, пусто или all — «весь период»', () => {
    expect(formatPaidPeriod(['2026-08'])).toBe('август 2026');
    expect(formatPaidPeriod(['2026-07', '2026-08'])).toBe('июль 2026 — август 2026');
    expect(formatPaidPeriod(['2026-05', '2026-08'])).toBe('май 2026, август 2026');
    expect(formatPaidPeriod([])).toBe('весь период');
    expect(formatPaidPeriod('all')).toBe('весь период');
  });

  it('удержания в окне: явный ноль — сумма 0, а не «нет данных»; итог в копейках', () => {
    const months = ['2026-07', '2026-08'];
    const amounts = toPaidAmounts([
      { month: '2026-07', item: 'fines', amount: '0.10' },
      { month: '2026-08', item: 'fines', amount: '0.20' },
      { month: '2026-08', item: 'meals', amount: '0.00' },
    ]);
    expect(paidItemTotal(months, amounts, 'meals')).toBe(0);
    expect(paidTotals(months, amounts).overall).toEqual({ accrued: null, deducted: 0.3 });
  });
});

describe('«История выплат»', () => {
  it('месяцы новые сверху; «К выплате» — начислено минус удержано; статьи — только с суммой за месяц', () => {
    const history = paidHistory([
      { month: '2026-07', item: 'contract', amount: '129630.00' },
      { month: '2026-07', item: 'housing', amount: '4000.00' },
      { month: '2026-07', item: 'travel', amount: '2528.00' },
      { month: '2026-07', item: 'fines', amount: '37.66' },
      { month: '2026-08', item: 'contract', amount: '100000.10' },
      { month: '2026-08', item: 'recalc_prev', amount: '-0.20' },
    ]);
    expect(history.months.map(entry => entry.month)).toEqual(['2026-08', '2026-07']);
    expect(history.months[1].totals).toEqual({ accrued: 136158, deducted: 37.66 });
    expect(history.months[1].payout).toBe(136120.34);
    expect(history.months[0].totals).toEqual({ accrued: 99999.9, deducted: null });
    expect(history.months[0].payout).toBe(99999.9);
    expect(history.months[0].groups.flatMap(group => group.items.map(item => item.code))).toEqual(['contract', 'recalc_prev']);
    expect(history.overall).toEqual({ accrued: 236157.9, deducted: 37.66 });
    expect(history.overallPayout).toBe(236120.24);
  });

  it('годы новые сверху, итоги года — до копейки', () => {
    const history = paidHistory([
      { month: '2025-11', item: 'contract', amount: '0.10' },
      { month: '2025-12', item: 'contract', amount: '0.20' },
      { month: '2025-12', item: 'meals', amount: '0.05' },
      { month: '2026-01', item: 'contract', amount: '1000.00' },
    ]);
    expect(history.years.map(entry => [entry.year, entry.months.map(item => item.month)])).toEqual([
      ['2026', ['2026-01']],
      ['2025', ['2025-12', '2025-11']],
    ]);
    expect(history.years[1].totals).toEqual({ accrued: 0.3, deducted: 0.05 });
    expect(history.years[1].payout).toBe(0.25);
    expect(history.years[0].totals).toEqual({ accrued: 1000, deducted: null });
    expect(history.years[0].payout).toBe(1000);
  });

  it('сумм нет — пусто, «К выплате» — «—»', () => {
    const history = paidHistory([]);
    expect(history.months).toEqual([]);
    expect(history.years).toEqual([]);
    expect(history.overallPayout).toBeNull();
    expect(paidPayout({ accrued: null, deducted: 0 })).toBe(0);
    expect(paidPayout({ accrued: null, deducted: 1800 })).toBe(-1800);
  });
});

describe('окно «Начислено» на «Расчётах»', () => {
  const ROWS = [
    { month: '2026-05', item: 'contract' as const, amount: '1.00' },
    { month: '2026-07', item: 'contract' as const, amount: '89176.14' },
    { month: '2026-07', item: 'housing' as const, amount: '160.00' },
    { month: '2026-07', item: 'meals' as const, amount: '5248.00' },
    { month: '2026-08', item: 'travel' as const, amount: '100.00' },
  ];

  it('окно запроса: выбранные — от первого до последнего, «весь период» — с начала по текущий месяц', () => {
    expect(paidMonthsRange(['2026-08', '2026-05'], '2026-10')).toEqual({ from: '2026-05', to: '2026-08' });
    expect(paidMonthsRange('all', '2026-10')).toEqual({ from: PAYROLL_PAID_ALL_FROM, to: '2026-10' });
    expect(paidMonthsRange([], '2026-10')).toEqual({ from: PAYROLL_PAID_ALL_FROM, to: '2026-10' });
  });

  it('месяцы вразброс — лишние отсекаются; «весь период» — все', () => {
    expect(pickPaidRows(ROWS, ['2026-05', '2026-08']).map(row => row.month)).toEqual(['2026-05', '2026-08']);
    expect(pickPaidRows(ROWS, 'all')).toHaveLength(5);
  });

  it('раздел: начисления без удержаний и наоборот', () => {
    expect(pickPaidKind(ROWS, 'accrued').map(row => row.item)).toEqual(['contract', 'contract', 'housing', 'travel']);
    expect(pickPaidKind(ROWS, 'deducted').map(row => row.item)).toEqual(['meals']);
  });
});
