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
import {
  formatDateShift,
  isAssignmentActiveOnDateInclusive,
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
});
