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
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(),
}));
vi.mock('./timesheet-approval-attachments.service.js', () => ({
  countApprovalAttachments: vi.fn(),
}));

import { evaluateManagerObjMemoRequirement } from './timesheet-approval-weekend-check.service.js';

describe('evaluateManagerObjMemoRequirement', () => {
  it('требование не активно для обычного manager даже при работе в выходные', () => {
    const result = evaluateManagerObjMemoRequirement({
      submitterRoleCode: 'manager',
      weekendWorkDates: ['2026-05-09', '2026-05-10'],
      attachmentCount: 0,
    });
    expect(result).toEqual({ required: false, satisfied: true, weekendWorkDates: [] });
  });

  it('manager_obj без работы в выходные — служебка не нужна', () => {
    const result = evaluateManagerObjMemoRequirement({
      submitterRoleCode: 'manager_obj',
      weekendWorkDates: [],
      attachmentCount: 0,
    });
    expect(result.required).toBe(false);
    expect(result.satisfied).toBe(true);
  });

  it('manager_obj + работа в выходные + нет вложений — блок', () => {
    const result = evaluateManagerObjMemoRequirement({
      submitterRoleCode: 'manager_obj',
      weekendWorkDates: ['2026-05-10', '2026-05-09'],
      attachmentCount: 0,
    });
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(false);
    expect(result.weekendWorkDates).toEqual(['2026-05-09', '2026-05-10']);
  });

  it('manager_obj + работа в выходные + есть вложение — пропускаем', () => {
    const result = evaluateManagerObjMemoRequirement({
      submitterRoleCode: 'manager_obj',
      weekendWorkDates: ['2026-05-10'],
      attachmentCount: 1,
    });
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(true);
  });

  it('admin/super_admin — служебка не требуется', () => {
    const result = evaluateManagerObjMemoRequirement({
      submitterRoleCode: 'admin',
      weekendWorkDates: ['2026-05-10'],
      attachmentCount: 0,
    });
    expect(result.required).toBe(false);
    expect(result.satisfied).toBe(true);
  });
});
