import { describe, expect, it } from 'vitest';

import type { IPayrollCalcClosed, IPayrollCalcLine, IPayrollCalcPreliminary } from '../services/payrollService';
import {
  calcAbsenceLines,
  calcLineAbsence,
  calcLineDaysNote,
  calcLineFormula,
  calcLineLabel,
  calcLinePaidItem,
  calcLines,
  calcMissingNote,
  calcNetTotal,
  isCalcCounted,
  payslipRemainder,
  payslipShow1c,
} from './payrollCalc';
import { formatPaidAmount } from './payrollPaid';

/** Разделитель тысяч у toLocaleString('ru-RU'). */
const NBSP = (1000).toLocaleString('ru-RU').charAt(1);

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

const preliminary = (over: Partial<IPayrollCalcPreliminary> = {}): IPayrollCalcPreliminary => {
  const { lines, absences, worked_days, period_from, period_to, norm_days, deductions, accrued, deducted, net, missing } = closed();
  return {
    state: 'preliminary', as_of: '2026-09-30', lines, absences, worked_days, period_from, period_to, norm_days, deductions,
    accrued, deducted, net, missing, ...over,
  };
};

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

  it('чего не хватает', () => {
    expect(calcMissingNote(['vacation_pay', 'sick_pay'])).toBe('без: отпускные, больничные');
    expect(calcMissingNote(['brigade_no_hours'])).toBe('без: доля бригады — нет учтённых часов');
    expect(calcMissingNote([])).toBeNull();
  });

  it('посчитан ли месяц: закрытый и предварительный — да; не работал, не загружен — нет', () => {
    expect(isCalcCounted(closed())).toBe(true);
    expect(isCalcCounted(preliminary())).toBe(true);
    expect(isCalcCounted({ state: 'not_closed', reason: 'no_period' })).toBe(false);
    expect(isCalcCounted(undefined)).toBe(false);
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

  it('предварительный месяц — как закрытый', () => {
    expect(calcNetTotal([closed({ net: '100.00' }), preliminary({ net: '50.50' })])).toBe(150.5);
  });

  it('хоть один без расчёта, не загружен или с неизвестным итогом — нет итога', () => {
    expect(calcNetTotal([closed(), { state: 'not_closed', reason: 'not_covered' }])).toBeNull();
    expect(calcNetTotal([closed(), undefined])).toBeNull();
    expect(calcNetTotal([closed(), preliminary({ net: null, missing: ['brigade_output'] })])).toBeNull();
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

describe('«К выплате (ФОТ)»: расшифровка строк', () => {
  const salaryPart = {
    kind: 'salary' as const, from: '2026-09-01', to: '2026-09-30', salary: '150000.00', bonus: '0.00', days: 22,
    norm: 22, rounding: 'whole' as const, amount: '150000.00',
  };

  it('оклад одним сегментом — «оклад 150 000,00 × 22 / 22 дн.»; с премиальной — в скобках', () => {
    expect(calcLineFormula({ code: 'contract', amount: '150000.00', parts: [salaryPart] }))
      .toEqual([`оклад 150${NBSP}000,00 × 22 / 22 дн.`]);
    expect(calcLineFormula({ code: 'contract', amount: '1.00', parts: [{ ...salaryPart, salary: '140000.00', bonus: '10000.00' }] }))
      .toEqual([`(оклад 140${NBSP}000,00 + премиальная 10${NBSP}000,00) × 22 / 22 дн.`]);
  });

  it('смена оклада — по подстроке на период с суммой; добор нормы выходами — отдельной подстрокой', () => {
    const line: IPayrollCalcLine = {
      code: 'contract',
      amount: '66666.00',
      days: { worked: 11, norm: 21 },
      filled_dayoffs: 2,
      parts: [
        { ...salaryPart, to: '2026-09-10', salary: '100000.00', days: 8, norm: 21, rounding: 'ruble', amount: '38095.00' },
        { ...salaryPart, from: '2026-09-11', salary: '200000.00', days: 3, norm: 21, rounding: 'ruble', amount: '28571.00' },
      ],
    };
    expect(calcLineFormula(line)).toEqual([
      `с 01.09 по 10.09: оклад 100${NBSP}000,00 × 8 / 21 дн. = 38${NBSP}095,00`,
      `с 11.09 по 30.09: оклад 200${NBSP}000,00 × 3 / 21 дн. = 28${NBSP}571,00`,
      '11 дн. = 9 раб. + 2 вых. (добор нормы)',
    ]);
  });

  it('дневная ставка до копейки; переработка выходами и часами; проезд, проживание, разовая', () => {
    expect(calcLineFormula({ code: 'contract', amount: '130952.36', parts: [{
      ...salaryPart, salary: '250000.00', days: 11, norm: 21, rounding: 'daily_kopeck', daily_rate: '11904.76', amount: '130952.36',
    }] })).toEqual([`оклад 250${NBSP}000,00 / 21 дн. = 11${NBSP}904,76 × 11 дн.`]);
    expect(calcLineFormula({ code: 'overtime', amount: '10000.00', parts: [
      { kind: 'overtime_days', from: '2026-09-01', to: '2026-09-30', salary: '168000.00', days: 1, norm: 21, amount: '8000.00' },
      { kind: 'overtime_hours', from: '2026-09-01', to: '2026-09-30', salary: '168000.00', minutes: 90, norm_minutes: 10_080, amount: '1500.00' },
    ] })).toEqual([
      `1 вых. × 168${NBSP}000,00 / 21 дн. = 8${NBSP}000,00`,
      `1,5 ч × 168${NBSP}000,00 / 168 ч = 1${NBSP}500,00`,
    ]);
    expect(calcLineFormula({ code: 'travel', amount: '2730.00', parts: [{ kind: 'travel', rate: '2730.00', days: 22, norm: 22, amount: '2730.00' }] }))
      .toEqual([`ставка 2${NBSP}730,00 × 22 / 22 дн.`]);
    expect(calcLineFormula({ code: 'housing', amount: '160.00', parts: [{ kind: 'housing', housing: 'dormitory', amount: '160.00' }] }))
      .toEqual(['доплата за общежитие, сумма за месяц']);
    // Проживание по дням (миграция 339): ставка × дни; у квартиры со сменой ставки — только дни.
    expect(calcLineFormula({ code: 'housing', amount: '5670.00', parts: [
      { kind: 'housing', housing: 'apartment', amount: '5670.00', rate: '630.00', days: 9 },
    ] })).toEqual(['квартира: 630,00 × 9 дн.']);
    expect(calcLineFormula({ code: 'housing', amount: '4160.00', parts: [
      { kind: 'housing', housing: 'dormitory', amount: '4160.00', rate: '160.00', days: 26 },
    ] })).toEqual(['доплата за общежитие: 160,00 × 26 дн.']);
    expect(calcLineFormula({ code: 'housing', amount: '19950.00', parts: [
      { kind: 'housing', housing: 'apartment', amount: '19950.00', days: 30 },
    ] })).toEqual(['квартира: 30 дн.']);
    expect(calcLineFormula({ code: 'supplement', amount: '5000.00', parts: [{ kind: 'one_time', amount: '5000.00' }] }))
      .toEqual(['разовые доплаты месяца']);
  });

  it('доля бригады: выработка × КТУ × часы / Σ весов; не внесена, нет часов, ошибка', () => {
    const part = {
      kind: 'brigade' as const, department_id: 'b1', output: '100000.00', ktu_tenths: 15, counted_minutes: 10_595,
      weight: 158_925, total_weight: 259_455, amount: '61234.57',
    };
    expect(calcLineFormula({ code: 'brigade', amount: '61234.57', parts: [part] }))
      .toEqual([`выработка 100${NBSP}000,00 × КТУ 1,5 × 176,58 ч / 432,43 (Σ КТУ × ч бригады) = 61${NBSP}234,57`]);
    expect(calcLineFormula({ code: 'brigade', amount: null, parts: [{ ...part, output: null, amount: null }] }))
      .toEqual(['выработка бригады не внесена']);
    expect(calcLineFormula({ code: 'brigade', amount: null, parts: [{ ...part, total_weight: 0, amount: null }] }))
      .toEqual(['нет учтённых часов бригады']);
    expect(calcLineFormula({ code: 'brigade', amount: null, parts: [{ ...part, amount: null }] }))
      .toEqual(['ошибка расчёта бригады']);
  });

  it('доля бригады по объектам (336): строка на объект с его именем и Σ весов объекта; без часов — одна строка', () => {
    const wave = {
      kind: 'brigade' as const, department_id: 'b1', object_key: 'w', object_name: 'ЖК Wave', output: '228000.00',
      ktu_tenths: 10, counted_minutes: 600, weight: 6000, total_weight: 22_800, amount: '60000.00',
    };
    const stories = { ...wave, object_key: 's', object_name: 'ЖК Stories', output: null, total_weight: 8_400, amount: null };
    expect(calcLineFormula({ code: 'brigade', amount: null, parts: [stories, wave] })).toEqual([
      'ЖК Stories: выработка не внесена',
      `ЖК Wave: выработка 228${NBSP}000,00 × КТУ 1 × 10 ч / 38 (Σ КТУ × ч объекта) = 60${NBSP}000,00`,
    ]);
    const idle = { ...wave, object_key: null, object_name: null, counted_minutes: 0, weight: 0, total_weight: 0, amount: '0.00' };
    expect(calcLineFormula({ code: 'brigade', amount: '0.00', parts: [idle] }))
      .toEqual(['нет учтённых часов на объектах = 0,00']);
  });

  it('старый бэкенд без частей — прежняя подпись дней', () => {
    expect(calcLineFormula({ code: 'contract', amount: '1.00', days: { worked: 22, norm: 22 } })).toEqual(['22 из 22 дн.']);
    expect(calcLineFormula({ code: 'supplement', amount: '1.00' })).toEqual([]);
  });
});

describe('«К выплате (ФОТ)»: отпускные и больничные из 1С', () => {
  // Гринёв, сентябрь 2026: оклад 120 000 + проезд 1 820, отпуск 9 дн. по ведомости «Отпуска» 59 709,13.
  const vacation: IPayrollCalcLine = {
    code: 'vacation',
    amount: '59709.13',
    days: { worked: 9, norm: null },
    parts: [{ kind: 'payout_1c', doc_number: '0000-002319', doc_date: '2026-09-02', amount: '59709.13' }],
  };

  it('строка — после проживания, подпись статьи «Оплачено», сравнение со своей статьёй', () => {
    const calc = closed({ lines: [vacation, ...closed().lines] });
    expect(calcLines(calc).map(line => line.code)).toEqual(['contract', 'travel', 'vacation']);
    expect(calcLineLabel('vacation')).toBe('Отпуска');
    expect(calcLineLabel('sick_leave')).toBe('Больничный');
    expect(calcLinePaidItem(vacation, calc.lines)).toBe('vacation');
  });

  it('расшифровка: дни, затем ведомость; несколько ведомостей — «= сумма»; «Оплачено» — «начислено в 1С»', () => {
    expect(calcLineFormula(vacation)).toEqual(['9 дн.', 'ведомость № 0000-002319 от 02.09.2026']);
    expect(calcLineFormula({
      ...vacation,
      amount: '60709.63',
      parts: [
        { kind: 'payout_1c', doc_number: '0000-002319', doc_date: '2026-09-02', amount: '59709.13' },
        { kind: 'payout_1c', doc_number: '0000-002330', doc_date: '2026-09-20', amount: '1000.50' },
      ],
    })).toEqual([
      '9 дн.',
      `ведомость № 0000-002319 от 02.09.2026 = ${formatPaidAmount(59_709.13)}`,
      `ведомость № 0000-002330 от 20.09.2026 = ${formatPaidAmount(1_000.5)}`,
    ]);
    expect(calcLineFormula({
      code: 'sick_leave', amount: '2000.00', parts: [{ kind: 'paid_1c', amount: '2000.00' }],
    })).toEqual(['начислено в 1С']);
  });

  it('статус отсутствия строки: отпускные — отпуск, больничные — больничный, прочие — нет', () => {
    expect(calcLineAbsence('vacation')).toBe('vacation');
    expect(calcLineAbsence('sick_leave')).toBe('sick');
    expect(calcLineAbsence('contract')).toBeNull();
  });

  it('«Остаток (с НДФЛ)» — с отпускными в итоге ФОТ: 181 529,13 − 195 389,40', () => {
    expect(payslipRemainder(closed({ net: '181529.13' }), 195_389.4)).toBe(-13_860.27);
  });
});

describe('листок: блоки 1С и «Остаток (с НДФЛ)»', () => {
  it('блоки 1С: суммы 1С есть или расчёта нет — показываются; только расчёт — нет', () => {
    expect(payslipShow1c(false, closed())).toBe(false);
    expect(payslipShow1c(false, preliminary())).toBe(false);
    expect(payslipShow1c(true, preliminary())).toBe(true);
    expect(payslipShow1c(false, { state: 'not_closed', reason: 'no_period' })).toBe(true);
    expect(payslipShow1c(false, undefined)).toBe(true);
  });

  it('остаток — итог ФОТ минус перечислено, в копейках: несколько ведомостей, без ведомостей, переплата', () => {
    // Обивальнева, сентябрь: 152 730 − (60 900 + 60 900).
    expect(payslipRemainder(closed({ net: '152730.00' }), 121_800)).toBe(30_930);
    expect(payslipRemainder(preliminary({ net: '0.30' }), 0.1)).toBe(0.2);
    expect(payslipRemainder(closed({ net: '100000.00' }), 0)).toBe(100_000);
    expect(payslipRemainder(closed({ net: '100000.00' }), 100_000.01)).toBe(-0.01);
  });

  it('ведомости не загрузились, итог неизвестен или расчёта нет — остатка нет', () => {
    expect(payslipRemainder(closed(), 'error')).toBeNull();
    expect(payslipRemainder(preliminary({ net: null }), 0)).toBeNull();
    expect(payslipRemainder({ state: 'not_closed', reason: 'no_period' }, 0)).toBeNull();
    expect(payslipRemainder(undefined, 0)).toBeNull();
  });
});
