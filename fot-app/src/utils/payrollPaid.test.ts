import { describe, expect, it } from 'vitest';

import {
  buildPaidChanges,
  paidCellKey,
  parsePaidAmount,
  PAYROLL_PAID_ITEMS,
  toPaidValues,
} from './payrollPaid';

const MONTHS = ['2026-07', '2026-08'];

describe('parsePaidAmount', () => {
  it('вставка из отчёта: пробелы, неразрывные пробелы и запятая', () => {
    expect(parsePaidAmount('175 000,00')).toBe(175000);
    expect(parsePaidAmount('2\u00a0730,5')).toBe(2730.5);
    expect(parsePaidAmount('  1430 ')).toBe(1430);
    expect(parsePaidAmount('0')).toBe(0);
  });

  it('пусто — null (ячейку очистили)', () => {
    expect(parsePaidAmount('')).toBeNull();
    expect(parsePaidAmount('   ')).toBeNull();
  });

  it('ошибка — undefined: текст, три знака, две запятые, слишком много', () => {
    for (const raw of ['abc', '1,005', '1,2,3', '12.', '.5', '10000000000']) {
      expect(parsePaidAmount(raw)).toBeUndefined();
    }
  });

  it('минус — только если разрешён', () => {
    expect(parsePaidAmount('-1 500')).toBeUndefined();
    expect(parsePaidAmount('-1 500', true)).toBe(-1500);
  });
});

describe('статьи', () => {
  it('11 статей, минус только у перерасчёта', () => {
    expect(PAYROLL_PAID_ITEMS).toHaveLength(11);
    expect(PAYROLL_PAID_ITEMS.filter(item => item.allowNegative).map(item => item.code)).toEqual(['recalc_prev']);
  });
});

describe('buildPaidChanges', () => {
  const saved = toPaidValues([
    { month: '2026-08', item: 'contract', amount: '175000.00' },
    { month: '2026-08', item: 'travel', amount: '2730.00' },
  ]);

  it('сохранённые суммы — в виде поля ввода', () => {
    expect(saved).toEqual({ '2026-08:contract': '175\u00a0000', '2026-08:travel': '2\u00a0730' });
  });

  it('без правок — пусто', () => {
    expect(buildPaidChanges(MONTHS, saved, {})).toEqual({ changes: [], invalidKeys: [] });
  });

  it('то же число в другой записи — не изменение; новая, изменённая и очищенная — изменения', () => {
    const edits = {
      [paidCellKey('2026-08', 'contract')]: '175 000,00',
      [paidCellKey('2026-07', 'bonus')]: '50000',
      [paidCellKey('2026-08', 'travel')]: '',
      [paidCellKey('2026-07', 'loan')]: '',
    };
    expect(buildPaidChanges(MONTHS, saved, edits)).toEqual({
      changes: [
        { month: '2026-07', item: 'bonus', amount: 50000 },
        { month: '2026-08', item: 'travel', amount: null },
      ],
      invalidKeys: [],
    });
  });

  it('ошибки — в порядке обхода: строки сверху вниз, в строке месяцы слева направо', () => {
    const edits = {
      [paidCellKey('2026-08', 'travel')]: 'x',
      [paidCellKey('2026-08', 'contract')]: '1,005',
      [paidCellKey('2026-07', 'contract')]: '-5',
      [paidCellKey('2026-07', 'recalc_prev')]: '-5',
    };
    expect(buildPaidChanges(MONTHS, saved, edits)).toEqual({
      changes: [{ month: '2026-07', item: 'recalc_prev', amount: -5 }],
      invalidKeys: ['2026-07:contract', '2026-08:contract', '2026-08:travel'],
    });
  });
});
