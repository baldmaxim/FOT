import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import {
  buildBrigadeDistribution,
  centsToMoney,
  countMemberMinutes,
  countedMinutesForDay,
  distributeByWeights,
  ktuToTenths,
  moneyToCents,
  type IBrigadeDayValue,
} from './brigade-salary.calc.js';

// Бр.Аюби: «6/0 (10 ч без обеда)» — пн–сб по 10 ч, вс выходной; суббота — 2 по квоте.
const schedule: IResolvedSchedule = {
  schedule_id: 's-10',
  schedule_type: 'office',
  work_start: '07:00:00',
  work_end: '17:00:00',
  work_hours: 10,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  lunch_minutes: 0,
  respects_holidays: true,
  pattern_type: 'custom',
  expected_saturdays_per_month: 2,
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
  assignment_anchor_date: null,
  source: 'employee',
};

const calendar: IProductionCalendarMonth = {
  year: 2026,
  month: 10,
  norm_days: 22,
  norm_hours: 176,
  holidays: [],
  mandatory_holidays: [],
  pre_holidays: [],
};

const day = (patch: Partial<IBrigadeDayValue>): IBrigadeDayValue => ({
  status: 'work', hours: 0, corrected: false, hours_overridden: false, ...patch,
});

// 2026-10-08 — четверг (рабочий), 2026-10-10 — суббота, 2026-10-11 — воскресенье.
const THURSDAY = '2026-10-08';
const SATURDAY = '2026-10-10';

const minutes = (value: IBrigadeDayValue, date = THURSDAY): number | string => {
  const counted = countedMinutesForDay(value, schedule, date, calendar);
  return 'error' in counted ? counted.error : counted.minutes;
};

describe('countedMinutesForDay', () => {
  it('СКУД сверх графика обрезается: 12 ч при графике 10 ч → 10 ч (Халимзода, 08.10)', () => {
    expect(minutes(day({ hours: 12 }))).toBe(600);
  });

  it('корректировка с часами идёт целиком: 12 ч → 12 ч', () => {
    expect(minutes(day({ hours: 12, corrected: true, hours_overridden: true }))).toBe(720);
  });

  it('меньше графика — по факту', () => {
    expect(minutes(day({ hours: 9.17 }))).toBe(550);
  });

  it('согласованный выход в выходной — факт целиком', () => {
    expect(minutes(day({ hours: 11, corrected: true }), SATURDAY)).toBe(660);
  });

  it('плановая суббота без правки — не больше нормы смены', () => {
    expect(minutes(day({ hours: 11 }), SATURDAY)).toBe(600);
  });

  it('несогласованный выходной приходит нулём и даёт 0', () => {
    expect(minutes(day({ hours: 0 }), SATURDAY)).toBe(0);
  });

  it('РБ и УД — отработанные дни', () => {
    expect(minutes(day({ status: 'sick_worked', hours: 10 }))).toBe(600);
    expect(minutes(day({ status: 'study_day', hours: 8 }))).toBe(480);
  });

  it('прогул, отпуск, больничный — 0; статус важнее часов корректировки', () => {
    expect(minutes(day({ status: 'absent', hours: 0 }))).toBe(0);
    expect(minutes(day({ status: 'sick', hours: 10 }))).toBe(0);
    expect(minutes(day({ status: 'vacation', hours: 10, hours_overridden: true }))).toBe(0);
  });

  it('незнакомый статус — ошибка, а не молчаливый ноль', () => {
    expect(minutes(day({ status: 'mystery', hours: 10 }))).toBe('unknown_status');
  });

  it('нет графика при часах > 0 — ошибка', () => {
    const counted = countedMinutesForDay(day({ hours: 8 }), undefined, THURSDAY, calendar);
    expect(counted).toEqual({ error: 'no_schedule' });
  });
});

