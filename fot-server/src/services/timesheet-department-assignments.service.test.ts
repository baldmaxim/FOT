import { describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const { collectDeptIdsMock } = vi.hoisted(() => ({ collectDeptIdsMock: vi.fn() }));
vi.mock('./skud-shared.service.js', () => ({ collectDeptIds: collectDeptIdsMock }));

import {
  formatDateShift,
  isAssignmentActiveOnDateInclusive,
  isEmployeeAssignedToDepartmentOnDate,
  resolveTimesheetPeriodRange,
} from './timesheet-department-assignments.service.js';

describe('timesheet-department-assignments.service', () => {
  it('resolves FULL, H1 and H2 ranges for a month', () => {
    expect(resolveTimesheetPeriodRange('2026-02', 'FULL')).toEqual({
      half: 'FULL',
      year: 2026,
      month: 2,
      daysInMonth: 28,
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    expect(resolveTimesheetPeriodRange('2026-02', 'H1')).toEqual({
      half: 'H1',
      year: 2026,
      month: 2,
      daysInMonth: 28,
      startDate: '2026-02-01',
      endDate: '2026-02-15',
    });
    expect(resolveTimesheetPeriodRange('2026-02', 'H2')).toEqual({
      half: 'H2',
      year: 2026,
      month: 2,
      daysInMonth: 28,
      startDate: '2026-02-16',
      endDate: '2026-02-28',
    });
  });

  it('treats effective_to as inclusive for historical department access', () => {
    expect(isAssignmentActiveOnDateInclusive('2026-04-01', '2026-04-15', '2026-04-15')).toBe(true);
    expect(isAssignmentActiveOnDateInclusive('2026-04-01', '2026-04-15', '2026-04-16')).toBe(false);
    expect(isAssignmentActiveOnDateInclusive('2026-04-16', null, '2026-04-16')).toBe(true);
  });

  it('shifts dates across month boundaries', () => {
    expect(formatDateShift('2026-04-01', -1)).toBe('2026-03-31');
    expect(formatDateShift('2026-04-30', 1)).toBe('2026-05-01');
  });

  describe('isEmployeeAssignedToDepartmentOnDate — уволенный с затёртым отделом', () => {
    const BRIGADE = 'b9a752a5-4565-4b27-87a7-5cd6db81d0a9';
    const FIRED = 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'; // «Уволенные»

    it('даёт доступ через employee_dismissal_events, когда assignment/snapshot указывают на «Уволенные»', async () => {
      collectDeptIdsMock.mockResolvedValue([BRIGADE]);
      pgQueryOne
        .mockResolvedValueOnce(null) // employee_assignments — нет открытого назначения в бригаду
        .mockResolvedValueOnce({ org_department_id: FIRED }) // snapshot → «Уволенные», не совпадает
        .mockResolvedValueOnce({ exists: true }); // dismissal_events.from_department_id = бригада

      await expect(isEmployeeAssignedToDepartmentOnDate(8730, BRIGADE, '2026-05-21')).resolves.toBe(true);
    });

    it('отказывает, если dismissal-события для бригады нет', async () => {
      collectDeptIdsMock.mockResolvedValue([BRIGADE]);
      pgQueryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ org_department_id: FIRED })
        .mockResolvedValueOnce(null); // dismissal events не нашлись (например дата > dismissal_date)

      await expect(isEmployeeAssignedToDepartmentOnDate(8730, BRIGADE, '2026-06-01')).resolves.toBe(false);
    });
  });
});
