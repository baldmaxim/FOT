import { describe, expect, it } from 'vitest';

import type { IPayrollCalcHoursDay, IPayrollCalcPreliminary, IPayrollNormPlan } from '../services/payrollService';
import { buildHoursDaysTable, isSalaryByHoursCalc, salaryHoursNotes } from './payrollHoursDays';

const nov = (day: number): string => `2026-11-${String(day).padStart(2, '0')}`;
const weekdays = Array.from({ length: 30 }, (_, i) => i + 1).filter(day => ![0, 6].includes(new Date(Date.UTC(2026, 10, day)).getUTCDay()));

// Абдурахманов Б. Х., ноябрь 2026 по 16.11: ЛИНИЯ 10 ч (праздники не учитывает), 21 будний + квота 2 Сб = 230 ч.
const plan: IPayrollNormPlan = {
  days: Object.fromEntries(weekdays.map(day => [nov(day), 600])), saturdays: 2, sundays: 0, quota_minutes: 600,
};
const day = (date: string, paid: number, over: Partial<IPayrollCalcHoursDay> = {}): IPayrollCalcHoursDay => ({
  date, kind: 'workday', paid_minutes: paid, contract_minutes: paid, overtime_minutes: 0, hourly_minutes: 0, ...over,
});
// 12 дней: 04.11 — 11 ч (праздник без вычета обеда), 07.11 и 14.11 — плановые субботы, 12.11 не работал.
const worked = [2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 16].map(d => day(nov(d), 600));
const hoursByDay = [...worked, day(nov(4), 660)].sort((a, b) => a.date.localeCompare(b.date));

const calc = (over: Partial<IPayrollCalcPreliminary> = {}): IPayrollCalcPreliminary => ({
  state: 'preliminary',
  as_of: '2026-11-16',
  norm_days: 23,
  period_from: '2026-11-01',
  period_to: '2026-11-30',
  worked_days: { workday: 12, dayoff: 0 },
  absences: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  lines: [{
    code: 'contract',
    amount: '84174.00',
    hours: 121,
    parts: [{
      kind: 'salary_hours', from: '2026-11-01', to: '2026-11-30', salary: '160000.00', bonus: '0.00', minutes: 7260,
      norm_minutes: 13800, rounding: 'ruble', amount: '84174.00',
    }],
  }],
  deductions: [],
  accrued: '84174.00',
  deducted: '0.00',
  net: '84174.00',
  missing: [],
  hours_by_day: hoursByDay,
  norm_plan: plan,
  ...over,
});

describe('оклад по часам: подписи под «По трудовому договору»', () => {
  it('Абдурахманов: часы табеля за дни и норма из графика — те же 121 и 230 ч, что в формуле', () => {
    expect(isSalaryByHoursCalc(calc())).toBe(true);
    expect(salaryHoursNotes(calc())).toEqual([
      'часы табеля 121 ч за 12 дн.',
      'норма 230 ч = 21 дн. × 10 ч + 2 Сб × 10 ч',
    ]);
  });

  it('не все часы в оклад: переработка и сверх нормы — отдельной строкой', () => {
    const days = [...hoursByDay, day(nov(21), 600, { kind: 'dayoff', contract_minutes: 0, overtime_minutes: 600 }),
      day(nov(17), 720, { contract_minutes: 600 })];
    expect(salaryHoursNotes(calc({ hours_by_day: days }))[1])
      .toBe('в оклад 131 ч; 10 ч — «Переработка»; 2 ч сверх нормы не оплачиваются');
  });

  it('у дней графика разные часы — «209 ч за 21 дн. графика»; без квоты — без «+»', () => {
    const uneven = { ...plan, days: { ...plan.days, [nov(3)]: 540 }, saturdays: 0 };
    const norm = 209 * 60;
    const result = calc({
      norm_plan: uneven,
      lines: [{ ...calc().lines[0], parts: [{ ...calc().lines[0].parts![0], norm_minutes: norm } as never] }],
    });
    expect(salaryHoursNotes(result)[1]).toBe('норма 209 ч = 209 ч за 21 дн. графика');
  });

  it('снимка нет или он не сходится с нормой формулы — норма одной цифрой', () => {
    expect(salaryHoursNotes(calc({ norm_plan: null }))[1]).toBe('норма 230 ч — по графику месяца');
    expect(salaryHoursNotes(calc({ norm_plan: { ...plan, saturdays: 1 } }))[1]).toBe('норма 230 ч — по графику месяца');
  });

  it('день бригады в часы оклада не идёт; расшифровки нет (старый бэкенд) — подписей нет', () => {
    const days = [...hoursByDay, day(nov(17), 600, { kind: 'brigade', contract_minutes: 0 })];
    expect(salaryHoursNotes(calc({ hours_by_day: days }))[0]).toBe('часы табеля 121 ч за 12 дн.');
    expect(salaryHoursNotes(calc({ hours_by_day: undefined }))).toEqual([]);
  });
});

describe('«Часы по дням»', () => {
  it('Абдурахманов: даты нормы и даты с часами; квота, прогул, серые даты после 16.11; итог = формула', () => {
    const table = buildHoursDaysTable(calc());
    expect(table?.hasNorm).toBe(true);
    expect(table?.rows).toHaveLength(23);
    expect(table?.rows.find(row => row.date === nov(4))).toMatchObject({
      label: '04.11 Ср', normMinutes: 600, paidMinutes: 660, contractMinutes: 660, quota: false, future: false,
    });
    expect(table?.rows.find(row => row.date === nov(7))).toMatchObject({ label: '07.11 Сб', normMinutes: 0, quota: true });
    expect(table?.rows.find(row => row.date === nov(12))).toMatchObject({ normMinutes: 600, paidMinutes: null, future: false });
    expect(table?.rows.find(row => row.date === nov(17))).toMatchObject({ normMinutes: 600, paidMinutes: null, future: true });
    expect(table?.quota).toEqual({ label: 'Квота (2 Сб × 10 ч)', minutes: 1200 });
    expect(table?.totals).toEqual({ norm: 13800, paid: 7260, contract: 7260, overtime: 0 });
  });

  it('снимка нет — без «Графика» и квоты, только даты с часами', () => {
    const table = buildHoursDaysTable(calc({ norm_plan: null }));
    expect(table).toMatchObject({ hasNorm: false, quota: null, totals: { norm: null, paid: 7260 } });
    expect(table?.rows).toHaveLength(12);
    expect(table?.rows.every(row => row.normMinutes === null && !row.quota)).toBe(true);
  });

  it('закрытый месяц — серых дат нет; расшифровки нет — таблицы нет', () => {
    const rest: Omit<IPayrollCalcPreliminary, 'state' | 'as_of'> & { as_of?: string } = { ...calc() };
    delete rest.as_of;
    const closed = { ...rest, state: 'closed' as const, quality: 'materialized' as const, basis_ids: [1], version_ids: [1] };
    expect(buildHoursDaysTable(closed)?.rows.some(row => row.future)).toBe(false);
    expect(buildHoursDaysTable(calc({ hours_by_day: undefined }))).toBeNull();
  });
});
