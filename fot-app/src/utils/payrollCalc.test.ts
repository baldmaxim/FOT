import { describe, expect, it } from 'vitest';

import type { IPayrollCalcClosed } from '../services/payrollService';
import {
  calcAbsenceLines,
  calcLineDaysNote,
  calcLineLabel,
  calcLinePaidItem,
  calcLines,
  calcMissingNote,
  calcNetTotal,
  calcSourceNote,
} from './payrollCalc';

const closed = (over: Partial<IPayrollCalcClosed> = {}): IPayrollCalcClosed => ({
  state: 'closed',
  quality: 'materialized',
  basis_ids: [1, 2],
  version_ids: [10, 11],
  norm_days: 22,
  period_from: '2026-09-01',
  period_to: '2026-09-30',
  worked_days: { workday: 22, dayoff: 0 },
  absences: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  lines: [
    { code: 'travel', amount: '2730.00', days: { worked: 22, norm: 22 } },
    { code: 'contract', amount: '250000.00', days: { worked: 22, norm: 22 } },
  ],
  deductions: [],
  accrued: '252730.00',
  deducted: '0.00',
  net: '252730.00',
  missing: [],
  ...over,
});

describe('«К выплате (ФОТ)»: подписи', () => {
  it('строки — как статьи «Оплачено», в порядке листка', () => {
    expect(calcLines(closed()).map(line => calcLineLabel(line.code))).toEqual(['По трудовому договору', 'Проезд']);
  });

  it('дни строки: «22 из 22 дн.», у переработки — выходы', () => {
    expect(calcLineDaysNote({ code: 'contract', amount: '1.00', days: { worked: 22, norm: 22 } })).toBe('22 из 22 дн.');
    expect(calcLineDaysNote({ code: 'overtime', amount: '1.00', days: { worked: 4, norm: 23 } })).toBe('4 вых.');
    expect(calcLineDaysNote({ code: 'overtime', amount: '1.00', days: { worked: 2, norm: 21 }, hours: 6 })).toBe('2 вых. · 6 ч');
    expect(calcLineDaysNote({ code: 'overtime', amount: '1.00', days: { worked: 0, norm: 21 }, hours: 6.5 })).toBe('6,5 ч');
    expect(calcLineDaysNote({ code: 'supplement', amount: '1.00' })).toBeNull();
  });

  it('чего не хватает и источник', () => {
    expect(calcMissingNote(['vacation_pay', 'sick_pay'])).toBe('без: отпускные, больничные');
    expect(calcMissingNote([])).toBeNull();
    expect(calcSourceNote({ state: 'not_closed', reason: 'not_covered' })).toBe('Табель не закрыт');
    expect(calcSourceNote(closed({ quality: 'reconstructed' }))).toBe('Восстановлено по текущим графикам');
    expect(calcSourceNote(closed())).toBeNull();
  });

  it('отсутствия с днями', () => {
    expect(calcAbsenceLines(closed({ absences: { vacation: 14, sick: 0, educational_leave: 0, unpaid: 2 } }))).toEqual([
      { status: 'vacation', label: 'Отпуск', days: 14 },
      { status: 'unpaid', label: 'Без сохранения ЗП', days: 2 },
    ]);
  });
});

describe('«К выплате (ФОТ)»: итог за месяцы', () => {
  it('все месяцы закрыты — сумма в копейках', () => {
    expect(calcNetTotal([closed({ net: '0.10' }), closed({ net: '0.20' })])).toBe(0.3);
  });

  it('хоть один не закрыт или не загружен — нет итога', () => {
    expect(calcNetTotal([closed(), { state: 'not_closed', reason: 'not_covered' }])).toBeNull();
    expect(calcNetTotal([closed(), undefined])).toBeNull();
  });
});

describe('«К выплате (ФОТ)»: доля бригады', () => {
  const brigade = { code: 'brigade' as const, amount: '141818.18', brigade: { ktu: '1.5', hours: 176 } };

  it('подпись, КТУ и часы', () => {
    expect(calcLineLabel('brigade')).toBe('Выработка бригады');
    expect(calcLineDaysNote(brigade)).toBe('КТУ 1,5 · 176 ч');
    expect(calcMissingNote(['brigade_output'])).toBe('без: выработка бригады');
  });

  it('в столбце 1С — «По трудовому договору», если оклада в расчёте нет', () => {
    expect(calcLinePaidItem(brigade, [brigade])).toBe('contract');
    const contract = { code: 'contract' as const, amount: '1.00' };
    expect(calcLinePaidItem(brigade, [contract, brigade])).toBeNull();
    expect(calcLinePaidItem(contract, [contract, brigade])).toBe('contract');
  });
});
