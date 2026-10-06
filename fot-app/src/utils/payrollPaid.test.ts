import { describe, expect, it } from 'vitest';

import {
  formatPaidAmount,
  paidCellKey,
  paidTotals,
  PAYROLL_PAID_GROUPS,
  toPaidAmounts,
  visiblePaidGroups,
} from './payrollPaid';

const ITEMS = PAYROLL_PAID_GROUPS.flatMap(group => group.items);

describe('статьи', () => {
  it('17 статей без повторов, в порядке ведомости', () => {
    expect(ITEMS).toHaveLength(17);
    expect(new Set(ITEMS.map(item => item.code)).size).toBe(17);
    expect(PAYROLL_PAID_GROUPS.map(group => group.items.map(item => item.label))).toEqual([
      ['По трудовому договору', 'Премиальная', 'Больничный', 'Отпуска'],
      ['Компенсация проживания', 'Проезд', 'Переработка', 'Перерасчёт за предыдущий период',
        'Выходное пособие при увольнении', 'Разовая доплата', 'Плановая доплата', 'Займ'],
      ['Питание', 'Спецодежда', 'Нарушение техники безопасности', 'Штрафы', 'Удержание по исп. листу'],
    ]);
  });

  it('исп. лист — в удержаниях, займ и плановая доплата — в начислениях', () => {
    const kindOf = (code: string) => PAYROLL_PAID_GROUPS.find(group => group.items.some(item => item.code === code))?.kind;
    expect(kindOf('writ_deduction')).toBe('deducted');
    expect(kindOf('loan')).toBe('accrued');
    expect(kindOf('planned_supplement')).toBe('accrued');
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
});
