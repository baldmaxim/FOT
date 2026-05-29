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
