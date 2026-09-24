import { describe, expect, it } from 'vitest';

import {
  accrualBarPercent,
  accrualPeriodCrossesYear,
  formatAccrualMonthLabel,
  formatAccrualPeriodLong,
  formatAccrualPeriodShort,
  payrollAccrualMonths,
  summarizeAccruals,
} from './payrollAccruals';
import { formatPayrollRubles } from './payrollFormat';

/** Пробелы-разделители разрядов (NBSP) → обычные: так проще сравнивать. */
const plain = (value: string | null): string | null => (value === null ? null : value.replace(/\s/g, ' '));

const MAR_AUG_2026 = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

describe('окно начислений', () => {
  it('шесть закрытых месяцев перед текущим, текущий не входит', () => {
    expect(payrollAccrualMonths('2026-09-24')).toEqual(MAR_AUG_2026);
    expect(payrollAccrualMonths('2026-09-01')).toEqual(MAR_AUG_2026);
  });

  it('через границу года', () => {
    expect(payrollAccrualMonths('2026-02-10')).toEqual(['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
    expect(payrollAccrualMonths('2026-01-15')).toEqual(['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12']);
  });

  it('подпись периода в одном году и через границу года', () => {
    expect(formatAccrualPeriodShort(MAR_AUG_2026)).toBe('мар – авг 2026');
    expect(formatAccrualPeriodLong(MAR_AUG_2026)).toBe('март – август 2026');
    const crossing = payrollAccrualMonths('2026-02-10');
    expect(accrualPeriodCrossesYear(crossing)).toBe(true);
    expect(accrualPeriodCrossesYear(MAR_AUG_2026)).toBe(false);
    expect(formatAccrualPeriodShort(crossing)).toBe('авг 2025 – янв 2026');
    expect(formatAccrualPeriodLong(crossing)).toBe('август 2025 – январь 2026');
  });

  it('май — в именительном падеже', () => {
    expect(formatAccrualPeriodShort(['2026-05', '2026-06'])).toBe('май – июн 2026');
  });

  it('подпись месяца: год только в окне через границу года', () => {
    expect(formatAccrualMonthLabel('2026-05', false)).toBe('Май');
    expect(formatAccrualMonthLabel('2025-12', true)).toBe('Декабрь 2025');
  });
});

describe('итоги начислений', () => {
  it('суммы строками и числами, месяцы вне окна не считаются', () => {
    const summary = summarizeAccruals(MAR_AUG_2026, [
      { month: '2026-03', amount: '118400.50' },
      { month: '2026-04', amount: 124900 },
      { month: '2026-05', amount: 0 },
      { month: '2026-06', amount: null },
      { month: '2026-08', amount: '125000.00' },
      { month: '2026-09', amount: 999999 },
    ]);
    expect(summary.values).toEqual([118400.5, 124900, 0, null, null, 125000]);
    expect(summary.total).toBeCloseTo(368300.5, 2);
    expect(summary.monthsWithData).toBe(4);
    expect(summary.average).toBeCloseTo(92075.125, 3);
    expect(summary.max).toBe(125000);
  });

  it('нет данных ни за один месяц — итога нет', () => {
    for (const accruals of [undefined, null, [], [{ month: '2026-03', amount: null }]]) {
      const summary = summarizeAccruals(MAR_AUG_2026, accruals);
      expect(summary.total).toBeNull();
      expect(summary.average).toBeNull();
      expect(summary.monthsWithData).toBe(0);
      expect(summary.max).toBe(0);
    }
  });

  it('несколько сумм за месяц складываются, сторно уменьшает итог', () => {
    const summary = summarizeAccruals(MAR_AUG_2026, [
      { month: '2026-07', amount: 100000 },
      { month: '2026-07', amount: 20000 },
      { month: '2026-08', amount: -5000 },
    ]);
    expect(summary.values.slice(4)).toEqual([120000, -5000]);
    expect(summary.total).toBe(115000);
    expect(summary.max).toBe(120000);
  });

  it('длина столбика', () => {
    expect(accrualBarPercent(null, 100)).toBe(0);
    expect(accrualBarPercent(0, 100)).toBe(0);
    expect(accrualBarPercent(-10, 100)).toBe(0);
    expect(accrualBarPercent(10, 0)).toBe(0);
    expect(accrualBarPercent(50, 200)).toBe(25);
    expect(accrualBarPercent(300, 200)).toBe(100);
  });

  it('итог в целых рублях', () => {
    expect(plain(formatPayrollRubles(742300.45))).toBe('742 300');
    expect(plain(formatPayrollRubles(96499.5))).toBe('96 500');
    expect(formatPayrollRubles(null)).toBeNull();
    expect(formatPayrollRubles(Number.NaN)).toBeNull();
  });
});
