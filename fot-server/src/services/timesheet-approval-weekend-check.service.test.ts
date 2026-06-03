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
vi.mock('./schedule.service.js', () => ({
  loadCalendarMonth: vi.fn(),
  resolveSchedulesForPeriod: vi.fn(),
  isWorkingDay: vi.fn(),
}));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeMembershipsForDepartmentPeriod: vi.fn(),
}));
vi.mock('./timesheet-approval-attachments.service.js', () => ({
  countApprovalAttachments: vi.fn(),
}));

import {
  evaluateManagerObjMemoRequirement,
  checkWeekendWorkRequirement,
} from './timesheet-approval-weekend-check.service.js';
import { resolveSchedulesForPeriod, isWorkingDay, loadCalendarMonth } from './schedule.service.js';
import { listEmployeeMembershipsForDepartmentPeriod } from './timesheet-department-assignments.service.js';

describe('evaluateManagerObjMemoRequirement', () => {
  it('флаг роли выключен — служебка не требуется даже при работе в выходные', () => {
    const result = evaluateManagerObjMemoRequirement({
      weekendMemoRequired: false,
      weekendWorkDates: ['2026-05-09', '2026-05-10'],
      attachmentCount: 0,
    });
    expect(result).toEqual({ required: false, satisfied: true, weekendWorkDates: [] });
  });

  it('флаг включён, но без работы в выходные — служебка не нужна', () => {
    const result = evaluateManagerObjMemoRequirement({
      weekendMemoRequired: true,
      weekendWorkDates: [],
      attachmentCount: 0,
    });
    expect(result.required).toBe(false);
    expect(result.satisfied).toBe(true);
  });

  it('флаг включён + работа в выходные + нет вложений — блок', () => {
    const result = evaluateManagerObjMemoRequirement({
      weekendMemoRequired: true,
      weekendWorkDates: ['2026-05-10', '2026-05-09'],
      attachmentCount: 0,
    });
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(false);
    expect(result.weekendWorkDates).toEqual(['2026-05-09', '2026-05-10']);
  });

  it('флаг включён + работа в выходные + есть вложение — пропускаем', () => {
    const result = evaluateManagerObjMemoRequirement({
      weekendMemoRequired: true,
      weekendWorkDates: ['2026-05-10'],
      attachmentCount: 1,
    });
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(true);
  });
});

describe('checkWeekendWorkRequirement — окно членства в отделе', () => {
  const setup = (transferredOut: string | null) => {
    vi.mocked(listEmployeeMembershipsForDepartmentPeriod).mockResolvedValue([
      { employee_id: 1, transferred_out_date: transferredOut, joined_date: null },
    ] as never);
    // Единственная дата с графиком — 31 мая (воскресенье), и она нерабочая (выходной).
    vi.mocked(resolveSchedulesForPeriod).mockResolvedValue(
      new Map([[1, new Map([['2026-05-31', {} as never]])]]) as never,
    );
    vi.mocked(isWorkingDay).mockReturnValue(false);
    vi.mocked(loadCalendarMonth).mockResolvedValue(null as never);
    // 1-й query → attendance_adjustments (пусто), 2-й → skud_daily_summary (работа 31.05).
    pgQuery.mockReset();
    pgQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ employee_id: 1, date: '2026-05-31', total_minutes: 480 }]);
  };

  it('работа в выходной ПОСЛЕ даты выхода из отдела не требует служебку', async () => {
    setup('2026-05-24'); // переведён 24.05 → 31.05 уже не его
    const result = await checkWeekendWorkRequirement({
      departmentId: 'dept-1',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(result.requires).toBe(false);
    expect(result.weekendWorkDates).toEqual([]);
  });

  it('работа в выходной В ПРЕДЕЛАХ членства — служебка требуется', async () => {
    setup('2026-06-01'); // ещё числится 31.05
    const result = await checkWeekendWorkRequirement({
      departmentId: 'dept-1',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(result.requires).toBe(true);
    expect(result.weekendWorkDates).toEqual(['2026-05-31']);
  });
});
