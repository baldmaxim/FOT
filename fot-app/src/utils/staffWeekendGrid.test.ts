import { describe, expect, it } from 'vitest';

import type { IStaffWeekendRow } from '../services/staffWeekendService';
import type { TimesheetEntry } from '../types';
import type { IEmployeeApprovalLock, TimesheetResponse } from '../types/timesheet';
import {
  canGoToNextWeekendMonth,
  canGoToPreviousWeekendMonth,
  pickWeekendGridData,
  weekendLockStatus,
  weekendProblemKeys,
  weekendRowBadges,
  weekendVisibleHours,
  weekendZeroHourKeys,
} from './staffWeekendGrid';

const row = (employeeId: number, days: string[]): IStaffWeekendRow => ({
  employee_id: employeeId,
  full_name: `Сотрудник ${employeeId}`,
  position: null,
  days,
});

const entry = (employeeId: number, date: string, hours: number | null, display: number | null = hours): TimesheetEntry => ({
  employee_id: employeeId,
  work_date: date,
  hours_worked: hours,
  display_hours_worked: display,
} as TimesheetEntry);

describe('месяцы вкладки', () => {
  it('назад — до 11 прошлых, вперёд — до текущего', () => {
    expect(canGoToPreviousWeekendMonth('2025-12', '2026-11')).toBe(false);
    expect(canGoToPreviousWeekendMonth('2026-01', '2026-11')).toBe(true);
    expect(canGoToNextWeekendMonth('2026-11', '2026-11')).toBe(false);
    expect(canGoToNextWeekendMonth('2026-10', '2026-11')).toBe(true);
  });
});

describe('weekendProblemKeys', () => {
  it('ключ как у клетки сетки: сотрудник_дата, только дни из списка', () => {
    const keys = weekendProblemKeys([row(1, ['2026-10-04', '2026-10-11']), row(2, ['2026-10-04'])]);
    expect([...keys].sort()).toEqual(['1_2026-10-04', '1_2026-10-11', '2_2026-10-04']);
  });
});

describe('weekendZeroHourKeys', () => {
  it('без часов — клетка «0»: записи нет или часы округляются до 0', () => {
    const ostrioglo = row(1361, ['2026-10-17', '2026-10-31']);
    const nechitaylo = row(1279, ['2026-11-08']);
    const nobody = row(5, ['2026-10-18']);
    const entries = [
      entry(1361, '2026-10-17', null),
      entry(1361, '2026-10-31', 7),
      entry(1279, '2026-11-08', 0.15, 0),
    ];

    const keys = weekendZeroHourKeys(entries, [ostrioglo, nechitaylo, nobody], false);

    expect([...keys].sort()).toEqual(['1279_2026-11-08', '1361_2026-10-17', '5_2026-10-18']);
  });

  it('часы по роли: фактические 0,6 ч — клетка «1», не «без часов»', () => {
    const entries = [entry(1, '2026-10-17', 0.6, 0)];
    expect(weekendZeroHourKeys(entries, [row(1, ['2026-10-17'])], true).size).toBe(0);
    expect(weekendZeroHourKeys(entries, [row(1, ['2026-10-17'])], false).size).toBe(1);
  });
});

describe('weekendRowBadges', () => {
  it('отдельные метки: с часами — «без корр.», клетка 0 — «без часов»; пустых нет', () => {
    const zero = new Set(['1_2026-10-17']);

    expect(weekendRowBadges(row(1, ['2026-10-04', '2026-10-11', '2026-10-17']), zero).map(badge => badge.text))
      .toEqual(['2 без корр.', '1 без часов']);
    expect(weekendRowBadges(row(1, ['2026-10-17']), zero).map(badge => badge.text)).toEqual(['1 без часов']);
    expect(weekendRowBadges(row(2, ['2026-10-04']), zero).map(badge => badge.text)).toEqual(['1 без корр.']);
  });
});

describe('pickWeekendGridData', () => {
  const data = {
    employees: [{ id: 1, full_name: 'Яковлев' }, { id: 2, full_name: 'Абдуллаев' }, { id: 3, full_name: 'Без выходов' }],
    entries: [entry(1, '2026-10-04', 8), entry(2, '2026-10-04', 7), entry(3, '2026-10-04', 6)],
    object_entries: [{ employee_id: 2 }, { employee_id: 3 }],
    employee_stats: [{ employee_id: 1 }, { employee_id: 3 }],
    stats: {},
  } as unknown as TimesheetResponse;

  it('только люди из списка и в порядке списка; записи и статистика — только их', () => {
    const picked = pickWeekendGridData(data, [row(2, ['2026-10-04']), row(1, ['2026-10-04'])]);

    expect(picked.employees.map(employee => employee.id)).toEqual([2, 1]);
    expect(picked.entries.map(item => item.employee_id)).toEqual([1, 2]);
    expect(picked.object_entries.map(item => item.employee_id)).toEqual([2]);
    expect(picked.employee_stats?.map(item => item.employee_id)).toEqual([1]);
  });

  it('человека нет в ответе табеля — строки нет, остальные на месте', () => {
    const picked = pickWeekendGridData(data, [row(99, ['2026-10-04']), row(1, ['2026-10-04'])]);
    expect(picked.employees.map(employee => employee.id)).toEqual([1]);
  });
});

describe('weekendLockStatus', () => {
  const locks: IEmployeeApprovalLock[] = [
    { employee_id: 1, start_date: '2026-10-01', end_date: '2026-10-15', status: 'submitted' },
    { employee_id: 1, start_date: '2026-10-10', end_date: '2026-10-15', status: 'approved' },
    { employee_id: 2, start_date: '2026-10-16', end_date: '2026-10-31', status: 'submitted' },
  ];

  it('утверждённая подача важнее поданной, вне периода и у другого человека замка нет', () => {
    expect(weekendLockStatus(locks, 1, '2026-10-04')).toBe('submitted');
    expect(weekendLockStatus(locks, 1, '2026-10-11')).toBe('approved');
    expect(weekendLockStatus(locks, 1, '2026-10-20')).toBeUndefined();
    expect(weekendLockStatus(locks, 2, '2026-10-04')).toBeUndefined();
  });
});

describe('weekendVisibleHours', () => {
  const entries = [
    entry(1, '2026-10-04', 8.5, 8),
    entry(1, '2026-10-11', 6.25, 6),
    entry(1, '2026-10-05', 10, 10),
    entry(2, '2026-10-04', 3, 3),
    entry(1, '2026-10-18', null, null),
  ];
  const dzhumaev = row(1, ['2026-10-04', '2026-10-11', '2026-10-18']);

  it('сумма только за дни из списка и только этого человека', () => {
    expect(weekendVisibleHours(entries, dzhumaev, true)).toBeCloseTo(14.75);
  });

  it('роль без фактических часов видит те же часы, что в её клетках', () => {
    expect(weekendVisibleHours(entries, dzhumaev, false)).toBeCloseTo(14);
  });

  it('записи нет — ноль, а не ошибка', () => {
    expect(weekendVisibleHours([], dzhumaev, true)).toBe(0);
  });
});
