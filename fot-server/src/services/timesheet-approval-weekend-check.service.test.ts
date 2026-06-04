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
  countApprovalAttachmentsForApprovals: vi.fn(),
}));
vi.mock('./correction-attachments.service.js', () => ({
  countCorrectionAttachments: vi.fn(),
  listDaysWithTimeCorrectionMemo: vi.fn(),
}));

import {
  evaluateManagerObjMemoRequirement,
  checkWeekendWorkRequirement,
  checkManagerObjWeekendMemoRequirement,
} from './timesheet-approval-weekend-check.service.js';
import { resolveSchedulesForPeriod, isWorkingDay, loadCalendarMonth } from './schedule.service.js';
import { listEmployeeMembershipsForDepartmentPeriod } from './timesheet-department-assignments.service.js';
import { countApprovalAttachmentsForApprovals } from './timesheet-approval-attachments.service.js';
import { countCorrectionAttachments, listDaysWithTimeCorrectionMemo } from './correction-attachments.service.js';

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

describe('checkWeekendWorkRequirement — плановые субботы (5+2)', () => {
  // График с expected_saturdays_per_month=2: каждый день нерабочий (isWorkingDay→false),
  // поэтому Сб попадают в off-set, но первые 2 отработанные субботы — плановые.
  const SCHEDULE_5PLUS2 = {
    expected_saturdays_per_month: 2,
    expected_sundays_per_month: 0,
    respects_holidays: false,
  };

  const setup = (skudSaturdays: string[]) => {
    vi.mocked(listEmployeeMembershipsForDepartmentPeriod).mockResolvedValue([
      { employee_id: 1, transferred_out_date: null, joined_date: null },
    ] as never);
    // resolveSchedulesForPeriod: график на каждый день диапазона (нужно и для
    // getOffDatesByEmployee, и для computeMandatoryExemptions).
    vi.mocked(resolveSchedulesForPeriod).mockImplementation((async (
      emps: { id: number }[],
      start: string,
      end: string,
    ) => {
      const inner = new Map<string, unknown>();
      const cur = new Date(`${start}T00:00:00`);
      const last = new Date(`${end}T00:00:00`);
      while (cur <= last) {
        const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
        inner.set(iso, SCHEDULE_5PLUS2);
        cur.setDate(cur.getDate() + 1);
      }
      return new Map(emps.map(e => [e.id, inner]));
    }) as never);
    vi.mocked(isWorkingDay).mockReturnValue(false);
    vi.mocked(loadCalendarMonth).mockResolvedValue(null as never);
    // 1-й query → attendance_adjustments (пусто), 2-й → skud_daily_summary.
    pgQuery.mockReset();
    pgQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(skudSaturdays.map(date => ({ employee_id: 1, date, total_minutes: 480 })));
  };

  it('ровно 2 отработанные субботы = норма → служебка не требуется', async () => {
    setup(['2026-05-02', '2026-05-16']);
    const result = await checkWeekendWorkRequirement({
      departmentId: 'dept-1',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(result.requires).toBe(false);
    expect(result.weekendWorkDates).toEqual([]);
  });

  it('3-я суббота сверх нормы → служебка требуется только на лишнюю', async () => {
    setup(['2026-05-02', '2026-05-16', '2026-05-23']);
    const result = await checkWeekendWorkRequirement({
      departmentId: 'dept-1',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(result.requires).toBe(true);
    expect(result.weekendWorkDates).toEqual(['2026-05-23']);
  });
});

describe('checkManagerObjWeekendMemoRequirement — служебка на корректировке дня', () => {
  // Один off-день 31.05 с присутствием СКУД (без exemption: expected=0).
  const setupWeekendWork = (correctionFileCount: number, approvalMemo = 0, leaveMemoDays: string[] = []) => {
    vi.mocked(listEmployeeMembershipsForDepartmentPeriod).mockResolvedValue([] as never);
    vi.mocked(resolveSchedulesForPeriod).mockResolvedValue(
      new Map([[1, new Map([['2026-05-31', {} as never]])]]) as never,
    );
    vi.mocked(isWorkingDay).mockReturnValue(false);
    vi.mocked(loadCalendarMonth).mockResolvedValue(null as never);
    vi.mocked(countApprovalAttachmentsForApprovals).mockResolvedValue(approvalMemo as never);
    vi.mocked(countCorrectionAttachments).mockResolvedValue(new Map([[99, correctionFileCount]]) as never);
    vi.mocked(listDaysWithTimeCorrectionMemo).mockResolvedValue(
      new Set(leaveMemoDays.map(d => `1|${d}`)) as never,
    );

    pgQuery.mockReset();
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("status = 'work'")) return [];
      if (sql.includes('FROM skud_daily_summary')) {
        return [{ employee_id: 1, date: '2026-05-31', total_minutes: 480 }];
      }
      if (sql.includes('work_date = ANY')) {
        return [{ id: 99, employee_id: 1, work_date: '2026-05-31', source_type: 'manual', source_id: null }];
      }
      return [];
    });
  };

  const run = () => checkManagerObjWeekendMemoRequirement({
    weekendMemoRequired: true,
    departmentId: null,
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    approvalIds: [],
    employeeIds: [1],
  });

  it('корректировка дня со служебкой → подача разрешена', async () => {
    setupWeekendWork(1);
    const result = await run();
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(true);
  });

  it('корректировка дня без файла и без blanket-служебки → блок', async () => {
    setupWeekendWork(0);
    const result = await run();
    expect(result.required).toBe(true);
    expect(result.satisfied).toBe(false);
    expect(result.weekendWorkDates).toEqual(['2026-05-31']);
  });

  it('blanket-служебка на уровне подачи → подача разрешена', async () => {
    setupWeekendWork(0, 1);
    const result = await run();
    expect(result.satisfied).toBe(true);
  });

  it('файл на time_correction-заявке дня (без файла на корректировке) → подача разрешена', async () => {
    setupWeekendWork(0, 0, ['2026-05-31']);
    const result = await run();
    expect(result.satisfied).toBe(true);
  });
});