describe('countMemberMinutes', () => {
  it('складывает дни и собирает ошибки по датам', () => {
    const days = new Map<string, IBrigadeDayValue>([
      [THURSDAY, day({ hours: 12 })],
      ['2026-10-09', day({ status: 'mystery', hours: 10 })],
      ['2026-10-12', day({ hours: 9 })],
    ]);
    const schedules = new Map([[THURSDAY, schedule], ['2026-10-09', schedule], ['2026-10-12', schedule]]);
    const result = countMemberMinutes(7, days, schedules, calendar);
    expect(result.minutes).toBe(600 + 540);
    expect(result.errors).toEqual([{ employee_id: 7, code: 'unknown_status', date: '2026-10-09' }]);
  });
});

describe('деньги и КТУ', () => {
  it('moneyToCents / centsToMoney без float', () => {
    expect(moneyToCents('1000000.00')).toBe(100000000n);
    expect(moneyToCents('0.29')).toBe(29n);
    expect(moneyToCents('12.5')).toBe(1250n);
    expect(centsToMoney(142857n)).toBe('1428.57');
    expect(centsToMoney(5n)).toBe('0.05');
  });

  it('КТУ в десятых', () => {
    expect(ktuToTenths('1.5')).toBe(15);
    expect(ktuToTenths('0.5')).toBe(5);
    expect(ktuToTenths('2.0')).toBe(20);
  });
});

describe('distributeByWeights', () => {
  it('1 000 000 на 7 равных — Σ ровно выработка, лишние копейки младшим id', () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map(id => ({ employee_id: id, weight: 10n }));
    const shares = distributeByWeights(100000000n, items)!;
    const total = [...shares.values()].reduce((sum, value) => sum + value, 0n);
    expect(total).toBe(100000000n);
    // 100 000 000 / 7 = 14 285 714 ост. 2 → по копейке первым двум.
    expect(shares.get(1)).toBe(14285715n);
    expect(shares.get(2)).toBe(14285715n);
    expect(shares.get(3)).toBe(14285714n);
  });

  it('КТУ 0,5 / 1,3 / 2,0 и разные часы — Σ ровно выработка', () => {
    const items = [
      { employee_id: 10, weight: 5n * 9600n },
      { employee_id: 11, weight: 13n * 10800n },
      { employee_id: 12, weight: 20n * 6000n },
    ];
    const shares = distributeByWeights(33333333n, items)!;
    expect([...shares.values()].reduce((sum, value) => sum + value, 0n)).toBe(33333333n);
  });

  it('нулевые веса — null', () => {
    expect(distributeByWeights(100n, [{ employee_id: 1, weight: 0n }])).toBeNull();
  });
});

describe('buildBrigadeDistribution', () => {
  const members = [
    { employee_id: 1, ktu_tenths: 10, minutes: 12000 },
    { employee_id: 2, ktu_tenths: 15, minutes: 12000 },
  ];

  it('КТУ 1,5 получает в 1,5 раза больше', () => {
    const { state, amounts } = buildBrigadeDistribution(100000n, members, []);
    expect(state).toBe('ok');
    expect(amounts!.get(1)).toBe(40000n);
    expect(amounts!.get(2)).toBe(60000n);
  });

  it('выработка не введена — no_output; 0,00 — всем 0', () => {
    expect(buildBrigadeDistribution(null, members, []).state).toBe('no_output');
    const zero = buildBrigadeDistribution(0n, members, []);
    expect(zero.state).toBe('ok');
    expect([...zero.amounts!.values()]).toEqual([0n, 0n]);
  });

  it('выработка есть, часов нет — nothing_to_distribute', () => {
    const idle = members.map(member => ({ ...member, minutes: 0 }));
    expect(buildBrigadeDistribution(100000n, idle, []).state).toBe('nothing_to_distribute');
  });

  it('ошибка у участника — без долей', () => {
    const result = buildBrigadeDistribution(100000n, members, [{ employee_id: 2, code: 'no_schedule', date: THURSDAY }]);
    expect(result).toEqual({ state: 'error', amounts: null });
  });
});
