import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';

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

type SummaryRow = {
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  total_minutes?: number | null;
};

type AdjustmentRow = Record<string, unknown>;

const mockedState = vi.hoisted(() => ({
  travelSummary: new Map<string, {
    creditedMinutes: number;
    delayMinutes: number;
    segmentsCount: number;
    problematicSegmentsCount: number;
    objectProblemSegmentsCount: number;
  }>(),
  internalPoints: new Set<string>(),
  scheduleWorkHours: 8,
  scheduleShiftHours: 9,
  isWorkingDay: true,
  needsSkudCheck: false,
  // Rows for tables consumed by buildAttendanceEntries / upsertAttendanceAdjustment
  summaryRows: [] as Array<{ employee_id: number; date: string; first_entry: string | null; last_exit: string | null; total_hours: number | null; total_minutes?: number | null }>,
  adjustmentRows: [] as Array<Record<string, unknown>>,
  userProfileRows: [] as Array<{ id: string; full_name: string }>,
  employeeRows: [] as Array<{ id: number; full_name: string }>,
  // For upsert tests
  adjustmentUpsertResult: null as AdjustmentRow | null,
  objectSchedulesByDate: new Map<string, Map<string, IResolvedSchedule>>(),
  objectAttendanceData: {
    objectEntries: [] as Array<Record<string, unknown>>,
    objectEntriesByEmployeeDate: new Map<number, Map<string, Array<Record<string, unknown>>>>(),
    employeeDistinctObjectKeys: new Map<number, Set<string>>(),
    legacyBlockedDays: new Map<string, string>(),
    rawFallbackSummaries: new Map<number, Map<string, SummaryRow>>(),
  },
}));

vi.mock('./skud-travel.service.js', () => ({
  getTravelHoursSummaryForRange: vi.fn(async () => mockedState.travelSummary),
  travelMinutesToHours: (minutes: number) => Math.round((minutes / 60) * 100) / 100,
}));

vi.mock('./schedule.service.js', () => ({
  getScheduleForDate: vi.fn((schedule?: { work_hours?: number; lunch_minutes?: number }) => ({
    work_hours: schedule?.work_hours ?? mockedState.scheduleWorkHours,
    work_start: '09:00',
    work_end: '18:00',
    lunch_minutes: schedule?.lunch_minutes ?? 0,
  })),
  getShiftDurationHours: vi.fn(() => mockedState.scheduleShiftHours),
  isPreHoliday: vi.fn(() => false),
  isWorkingDay: vi.fn(() => mockedState.isWorkingDay),
  needsSkudCheck: vi.fn(() => mockedState.needsSkudCheck),
}));

vi.mock('./skud-shared.service.js', () => ({
  getInternalAccessPoints: vi.fn(async () => mockedState.internalPoints),
}));

vi.mock('./timesheet-object.service.js', () => ({
  OBJECT_ADJUSTMENT_SOURCE_TYPE: 'manual_object',
  buildObjectAttendanceData: vi.fn(async () => mockedState.objectAttendanceData),
  isMigratedDayLevelAdjustment: (adjustment: { source_type: string; metadata?: Record<string, unknown> | null }) =>
    adjustment.source_type === 'manual_object'
    && adjustment.metadata?.migrated_from_day_level === true,
}));

import {
  buildAttendanceEntries,
  upsertAttendanceAdjustment,
  isWorkRemoteApprovalPair,
} from './attendance.service.js';

function tableFromSql(sql: string): 'skud_daily_summary' | 'attendance_adjustments' | 'user_profiles' | 'employees' | 'unknown' {
  if (/FROM\s+skud_daily_summary\b/i.test(sql)) return 'skud_daily_summary';
  if (/FROM\s+attendance_adjustments\b/i.test(sql)) return 'attendance_adjustments';
  if (/INSERT INTO\s+attendance_adjustments\b/i.test(sql)) return 'attendance_adjustments';
  if (/FROM\s+user_profiles\b/i.test(sql)) return 'user_profiles';
  if (/FROM\s+employees\b/i.test(sql)) return 'employees';
  return 'unknown';
}

