import { describe, expect, it } from 'vitest';
import {
  daysInPlanMonth,
  formatPlanDayTooltip,
  formatPlanHours,
  formatPlanMinutes,
  formatPlanPeriods,
  formatPlanWeekendQuota,
  schedulePlanDayNumbers,
} from './schedulePlan';

describe('formatPlanHours', () => {
  it('целые — без дроби, дробные — до 2 знаков, запятая', () => {
    expect(formatPlanHours(10)).toBe('10');
    expect(formatPlanHours(8.5)).toBe('8,5');
    expect(formatPlanHours(7.53)).toBe('7,53');
    expect(formatPlanHours(0)).toBe('0');
  });

  it('минутная норма не тянет хвост: 9541 мин → 159,02, 9540 → 159', () => {
    expect(formatPlanMinutes(9541)).toBe('159,02');
    expect(formatPlanMinutes(9540)).toBe('159');
    expect(formatPlanMinutes(250 * 60)).toBe('250');
    expect(formatPlanHours(159.016666)).toBe('159,02');
  });
});

describe('formatPlanPeriods', () => {
  it('один график — название, несколько — с датами', () => {
    expect(formatPlanPeriods([])).toBe('—');
    expect(formatPlanPeriods([{ schedule_name: 'ЛИНИЯ 10 ч', from: '2026-01-01', to: '2026-12-31' }])).toBe('ЛИНИЯ 10 ч');
    expect(formatPlanPeriods([
      { schedule_name: 'ОФИС', from: '2026-01-01', to: '2026-06-30' },
      { schedule_name: 'ЛИНИЯ', from: '2026-07-01', to: '2026-12-31' },
    ])).toBe('ОФИС — 01.01–30.06 · ЛИНИЯ — 01.07–31.12');
  });
});

describe('formatPlanDayTooltip', () => {
  it('день недели, дата и вид дня', () => {
    expect(formatPlanDayTooltip(2026, 9, { day: 4, hours: 10, kind: 'work' })).toBe('Пт 04.09 — 10 ч');
    expect(formatPlanDayTooltip(2026, 1, { day: 7, hours: 0, kind: 'holiday' })).toBe('Ср 07.01 — праздник');
    expect(formatPlanDayTooltip(2026, 11, { day: 3, hours: 7, kind: 'pre_holiday' })).toBe('Вт 03.11 — предпраздничный, 7 ч');
    expect(formatPlanDayTooltip(2026, 9, { day: 5, hours: 0, kind: 'off' })).toBe('Сб 05.09 — выходной');
  });
});

describe('daysInPlanMonth', () => {
  it('февраль 2026 — 28, декабрь — 31', () => {
    expect(daysInPlanMonth(2026, 2)).toBe(28);
    expect(daysInPlanMonth(2026, 12)).toBe(31);
  });
});

describe('schedulePlanDayNumbers', () => {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

  it('«Весь месяц» — 1–31 в любом месяце табеля', () => {
    expect(schedulePlanDayNumbers(range(1, 31), 31)).toEqual(range(1, 31));
    expect(schedulePlanDayNumbers(range(1, 30), 30)).toEqual(range(1, 31));
    expect(schedulePlanDayNumbers(range(1, 28), 28)).toEqual(range(1, 31));
    expect(schedulePlanDayNumbers(range(1, 29), 29)).toEqual(range(1, 31));
  });

  it('«1–15» — 1–15, «16–конец» — 16–31 (дни 29–31 других месяцев)', () => {
    expect(schedulePlanDayNumbers(range(1, 15), 30)).toEqual(range(1, 15));
    expect(schedulePlanDayNumbers(range(16, 30), 30)).toEqual(range(16, 31));
    expect(schedulePlanDayNumbers(range(16, 28), 28)).toEqual(range(16, 31));
    expect(schedulePlanDayNumbers(range(16, 31), 31)).toEqual(range(16, 31));
  });

  it('пустой период — 1–31', () => {
    expect(schedulePlanDayNumbers([], 30)).toEqual(range(1, 31));
  });
});

describe('formatPlanWeekendQuota', () => {
  it('«Сб / Вс» одним столбцом, обе нулевые — пусто', () => {
    expect(formatPlanWeekendQuota(2, 1)).toBe('2 / 1');
    expect(formatPlanWeekendQuota(2, 0)).toBe('2 / 0');
    expect(formatPlanWeekendQuota(0, 1)).toBe('0 / 1');
    expect(formatPlanWeekendQuota(0, 0)).toBe('');
  });
});
