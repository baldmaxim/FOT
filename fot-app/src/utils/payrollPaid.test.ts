import { describe, expect, it } from 'vitest';

import {
  buildPaidChanges,
  paidCellKey,
  paidTotals,
  parsePaidAmount,
  PAYROLL_PAID_GROUPS,
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
  it('21 статья без повторов, минус только у перерасчёта', () => {
    expect(PAYROLL_PAID_ITEMS).toHaveLength(21);
    expect(new Set(PAYROLL_PAID_ITEMS.map(item => item.code)).size).toBe(21);
    expect(PAYROLL_PAID_ITEMS.filter(item => item.allowNegative).map(item => item.code)).toEqual(['recalc_prev']);
  });

  it('исп. лист — в удержаниях, займ — в начислениях', () => {
    const kindOf = (code: string) => PAYROLL_PAID_GROUPS.find(group => group.items.some(item => item.code === code))?.kind;
    expect(kindOf('writ_deduction')).toBe('deducted');
    expect(kindOf('loan')).toBe('accrued');
    expect(kindOf('housing')).toBe('accrued');
    expect(kindOf('bank_transfer')).toBe('paid');
  });
});

describe('paidTotals', () => {
  const totals = (months: string[], values: Record<string, string>) => paidTotals(months, key => values[key] ?? '');

  it('бр. Менгбоев, июль, Абдужабборов: начислено − удержано = на Л/С (остаток −0,24 — округление)', () => {
    const { byMonth } = totals(['2026-07'], {
      [paidCellKey('2026-07', 'contract')]: '89 176,14',
      [paidCellKey('2026-07', 'housing')]: '160',
      [paidCellKey('2026-07', 'meals')]: '5 248',
      [paidCellKey('2026-07', 'workwear')]: '3 050,51',
      [paidCellKey('2026-07', 'bank_transfer')]: '81 037,87',
    });
    expect(byMonth['2026-07']).toEqual({ accrued: 89336.14, deducted: 8298.51, paid: 81037.87 });
  });

  it('Тендерный отдел, август, Карамышев: удержаний нет — «—», не 0', () => {
    const { byMonth } = totals(['2026-08'], {
      [paidCellKey('2026-08', 'contract')]: '68 095',
      [paidCellKey('2026-08', 'vacation')]: '59 245',
      [paidCellKey('2026-08', 'travel')]: '1 430',
      [paidCellKey('2026-08', 'advance')]: '13 464,19',
      [paidCellKey('2026-08', 'bank_transfer')]: '56 155,17',
      [paidCellKey('2026-08', 'bonus_payout')]: '39 903',
    });
    expect(byMonth['2026-08']).toEqual({ accrued: 128770, deducted: null, paid: 109522.36 });
  });

  it('займ прибавляется, минусовой перерасчёт уменьшает, исп. лист — в удержано', () => {
    const { byMonth } = totals(['2026-08'], {
      [paidCellKey('2026-08', 'contract')]: '100 000',
      [paidCellKey('2026-08', 'loan')]: '20 000',
      [paidCellKey('2026-08', 'recalc_prev')]: '-1 500,50',
      [paidCellKey('2026-08', 'writ_deduction')]: '7 000',
    });
    expect(byMonth['2026-08']).toEqual({ accrued: 118499.5, deducted: 7000, paid: null });
  });

  it('минус не у перерасчёта и кривые ячейки в итог не идут', () => {
    const { byMonth } = totals(['2026-08'], {
      [paidCellKey('2026-08', 'contract')]: '-100',
      [paidCellKey('2026-08', 'bonus')]: 'abc',
      [paidCellKey('2026-08', 'writ_deduction')]: '-100',
      [paidCellKey('2026-08', 'advance')]: '1,005',
    });
    expect(byMonth['2026-08']).toEqual({ accrued: null, deducted: null, paid: null });
  });

  it('итог окна — сумма месяцев; пустые месяцы — «—»; копейки без ошибки float', () => {
    const { byMonth, overall } = totals(['2026-06', '2026-07', '2026-08'], {
      [paidCellKey('2026-07', 'advance')]: '0,1',
      [paidCellKey('2026-08', 'advance')]: '0,2',
      [paidCellKey('2026-08', 'meals')]: '0',
    });
    expect(byMonth['2026-06']).toEqual({ accrued: null, deducted: null, paid: null });
    expect(overall).toEqual({ accrued: null, deducted: 0, paid: 0.3 });
  });

  it('считает по тому, что сейчас в ячейке (несохранённая правка поверх сохранённой)', () => {
    const saved = toPaidValues([{ month: '2026-08', item: 'contract', amount: '175000.00' }]);
    const edits: Record<string, string> = { [paidCellKey('2026-08', 'contract')]: '180 000' };
    const { byMonth } = paidTotals(['2026-08'], key => edits[key] ?? saved[key] ?? '');
    expect(byMonth['2026-08'].accrued).toBe(180000);
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