describe('attendance.service', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockedState.travelSummary = new Map();
    mockedState.internalPoints = new Set();
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;
    mockedState.isWorkingDay = true;
    mockedState.needsSkudCheck = false;
    mockedState.summaryRows = [];
    mockedState.adjustmentRows = [];
    mockedState.userProfileRows = [];
    mockedState.employeeRows = [];
    mockedState.adjustmentUpsertResult = null;
    mockedState.objectSchedulesByDate = new Map();
    mockedState.objectAttendanceData = {
      objectEntries: [],
      objectEntriesByEmployeeDate: new Map(),
      employeeDistinctObjectKeys: new Map(),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    pgQuery.mockImplementation(async (sql: string) => {
      const table = tableFromSql(sql);
      if (table === 'skud_daily_summary') return mockedState.summaryRows;
      if (table === 'attendance_adjustments') return mockedState.adjustmentRows;
      if (table === 'user_profiles') return mockedState.userProfileRows;
      if (table === 'employees') return mockedState.employeeRows;
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    pgQueryOne.mockImplementation(async (sql: string) => {
      if (/INSERT INTO attendance_adjustments/i.test(sql)) {
        return mockedState.adjustmentUpsertResult;
      }
      throw new Error(`Unexpected queryOne SQL: ${sql}`);
    });
  });

  it('prefers attendance adjustments over daily summary and keeps travel issue metadata without crediting hours', async () => {
    mockedState.travelSummary = new Map([
      ['1_2026-04-01', {
        creditedMinutes: 30,
        delayMinutes: 5,
        segmentsCount: 2,
        problematicSegmentsCount: 1,
        objectProblemSegmentsCount: 1,
      }],
    ]);

    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '09:10:00',
      last_exit: '18:00:00',
      total_hours: 7.5,
      total_minutes: 450,
    }];

    mockedState.adjustmentRows = [{
      id: 10,
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'manual',
      hours_override: 8,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'Manual correction',
      created_by: 'user-1',
      created_at: '2026-04-01T07:00:00.000Z',
      updated_at: '2026-04-01T07:05:00.000Z',
      metadata: {},
    }];

    mockedState.userProfileRows = [{ id: 'user-1', full_name: 'HR Admin' }];

    const dailySchedulesMap = new Map<number, Map<string, IResolvedSchedule>>();
    const calendarMonth = { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth;

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap,
      calendarMonth,
      todayStr: '2026-04-01',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 10,
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'manual',
      hours_worked: 8,
      display_hours_worked: 8,
      travel_minutes_credited: 0,
      travel_hours_credited: 0,
      travel_delay_minutes: 5,
      travel_segments_count: 2,
      travel_problematic_segments: 1,
      is_correction: true,
      corrected_by_name: 'HR Admin',
    });
    expect(result.skudMap.get(1)?.get('2026-04-01')).toEqual({ hours: 7.5, corrected: true });
    expect(result.objectEntries).toEqual([]);
  });

  it('keeps the by-employees day at 0h when a work day is zeroed out (status=work, hours_override=0), ignoring skud hours', async () => {
    mockedState.summaryRows = [{
      employee_id: 1010,
      date: '2026-05-17',
      first_entry: '10:47:43',
      last_exit: '11:50:08',
      total_hours: 1.05,
      total_minutes: 63,
    }];

    mockedState.adjustmentRows = [{
      id: 3579,
      employee_id: 1010,
      work_date: '2026-05-17',
      status: 'work',
      hours_override: 0,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'не согласован рабочий день',
      created_by: 'user-1',
      created_at: '2026-05-18T06:08:42.890Z',
      updated_at: '2026-05-23T11:21:41.972Z',
      metadata: {},
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1010, full_name: 'Луис Дженс Жоаким Матиас' }],
      startDate: '2026-05-17',
      endDate: '2026-05-17',
      dailySchedulesMap: new Map(),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-05-28',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 3579,
      employee_id: 1010,
      work_date: '2026-05-17',
      status: 'work',
      hours_worked: 0,
      display_hours_worked: 0,
      is_correction: true,
    });
  });

  it('зачитывает remote-корректировку с часами в выходной, если она согласована (удалённый выход)', async () => {
    mockedState.isWorkingDay = false; // суббота
    mockedState.adjustmentRows = [{
      id: 5000,
      employee_id: 700,
      work_date: '2026-06-06',
      status: 'remote',
      hours_override: 8,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'Удалённая работа в выходной',
      created_by: 'user-1',
      approval_status: 'approved',
      created_at: '2026-06-06T07:00:00.000Z',
      updated_at: '2026-06-06T07:05:00.000Z',
      metadata: {},
    }];
    const dailySchedulesMap = new Map<number, Map<string, IResolvedSchedule>>([
      [700, new Map([['2026-06-06', { work_hours: 8, lunch_minutes: 0 } as unknown as IResolvedSchedule]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 700, full_name: 'Постоев Евгений' }],
      startDate: '2026-06-06',
      endDate: '2026-06-06',
      dailySchedulesMap,
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-06-08',
    });

    expect(result.entries[0]).toMatchObject({
      id: 5000,
      status: 'remote',
      hours_worked: 8,
      display_hours_worked: 8,
    });
  });

  // «Учебный день» (УД): часы не вводятся вручную, а берутся из нормы графика
  // (ABSENCE_STATUSES_AS_WORKED). В выходной норма 0 (NON_WORK_ADJUSTMENT_STATUSES) —
  // иначе при норме 0 день превратился бы в переработку.
  it('study_day в рабочий день без hours_override → часы = норма графика', async () => {
    mockedState.isWorkingDay = true;
    mockedState.adjustmentRows = [{
      id: 6100,
      employee_id: 800,
      work_date: '2026-07-21',
      status: 'study_day',
      hours_override: null,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'Учебный день',
      created_by: 'user-1',
      approval_status: 'auto_approved',
      created_at: '2026-07-21T07:00:00.000Z',
      updated_at: '2026-07-21T07:00:00.000Z',
      metadata: {},
    }];
    const dailySchedulesMap = new Map<number, Map<string, IResolvedSchedule>>([
      [800, new Map([['2026-07-21', { work_hours: 11, lunch_minutes: 0 } as unknown as IResolvedSchedule]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 800, full_name: 'Учащийся Пётр' }],
      startDate: '2026-07-21',
      endDate: '2026-07-21',
      dailySchedulesMap,
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-07-22',
    });

    expect(result.entries[0]).toMatchObject({
      id: 6100,
      status: 'study_day',
      hours_worked: 11,
      display_hours_worked: 11,
    });
  });

  it('study_day в нерабочий по графику день → 0 часов', async () => {
    mockedState.isWorkingDay = false;
    mockedState.adjustmentRows = [{
      id: 6101,
      employee_id: 800,
      work_date: '2026-07-25',
      status: 'study_day',
      hours_override: null,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'Учебный день',
      created_by: 'user-1',
      approval_status: 'auto_approved',
      created_at: '2026-07-25T07:00:00.000Z',
      updated_at: '2026-07-25T07:00:00.000Z',
      metadata: {},
    }];
    const dailySchedulesMap = new Map<number, Map<string, IResolvedSchedule>>([
      [800, new Map([['2026-07-25', { work_hours: 8, lunch_minutes: 0 } as unknown as IResolvedSchedule]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 800, full_name: 'Учащийся Пётр' }],
      startDate: '2026-07-25',
      endDate: '2026-07-25',
      dailySchedulesMap,
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-07-27',
    });

    expect(result.entries[0]).toMatchObject({ id: 6101, status: 'study_day', hours_worked: 0 });
  });

  it('не зачитывает remote-корректировку в выходной, пока она на согласовании (pending → 0)', async () => {
    mockedState.isWorkingDay = false;
    mockedState.adjustmentRows = [{
      id: 5001,
      employee_id: 700,
      work_date: '2026-06-06',
      status: 'remote',
      hours_override: 8,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'Удалённая работа в выходной',
      created_by: 'user-1',
      approval_status: 'pending',
      created_at: '2026-06-06T07:00:00.000Z',
      updated_at: '2026-06-06T07:05:00.000Z',
      metadata: {},
    }];
    const dailySchedulesMap = new Map<number, Map<string, IResolvedSchedule>>([
      [700, new Map([['2026-06-06', { work_hours: 8, lunch_minutes: 0 } as unknown as IResolvedSchedule]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 700, full_name: 'Постоев Евгений' }],
      startDate: '2026-06-06',
      endDate: '2026-06-06',
      dailySchedulesMap,
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-06-08',
    });

    expect(result.entries[0]).toMatchObject({ id: 5001, status: 'remote', hours_worked: 0 });
  });

  it('заявка remote без явных часов (hours_override=null) в выходной по-прежнему даёт 0', async () => {
    mockedState.isWorkingDay = false;
    mockedState.adjustmentRows = [{
      id: 5002,
      employee_id: 700,
      work_date: '2026-06-06',
      status: 'remote',
      hours_override: null,
      source_type: 'leave_request',
      source_id: '999',
      reason: null,
      created_by: 'user-1',
      approval_status: 'auto_approved',
      created_at: '2026-06-06T07:00:00.000Z',
      updated_at: '2026-06-06T07:05:00.000Z',
      metadata: {},
    }];
    const dailySchedulesMap = new Map<number, Map<string, IResolvedSchedule>>([
      [700, new Map([['2026-06-06', { work_hours: 8, lunch_minutes: 0 } as unknown as IResolvedSchedule]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 700, full_name: 'Постоев Евгений' }],
      startDate: '2026-06-06',
      endDate: '2026-06-06',
      dailySchedulesMap,
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-06-08',
    });

    expect(result.entries[0]).toMatchObject({ id: 5002, status: 'remote', hours_worked: 0 });
  });

  it('сосуществование work+remote: одна entry=remote с часами, companion = согласованный выход', async () => {
    mockedState.isWorkingDay = false; // суббота
    mockedState.adjustmentRows = [
      {
        id: 6001, employee_id: 700, work_date: '2026-06-06', status: 'work',
        hours_override: null, source_type: 'leave_request', source_id: '999',
        reason: 'Работа в выходной', created_by: 'user-1', approval_status: 'approved',
        approved_by: 'user-9',
        created_at: '2026-06-05T18:49:00.000Z', updated_at: '2026-06-05T18:49:00.000Z', metadata: {},
      },
      {
        id: 6002, employee_id: 700, work_date: '2026-06-06', status: 'remote',
        hours_override: 8, source_type: 'manual', source_id: 'manual',
        reason: 'Удалённая работа', created_by: 'user-1', approval_status: 'auto_approved',
        created_at: '2026-06-06T09:00:00.000Z', updated_at: '2026-06-06T09:00:00.000Z', metadata: {},
      },
    ];
    mockedState.userProfileRows = [{ id: 'user-9', full_name: 'Согласующий Н. Н.' }];
    const dailySchedulesMap = new Map<number, Map<string, IResolvedSchedule>>([
      [700, new Map([['2026-06-06', { work_hours: 8, lunch_minutes: 0 } as unknown as IResolvedSchedule]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 700, full_name: 'Постоев Евгений' }],
      startDate: '2026-06-06',
      endDate: '2026-06-06',
      dailySchedulesMap,
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-06-08',
    });

    // Одна авторитетная запись на день — remote (manual приоритетнее leave_request).
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 6002,
      status: 'remote',
      hours_worked: 8,
      source_type: 'manual',
    });
    // Companion — согласованный выход с человекочитаемым согласующим.
    expect(result.entries[0].companion_work_request).toMatchObject({
      id: 6001,
      approval_status: 'approved',
      approved_by_name: 'Согласующий Н. Н.',
    });
  });

  it('isWorkRemoteApprovalPair: исключение строго по комбинации source_type+status', () => {
    // Нужная пара (в обе стороны) — не вытесняется.
    expect(isWorkRemoteApprovalPair('manual', 'remote', 'leave_request', 'work')).toBe(true);
    expect(isWorkRemoteApprovalPair('leave_request', 'work', 'manual', 'remote')).toBe(true);
    // Несовместимые комбинации — вытесняются как раньше.
    expect(isWorkRemoteApprovalPair('manual', 'work', 'leave_request', 'remote')).toBe(false);
    expect(isWorkRemoteApprovalPair('leave_request', 'remote', 'manual', 'work')).toBe(false);
    expect(isWorkRemoteApprovalPair('manual', 'remote', 'leave_request', 'vacation')).toBe(false);
    expect(isWorkRemoteApprovalPair('leave_request', 'vacation', 'manual', 'remote')).toBe(false);
  });

  it('adds credited travel minutes (within limit) to summary hours and exposes delay metadata', async () => {
    mockedState.travelSummary = new Map([
      ['1_2026-04-01', {
        creditedMinutes: 45,
        delayMinutes: 20,
        segmentsCount: 1,
        problematicSegmentsCount: 1,
        objectProblemSegmentsCount: 0,
      }],
    ]);

    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '09:00:00',
      last_exit: '18:00:00',
      total_hours: 8,
      total_minutes: 480,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map(),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 8.75,
      display_hours_worked: 8.75,
      base_hours_worked: 8,
      travel_minutes_credited: 45,
      travel_hours_credited: 0.75,
      travel_delay_minutes: 20,
      travel_problematic_segments: 1,
    });
    expect(result.objectEntries).toEqual([]);
  });

  it('builds a work entry from raw skud events when daily summary is missing', async () => {
    mockedState.needsSkudCheck = true;

    mockedState.objectAttendanceData.rawFallbackSummaries = new Map([
      [1, new Map([['2026-04-01', {
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '18:00:00',
        total_hours: 9,
        total_minutes: 540,
      }]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-03',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'work',
      hours_worked: 8,
      display_hours_worked: 8,
      base_hours_worked: 9,
      first_entry: '09:00:00',
      last_exit: '18:00:00',
      is_correction: false,
    });
    expect(result.skudMap.get(1)?.get('2026-04-01')).toEqual({ hours: 8, corrected: false });
  });

  it('builds a work entry from raw skud events even when includeObjectDetails is false (employees view)', async () => {
    mockedState.needsSkudCheck = true;

    mockedState.objectAttendanceData.rawFallbackSummaries = new Map([
      [2502, new Map([['2026-05-04', {
        employee_id: 2502,
        date: '2026-05-04',
        first_entry: '08:25:44',
        last_exit: '17:42:27',
        total_hours: 9.28,
        total_minutes: 557,
      }]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 2502, full_name: 'Фетисова Александра Александровна' }],
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      dailySchedulesMap: new Map([
        [2502, new Map([['2026-05-04', { lunch_minutes: 70, work_hours: 7.83 } as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 19 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-05-08',
      includeObjectDetails: false,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 2502,
      work_date: '2026-05-04',
      status: 'work',
      first_entry: '08:25:44',
      last_exit: '17:42:27',
      is_correction: false,
    });
    expect(result.entries[0].hours_worked).toBeGreaterThan(0);
  });

  it('synthesizes a day-level entry for an object-only correction day when synthesizeObjectOnlyDays=true (#3, employees view)', async () => {
    // Объектная корректировка (manual_object) на выходной без СКУД и без day-level записи.
    mockedState.isWorkingDay = false;
    mockedState.summaryRows = [];
    mockedState.adjustmentRows = [{
      id: 77,
      employee_id: 1833,
      work_date: '2026-05-16',
      status: 'manual',
      hours_override: 6,
      source_type: 'manual_object',
      source_id: 'obj-1',
      reason: 'Объектная корректировка',
      created_by: 'user-1',
      created_at: '2026-05-16T07:00:00.000Z',
      updated_at: '2026-05-16T07:05:00.000Z',
      metadata: { object_id: 'obj-1', object_name: 'Объект' },
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1833, full_name: 'Узун Андрей Иванович' }],
      startDate: '2026-05-16',
      endDate: '2026-05-16',
      dailySchedulesMap: new Map(),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 19 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-05-20',
      includeObjectDetails: true,
      synthesizeObjectOnlyDays: true,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 77,
      employee_id: 1833,
      work_date: '2026-05-16',
      status: 'work',
      hours_worked: 6,
      is_correction: true,
    });
  });

  it('does NOT synthesize the object-only correction day on the default path (payroll/export untouched, #3 guard)', async () => {
    // Тот же день, но без synthesizeObjectOnlyDays (как у payslip/export/dashboard):
    // дневной записи быть не должно — иначе день начал бы считаться отработанным в зарплате.
    mockedState.isWorkingDay = false;
    mockedState.summaryRows = [];
    mockedState.adjustmentRows = [{
      id: 77,
      employee_id: 1833,
      work_date: '2026-05-16',
      status: 'manual',
      hours_override: 6,
      source_type: 'manual_object',
      source_id: 'obj-1',
      reason: 'Объектная корректировка',
      created_by: 'user-1',
      created_at: '2026-05-16T07:00:00.000Z',
      updated_at: '2026-05-16T07:05:00.000Z',
      metadata: { object_id: 'obj-1', object_name: 'Объект' },
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1833, full_name: 'Узун Андрей Иванович' }],
      startDate: '2026-05-16',
      endDate: '2026-05-16',
      dailySchedulesMap: new Map(),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 19 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-05-20',
      includeObjectDetails: true,
      // synthesizeObjectOnlyDays не задан → по умолчанию false
    });

    expect(result.entries).toEqual([]);
  });

  it('marks a scheduled skud day as absent when both summary and raw events are missing', async () => {
    mockedState.needsSkudCheck = true;

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-03',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'absent',
      hours_worked: 0,
      display_hours_worked: 0,
      base_hours_worked: 0,
      first_entry: null,
      last_exit: null,
      is_correction: false,
    });
  });

  it('skips empty skud_daily_summary row on a non-working day (no bogus absent on weekend)', async () => {
    mockedState.isWorkingDay = false;
    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-04',
      first_entry: null,
      last_exit: null,
      total_hours: null,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-04',
      endDate: '2026-04-04',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-04', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-06',
    });

    expect(result.entries).toEqual([]);
  });

  it('still records actual presence on a non-working day (employee came in on Saturday)', async () => {
    mockedState.isWorkingDay = false;
    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-04',
      first_entry: '10:00:00',
      last_exit: '14:00:00',
      total_hours: 4,
      total_minutes: 240,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-04',
      endDate: '2026-04-04',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-04', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-06',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-04',
      status: 'work',
      first_entry: '10:00:00',
      last_exit: '14:00:00',
    });
  });

  it('keeps absent adjustment intact when day has object entries (does not overwrite status/hours)', async () => {
    const objectEntry = {
      adjustment_id: null,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 6,
      display_hours_worked: 6,
      base_hours_worked: 6,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [objectEntry],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [objectEntry]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '09:00:00',
      last_exit: '15:00:00',
      total_hours: 6,
      total_minutes: 360,
    }];

    mockedState.adjustmentRows = [{
      id: 42,
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'absent',
      hours_override: null,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'Сотрудник не вышел',
      created_by: 'user-1',
      created_at: '2026-04-01T07:00:00.000Z',
      updated_at: '2026-04-01T07:05:00.000Z',
      metadata: {},
    }];

    mockedState.userProfileRows = [{ id: 'user-1', full_name: 'HR Admin' }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 42,
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'absent',
      hours_worked: 8,
      display_hours_worked: 8,
      is_correction: true,
    });
  });

  it('writes attendance adjustments into canonical attendance_adjustments table', async () => {
    mockedState.adjustmentUpsertResult = {
      id: 99,
      employee_id: 7,
      work_date: '2026-04-05',
      status: 'manual',
      hours_override: 6,
    };

    const result = await upsertAttendanceAdjustment({
      employee_id: 7,
      work_date: '2026-04-05',
      status: 'manual',
      hours_override: 6,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'Legacy fallback',
      created_by: 'user-1',
    });

    expect(result).toMatchObject({
      id: 99,
      employee_id: 7,
      work_date: '2026-04-05',
      status: 'manual',
    });
    expect(pgQueryOne).toHaveBeenCalledOnce();
    const [sql] = pgQueryOne.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO attendance_adjustments/i);
    expect(sql).toMatch(/ON CONFLICT \(employee_id, work_date, source_type, source_id\)/i);
  });

  it('reconciles summary hours with backend object rows even for a single object day', async () => {
    const singleObjectEntry = {
      adjustment_id: null,
      employee_id: 1,
      work_date: '2026-04-02',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 8,
      display_hours_worked: 8,
      base_hours_worked: 8,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [singleObjectEntry],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-02', [singleObjectEntry]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-02',
      first_entry: '09:00:00',
      last_exit: '17:02:00',
      total_hours: 8.03,
      total_minutes: 482,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-02',
      endDate: '2026-04-02',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-02', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-02',
    });

    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-02',
      hours_worked: 8,
      display_hours_worked: 8,
      base_hours_worked: 8,
      object_detail_mode: 'none',
      object_detail_count: 0,
    });
  });

  it('proportionally caps object hours when actual total exceeds shift length', async () => {
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;

    const objectEntryA = {
      adjustment_id: 1,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 6,
      display_hours_worked: 6,
      base_hours_worked: 6,
      is_correction: false,
    };
    const objectEntryB = {
      adjustment_id: 2,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-b',
      object_id: 'obj-b',
      object_name: 'Объект B',
      hours_worked: 5,
      display_hours_worked: 5,
      base_hours_worked: 5,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [objectEntryA, objectEntryB],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [objectEntryA, objectEntryB]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a', 'obj-b'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '09:00:00',
      last_exit: '20:00:00',
      total_hours: 11,
      total_minutes: 660,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      displayMode: 'capped_to_schedule',
    });

    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 9,
      display_hours_worked: 9,
      base_hours_worked: 9,
      first_entry: null,
      last_exit: null,
      object_detail_mode: 'available',
    });

    const objA = result.objectEntries.find(entry => entry.object_key === 'obj-a')!;
    const objB = result.objectEntries.find(entry => entry.object_key === 'obj-b')!;
    expect(objA.display_hours_worked).toBeCloseTo(6 * 9 / 11, 2);
    expect(objA.hours_worked).toBe(objA.display_hours_worked);
    expect(objA.base_hours_worked).toBe(objA.display_hours_worked);
    expect(objB.display_hours_worked).toBeCloseTo(9 - objA.display_hours_worked, 2);
    expect(objB.hours_worked).toBe(objB.display_hours_worked);
    expect(objA.display_hours_worked + objB.display_hours_worked).toBeCloseTo(9, 2);
  });

  it('keeps actual object hours when total is within shift length', async () => {
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;

    const objectEntryA = {
      adjustment_id: 1,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 3,
      display_hours_worked: 3,
      base_hours_worked: 3,
      is_correction: false,
    };
    const objectEntryB = {
      adjustment_id: 2,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-b',
      object_id: 'obj-b',
      object_name: 'Объект B',
      hours_worked: 4,
      display_hours_worked: 4,
      base_hours_worked: 4,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [objectEntryA, objectEntryB],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [objectEntryA, objectEntryB]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a', 'obj-b'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '10:00:00',
      last_exit: '17:00:00',
      total_hours: 7,
      total_minutes: 420,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      displayMode: 'capped_to_schedule',
    });

    expect(result.entries[0]).toMatchObject({
      hours_worked: 7,
      display_hours_worked: 7,
      base_hours_worked: 7,
      first_entry: null,
      last_exit: null,
    });

    const objA = result.objectEntries.find(entry => entry.object_key === 'obj-a')!;
    const objB = result.objectEntries.find(entry => entry.object_key === 'obj-b')!;
    expect(objA.display_hours_worked).toBe(3);
    expect(objB.display_hours_worked).toBe(4);
  });

  it('вычитает обед из дневного итога по объектам (полный день: 9ч присутствия − обед = 8ч, не 9ч)', async () => {
    // Регресс: раньше дневной итог перезаписывался сырой суммой объектов (без обеда) → 9ч.
    // Теперь итог = lunch-adjusted summary (8ч), объекты лишь распределяют его пропорц. сырью.
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;

    const objectEntryA = {
      adjustment_id: 1, employee_id: 1, work_date: '2026-04-01',
      object_key: 'obj-a', object_id: 'obj-a', object_name: 'ЖК A',
      hours_worked: 5, display_hours_worked: 5, base_hours_worked: 5, is_correction: false,
    };
    const objectEntryB = {
      adjustment_id: 2, employee_id: 1, work_date: '2026-04-01',
      object_key: 'obj-b', object_id: 'obj-b', object_name: 'ЖК B',
      hours_worked: 4, display_hours_worked: 4, base_hours_worked: 4, is_correction: false,
    };
    mockedState.objectAttendanceData = {
      objectEntries: [objectEntryA, objectEntryB],
      objectEntriesByEmployeeDate: new Map([[1, new Map([['2026-04-01', [objectEntryA, objectEntryB]]])]]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a', 'obj-b'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
    mockedState.summaryRows = [{
      employee_id: 1, date: '2026-04-01',
      first_entry: '09:00:00', last_exit: '18:00:00',
      total_hours: 9, total_minutes: 540,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01', endDate: '2026-04-01',
      // график с обедом 60 мин → нетто 8ч
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', { lunch_minutes: 60, work_hours: 8 } as unknown as IResolvedSchedule]])]]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    });

    // Дневной итог — с обедом (8ч), НЕ сырые 9ч.
    expect(result.entries[0].hours_worked).toBeCloseTo(8, 2);
    expect(result.entries[0].base_hours_worked).toBeCloseTo(8, 2);
    expect(result.entries[0].display_hours_worked).toBeCloseTo(8, 2);

    // Инвариант: сумма по объектам == дневному итогу.
    const objA = result.objectEntries.find(entry => entry.object_key === 'obj-a')!;
    const objB = result.objectEntries.find(entry => entry.object_key === 'obj-b')!;
    expect(objA.display_hours_worked + objB.display_hours_worked).toBeCloseTo(8, 2);
    // Пропорция сырья сохранена: A(5) > B(4).
    expect(objA.display_hours_worked).toBeGreaterThan(objB.display_hours_worked);
  });

  it('паритет: «по объектам» и «по сотрудникам» дают одинаковый дневной итог с обедом', async () => {
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;
    const summary = [{
      employee_id: 1, date: '2026-04-01',
      first_entry: '09:00:00', last_exit: '18:00:00',
      total_hours: 9, total_minutes: 540,
    }];
    const baseParams = {
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01', endDate: '2026-04-01',
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', { lunch_minutes: 60, work_hours: 8 } as unknown as IResolvedSchedule]])]]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    };

    // «по сотрудникам»: нет объектной разбивки.
    mockedState.summaryRows = summary;
    const byEmployees = await buildAttendanceEntries({ ...baseParams });

    // «по объектам»: один объект на весь день.
    const objectEntry = {
      adjustment_id: 1, employee_id: 1, work_date: '2026-04-01',
      object_key: 'obj-a', object_id: 'obj-a', object_name: 'ЖК A',
      hours_worked: 9, display_hours_worked: 9, base_hours_worked: 9, is_correction: false,
    };
    mockedState.objectAttendanceData = {
      objectEntries: [objectEntry],
      objectEntriesByEmployeeDate: new Map([[1, new Map([['2026-04-01', [objectEntry]]])]]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
    mockedState.summaryRows = summary;
    const byObjects = await buildAttendanceEntries({ ...baseParams });

    expect(byObjects.entries[0].hours_worked).toBeCloseTo(byEmployees.entries[0].hours_worked!, 2);
    expect(byEmployees.entries[0].hours_worked).toBeCloseTo(8, 2);
  });

  it('переработка с обедом всё ещё режется под смену (факт 10ч с обедом, display 9ч)', async () => {
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;
    const objectEntryA = {
      adjustment_id: 1, employee_id: 1, work_date: '2026-04-01',
      object_key: 'obj-a', object_id: 'obj-a', object_name: 'ЖК A',
      hours_worked: 6, display_hours_worked: 6, base_hours_worked: 6, is_correction: false,
    };
    const objectEntryB = {
      adjustment_id: 2, employee_id: 1, work_date: '2026-04-01',
      object_key: 'obj-b', object_id: 'obj-b', object_name: 'ЖК B',
      hours_worked: 5, display_hours_worked: 5, base_hours_worked: 5, is_correction: false,
    };
    mockedState.objectAttendanceData = {
      objectEntries: [objectEntryA, objectEntryB],
      objectEntriesByEmployeeDate: new Map([[1, new Map([['2026-04-01', [objectEntryA, objectEntryB]]])]]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a', 'obj-b'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
    mockedState.summaryRows = [{
      employee_id: 1, date: '2026-04-01',
      first_entry: '08:00:00', last_exit: '19:00:00',
      total_hours: 11, total_minutes: 660,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01', endDate: '2026-04-01',
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', { lunch_minutes: 60, work_hours: 8 } as unknown as IResolvedSchedule]])]]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      // actual: факт = нетто 10ч (11 − обед 60м), display урезан под смену 9ч.
    });

    // Факт = 10ч (обед вычтен из 11ч), НЕ 11ч; display урезан до 9ч.
    expect(result.entries[0].hours_worked).toBeCloseTo(10, 2);
    expect(result.entries[0].display_hours_worked).toBeCloseTo(9, 2);
  });

  it('график без обеда (lunch_minutes=0) не сокращается: итог == сырое присутствие', async () => {
    mockedState.scheduleWorkHours = 9;
    mockedState.scheduleShiftHours = 9;
    const objectEntry = {
      adjustment_id: 1, employee_id: 1, work_date: '2026-04-01',
      object_key: 'obj-a', object_id: 'obj-a', object_name: 'Объект ночь',
      hours_worked: 9, display_hours_worked: 9, base_hours_worked: 9, is_correction: false,
    };
    mockedState.objectAttendanceData = {
      objectEntries: [objectEntry],
      objectEntriesByEmployeeDate: new Map([[1, new Map([['2026-04-01', [objectEntry]]])]]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
    mockedState.summaryRows = [{
      employee_id: 1, date: '2026-04-01',
      first_entry: '09:00:00', last_exit: '18:00:00',
      total_hours: 9, total_minutes: 540,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Студент' }],
      startDate: '2026-04-01', endDate: '2026-04-01',
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', { lunch_minutes: 0, work_hours: 9 } as unknown as IResolvedSchedule]])]]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    });

    expect(result.entries[0].hours_worked).toBeCloseTo(9, 2);
    expect(result.entries[0].display_hours_worked).toBeCloseTo(9, 2);
  });

  it('явная объектная правка-переработка авторитетна: не режется под смену (actual и capped)', async () => {
    // Кейс Тошева: график 12ч, табельщица проставила 13ч объектной правкой (manual_object,
    // is_correction). Начальник участка («урезано»-роль) должен видеть 13ч (display), и в
    // зарплате (capped_to_schedule) тоже 13ч — как у day-level правок.
    mockedState.scheduleWorkHours = 12;
    mockedState.scheduleShiftHours = 12;

    const correctionObject = {
      adjustment_id: 99,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'ЖК Alia',
      hours_worked: 13,
      display_hours_worked: 13,
      base_hours_worked: 13,
      is_correction: true,
    };

    const makeObjectData = () => ({
      objectEntries: [{ ...correctionObject }],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [{ ...correctionObject }]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    });
    const summary = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '07:00:00',
      last_exit: '20:00:00',
      total_hours: 12,
      total_minutes: 720,
    }];

    const baseParams = {
      employees: [{ id: 1, full_name: 'Тошев А.Х.' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', {} as IResolvedSchedule]])]]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    };

    // actual (интерактивный табель): факт и display = 13.
    mockedState.objectAttendanceData = makeObjectData();
    mockedState.summaryRows = summary;
    const actual = await buildAttendanceEntries({ ...baseParams });
    expect(actual.entries[0]).toMatchObject({ hours_worked: 13, display_hours_worked: 13 });

    // capped_to_schedule (зарплата/экспорт): тоже 13, без обрезки под 12.
    mockedState.objectAttendanceData = makeObjectData();
    mockedState.summaryRows = summary;
    const capped = await buildAttendanceEntries({ ...baseParams, displayMode: 'capped_to_schedule' });
    expect(capped.entries[0]).toMatchObject({ hours_worked: 13, display_hours_worked: 13 });
  });

  it('контроль: сырые СКУД-часы сверх графика по-прежнему режутся под смену', async () => {
    // Без правки (is_correction=false) переработка по СКУД остаётся урезанной для «урезано»-роли.
    mockedState.scheduleWorkHours = 12;
    mockedState.scheduleShiftHours = 12;

    const skudObject = {
      adjustment_id: 1,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'ЖК Alia',
      hours_worked: 13,
      display_hours_worked: 13,
      base_hours_worked: 13,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [skudObject],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [skudObject]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '07:00:00',
      last_exit: '20:00:00',
      total_hours: 13,
      total_minutes: 780,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', {} as IResolvedSchedule]])]]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      // actual: факт сохранён, display урезан под 12.
    });

    expect(result.entries[0]).toMatchObject({ hours_worked: 13, display_hours_worked: 12 });
  });

  it('caps and masks actual fields when the day has no object breakdown', async () => {
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;

    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '08:00:00',
      last_exit: '18:00:00',
      total_hours: 10,
      total_minutes: 600,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      displayMode: 'capped_to_schedule',
    });

    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 9,
      display_hours_worked: 9,
      base_hours_worked: 9,
      first_entry: null,
      last_exit: null,
    });
  });

  it('actual mode: display_hours_worked урезан под смену, факт и времена входа/выхода сохранены (без объектов)', async () => {
    // «Урезано»-роль (show_actual_hours=false) видит display_hours_worked. В режиме 'actual'
    // (интерактивный табель) он должен быть урезан под длину смены, а факт (hours_worked) и
    // времена входа/выхода — сохранены (нужны для опозданий и дневной модалки).
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;
    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '08:00:00',
      last_exit: '18:00:00',
      total_hours: 10,
      total_minutes: 600,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', {} as IResolvedSchedule]])]]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      // displayMode не задан → 'actual'
    });

    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 10,
      display_hours_worked: 9,
      first_entry: '08:00:00',
      last_exit: '18:00:00',
    });
  });

  it('actual mode: объектный день урезан под смену (display), факт по объектам и времена сохранены', async () => {
    mockedState.scheduleWorkHours = 8;
    mockedState.scheduleShiftHours = 9;

    const objectEntryA = {
      adjustment_id: 1,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 6,
      display_hours_worked: 6,
      base_hours_worked: 6,
      is_correction: false,
    };
    const objectEntryB = {
      adjustment_id: 2,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-b',
      object_id: 'obj-b',
      object_name: 'Объект B',
      hours_worked: 5,
      display_hours_worked: 5,
      base_hours_worked: 5,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [objectEntryA, objectEntryB],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [objectEntryA, objectEntryB]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a', 'obj-b'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.summaryRows = [{
      employee_id: 1,
      date: '2026-04-01',
      first_entry: '09:00:00',
      last_exit: '20:00:00',
      total_hours: 11,
      total_minutes: 660,
    }];

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', {} as IResolvedSchedule]])]]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      // displayMode не задан → 'actual'
    });

    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 11,
      display_hours_worked: 9,
      first_entry: '09:00:00',
      last_exit: '20:00:00',
    });

    const objA = result.objectEntries.find(entry => entry.object_key === 'obj-a')!;
    const objB = result.objectEntries.find(entry => entry.object_key === 'obj-b')!;
    // Факт по объектам сохранён, урезано только в display.
    expect(objA.hours_worked).toBe(6);
    expect(objB.hours_worked).toBe(5);
    expect(objA.display_hours_worked).toBeCloseTo(6 * 9 / 11, 2);
    expect(objA.display_hours_worked + objB.display_hours_worked).toBeCloseTo(9, 2);
  });

  describe('presence_covers_shift', () => {
    const setSummary = (summary: Record<string, unknown> | null): void => {
      mockedState.summaryRows = summary ? [summary as unknown as typeof mockedState.summaryRows[number]] : [];
    };

    it('flags span=8h as insufficient when shift needs 9h (entered 9 left 17 without lunch)', async () => {
      setSummary({
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '17:00:00',
        total_hours: 8,
        total_minutes: 480,
      });

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-03',
      });

      expect(result.entries[0].presence_covers_shift).toBe(false);
    });

    it('accepts full 9:00-18:00 with proper lunch break', async () => {
      setSummary({
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '18:00:00',
        total_hours: 8,
        total_minutes: 480,
      });

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-03',
      });

      expect(result.entries[0].presence_covers_shift).toBe(true);
    });

    it('rejects day when gaps exceed allotted lunch (90min absence while lunch=60)', async () => {
      setSummary({
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '18:30:00',
        total_hours: 8,
        total_minutes: 480,
      });

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-03',
      });

      expect(result.entries[0].presence_covers_shift).toBe(false);
    });

    it('flags past day with missing last_exit as not covering shift', async () => {
      mockedState.needsSkudCheck = true;
      setSummary(null);
      mockedState.objectAttendanceData.rawFallbackSummaries = new Map([
        [1, new Map([['2026-04-01', {
          employee_id: 1,
          date: '2026-04-01',
          first_entry: '09:00:00',
          last_exit: null,
          total_hours: 0,
          total_minutes: 0,
        }]])],
      ]);

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-05',
      });

      expect(result.entries[0].presence_covers_shift).toBe(false);
    });

    it('marks remote day as covering shift without SKUD check', async () => {
      mockedState.needsSkudCheck = false;
      setSummary(null);

      const schedule = { work_hours: 8, lunch_minutes: 0 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-05',
      });

      expect(result.entries[0]).toMatchObject({
        status: 'remote',
        presence_covers_shift: true,
      });
    });

    it('per-day lunch_minutes=0 в графике даёт hours_worked без вычета обеда из time-in-office', async () => {
      // Кейс из жизни: суббота, СКУД 09:25→12:25 = 3ч, day_overrides[6].lunch_minutes=0 →
      // hours_worked = 3.0, без вычета обеда. До фикса вычитался schedule.lunch_minutes=60.
      setSummary({
        employee_id: 1,
        date: '2026-02-21',
        first_entry: '09:25:00',
        last_exit: '12:25:00',
        total_hours: 3,
        total_minutes: 180,
      });
      // schedule имеет lunch_minutes=0 — мок getScheduleForDate возвращает его, как если бы
      // day_overrides[6] или cycle_days[i] установил lunch_minutes=0 для этой даты.
      mockedState.isWorkingDay = false;
      const schedule = { work_hours: 8, lunch_minutes: 0 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-02-21',
        endDate: '2026-02-21',
        dailySchedulesMap: new Map([[1, new Map([['2026-02-21', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 19 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-05-12',
      });

      expect(result.entries[0]).toMatchObject({
        employee_id: 1,
        work_date: '2026-02-21',
        status: 'work',
        hours_worked: 3,
        base_hours_worked: 3,
      });
    });

    it('preserves presence_covers_shift flag in capped_to_schedule mode', async () => {
      setSummary({
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '17:00:00',
        total_hours: 8,
        total_minutes: 480,
      });

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-03',
        displayMode: 'capped_to_schedule',
      });

      expect(result.entries[0]).toMatchObject({
        first_entry: null,
        last_exit: null,
        presence_covers_shift: false,
      });
    });
  });
});
