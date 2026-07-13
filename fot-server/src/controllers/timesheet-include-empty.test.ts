import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// ─── Моки графа импортов timesheet.controller ───
// Цель теста — инверсия дефолта include_empty в getAll: без параметра фильтр
// нулевой активности НЕ применяется, скрытие «пустых» — только по явному '0'.

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  memberships: vi.fn(),
  supervisors: vi.fn(),
  buildAttendance: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.pgQuery,
  queryOne: h.pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
}));
vi.mock('./timesheet-export.controller.js', () => ({ exportTimesheet: vi.fn() }));
vi.mock('./timesheet-mass-export.controller.js', () => ({
  exportTimesheetMass: vi.fn(),
  exportTimesheetMassUnified: vi.fn(),
}));
vi.mock('./timesheet-assigned-export.controller.js', () => ({
  exportTimesheetAssigned: vi.fn(),
  listAssignedEmployees: vi.fn(),
  emailTimesheetAssigned: vi.fn(),
  getDepartmentSupervisor: vi.fn(),
  listBrigadeSupervisorEmployeeIds: h.supervisors,
}));
vi.mock('./timesheet-weekend-memo.controller.js', () => ({
  generateWeekendMemo: vi.fn(),
  getWeekendMemoPreview: vi.fn(),
}));

// Единый мок schedule.service: и для контроллера, и для настоящего attendance.service.
vi.mock('../services/schedule.service.js', () => ({
  resolveSchedulesForPeriod: vi.fn(async () => new Map()),
  loadCalendarMonth: vi.fn(async () => null),
  isWorkingDay: vi.fn(() => false),
  isHolidayOnWorkday: vi.fn(() => false),
  getEffectiveLateThreshold: vi.fn(() => '09:00:00'),
  getScheduleForDate: vi.fn(() => undefined),
  getDayNormHours: vi.fn(() => 8),
  computeCappedFactHours: vi.fn(() => 0),
  getShiftDurationHours: vi.fn(() => 9),
  isPreHoliday: vi.fn(() => false),
  needsSkudCheck: vi.fn(() => false),
  NON_WORKING_STATUSES: new Set(['vacation', 'sick', 'unpaid', 'educational_leave']),
}));

vi.mock('../services/data-scope.service.js', () => ({
  getSelfHistoryLimitForUser: vi.fn(() => ({ minDate: null, message: null })),
  isSelfEmployeeRequest: vi.fn(() => false),
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all'),
  resolveAccessibleEmployeeIds: vi.fn(async () => 'all'),
  resolveManagedDepartmentIds: vi.fn(async () => []),
  resolveEditableDepartmentIds: vi.fn(async () => 'all'),
  resolveEditableEmployeeIds: vi.fn(async () => 'all'),
  resolveScopedDepartmentId: vi.fn(async (_req: unknown, id: string | null) => id),
  resolveEffectiveDirectSubordinates: vi.fn(async () => []),
  hasObjectViewScope: vi.fn(async () => false),
}));

vi.mock('../services/timekeeper-scope.service.js', () => ({
  isTimekeeper: vi.fn(() => false),
  resolveTimekeeperEditableLiIds: vi.fn(async () => new Set()),
  resolveTimekeeperLiObshestroyPresenceIds: vi.fn(async () => new Set()),
  LI_OBSHESTROY_DEPARTMENT_ID: 'li-obshestroy',
}));

vi.mock('../services/timesheet-weekend-days.util.js', () => ({
  listNonHolidayWeekendDays: vi.fn(() => []),
}));
vi.mock('../services/access-control.service.js', () => ({
  hasPageEdit: vi.fn(async () => true),
  hasPageView: vi.fn(async () => true),
}));

// attendance.service — настоящий (hasRealActivity участвует в проверяемой логике),
// подменяется только тяжёлый buildAttendanceEntries.
vi.mock('../services/attendance.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/attendance.service.js')>()),
  buildAttendanceEntries: h.buildAttendance,
}));
// Зависимости настоящего attendance.service.
vi.mock('../services/skud-travel.service.js', () => ({
  getTravelHoursSummaryForRange: vi.fn(async () => new Map()),
}));
vi.mock('../services/timesheet-object.service.js', () => ({
  buildObjectAttendanceData: vi.fn(),
  isMigratedDayLevelAdjustment: vi.fn(() => false),
  resolveDayObjectForAdjustment: vi.fn(),
  OBJECT_ADJUSTMENT_SOURCE_TYPE: 'manual_object',
}));

vi.mock('../services/employee-skud-object-access.service.js', () => ({
  listSelectableObjectsForEmployee: vi.fn(async () => []),
}));

vi.mock('../services/timesheet-department-assignments.service.js', () => ({
  isEmployeeAssignedToDepartmentOnDate: vi.fn(async () => true),
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(async () => []),
  listEmployeeMembershipsForDepartmentPeriod: h.memberships,
  findApprovalLockForDate: vi.fn(async () => null),
  resolveTimesheetDateRange: vi.fn(),
  // Упрощённый полный месяц — достаточно для getAll.
  resolveTimesheetPeriodRange: vi.fn((month: string) => {
    const [y, m] = month.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
    const daysInMonth = new Date(y, m, 0).getDate();
    return {
      year: y,
      month: m,
      daysInMonth,
      startDate: `${month}-01`,
      endDate: `${month}-${String(daysInMonth).padStart(2, '0')}`,
    };
  }),
}));

vi.mock('../services/timesheet-export.service.js', () => ({
  fetchTimesheetDataForDepartment: vi.fn(),
  fetchTimesheetDataForEmployees: vi.fn(),
}));
vi.mock('../services/employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => []),
}));
vi.mock('../services/department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: vi.fn(async () => []),
}));
vi.mock('../services/correction-approval-settings.service.js', () => ({
  correctionApprovalSettingsService: {},
}));
vi.mock('../services/correction-restrictions.service.js', () => ({
  assertCorrectionAllowed: vi.fn(),
  assertBulkAllowed: vi.fn(),
  assertBulkCorrectionAllowed: vi.fn(),
  assertObjectCorrectionsAllowed: vi.fn(),
  CorrectionRestrictionError: class CorrectionRestrictionError extends Error {},
  computeCorrectionEligibility: vi.fn(),
  loadRoleRestrictions: vi.fn(),
}));
vi.mock('../services/audit-context.helpers.js', () => ({
  loadEmployeeFullName: vi.fn(async () => null),
  loadEmployeeFullNamesMap: vi.fn(async () => new Map()),
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));
vi.mock('../services/skud-realtime.service.js', () => ({ notifySkudRealtimeChanged: vi.fn() }));
vi.mock('../services/correction-attachments.service.js', () => ({
  countCorrectionAttachments: vi.fn(async () => 0),
  purgeCorrectionAttachments: vi.fn(async () => undefined),
}));
vi.mock('../services/r2.service.js', () => ({ r2Service: {} }));
vi.mock('../services/leave-request-sync.service.js', () => ({
  syncLeaveRequestOnDayRemoval: vi.fn(),
  syncLeaveRequestReason: vi.fn(),
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: vi.fn(() => null) }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getLeaveRequestRecipients: vi.fn(async () => []),
}));

import { timesheetController } from './timesheet.controller.js';
import { buildTimesheetCacheKey, buildTimesheetTodayCacheKey } from '../routes/timesheet-cache-keys.js';

const MONTH = '2026-07';
const DEPT = 'D1';

const membership = (employeeId: number) => ({
  employee_id: employeeId,
  transferred_out_date: null,
  joined_date: null,
  joined_via_transfer: false,
});

const employeeRow = (id: number, name: string) => ({
  id,
  full_name: name,
  position_id: null,
  org_department_id: null,
  employment_status: 'active',
  excluded_from_timesheet: false,
  excluded_from_timesheet_date: null,
  dismissal_date: null,
});

// «Активный»: есть СКУД-присутствие. «Пустой»: синтетическая заглушка absent.
const activeEntry = (employeeId: number) => ({
  id: null,
  employee_id: employeeId,
  work_date: `${MONTH}-01`,
  status: 'work',
  hours_worked: 8,
  display_hours_worked: 8,
  base_hours_worked: 8,
  travel_segments_count: 0,
  is_correction: false,
  first_entry: '08:00:00',
  last_exit: '17:00:00',
});
const emptyStubEntry = (employeeId: number) => ({
  id: null,
  employee_id: employeeId,
  work_date: `${MONTH}-01`,
  status: 'absent',
  hours_worked: 0,
  display_hours_worked: 0,
  base_hours_worked: 0,
  travel_segments_count: 0,
  is_correction: false,
  first_entry: null,
  last_exit: null,
});

function makeReq(query: Record<string, string>): AuthenticatedRequest {
  return {
    params: {},
    body: {},
    query: { month: MONTH, department_id: DEPT, schedule_payload: 'compact', ...query },
    user: {
      id: 'admin-user',
      email: 'a@example.com',
      is_admin: true,
      role_code: 'admin',
      employee_id: null,
      show_actual_hours: false,
    },
  } as unknown as AuthenticatedRequest;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) { this._status = code; return this; },
    json(payload: unknown) { this._json = payload; return this; },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

function responseEmployeeIds(res: { _json: unknown }): number[] {
  const data = (res._json as { data: { employees: Array<{ id: number }> } }).data;
  return data.employees.map(e => Number(e.id)).sort((a, b) => a - b);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.memberships.mockResolvedValue([membership(1), membership(2)]);
  h.supervisors.mockResolvedValue([]);
  h.buildAttendance.mockResolvedValue({
    entries: [activeEntry(1), emptyStubEntry(2)],
    objectEntries: [],
  });
  h.pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employees')) {
      return [employeeRow(1, 'Активный А.'), employeeRow(2, 'Пустой П.')];
    }
    return [];
  });
  h.pgQueryOne.mockResolvedValue(null);
});

describe('getAll — инверсия дефолта include_empty', () => {
  it('параметр отсутствует → «пустой» сотрудник ЕСТЬ в ответе (фильтр не применяется)', async () => {
    const res = makeRes();
    await timesheetController.getAll(makeReq({}), res);

    expect(res._status).toBe(200);
    expect(responseEmployeeIds(res)).toEqual([1, 2]);
  });

  it('include_empty=0 → «пустой» скрыт, активный остаётся', async () => {
    const res = makeRes();
    await timesheetController.getAll(makeReq({ include_empty: '0' }), res);

    expect(res._status).toBe(200);
    expect(responseEmployeeIds(res)).toEqual([1]);
  });

  it('include_empty=1 → «пустой» есть (явное включение)', async () => {
    const res = makeRes();
    await timesheetController.getAll(makeReq({ include_empty: '1' }), res);

    expect(res._status).toBe(200);
    expect(responseEmployeeIds(res)).toEqual([1, 2]);
  });

  it('include_empty=0: сотрудник только с объектной корректировкой НЕ скрывается', async () => {
    h.buildAttendance.mockResolvedValue({
      entries: [activeEntry(1), emptyStubEntry(2)],
      objectEntries: [{ employee_id: 2, work_date: `${MONTH}-02`, hours_worked: 4 }],
    });
    const res = makeRes();
    await timesheetController.getAll(makeReq({ include_empty: '0' }), res);

    expect(res._status).toBe(200);
    expect(responseEmployeeIds(res)).toEqual([1, 2]);
  });
});

describe('кэш-ключи timesheet — include_empty и employee_ids', () => {
  const keyReq = (query: Record<string, string>) => ({
    query: { month: MONTH, department_id: DEPT, ...query },
    user: { id: 'u1', show_actual_hours: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  it('include_empty=0 и include_empty=1 живут в разных bucket\'ах', () => {
    expect(buildTimesheetCacheKey(keyReq({ include_empty: '0' })))
      .not.toBe(buildTimesheetCacheKey(keyReq({ include_empty: '1' })));
  });

  it('отсутствие параметра нормализуется к \'1\' (один bucket с явным include_empty=1)', () => {
    expect(buildTimesheetCacheKey(keyReq({})))
      .toBe(buildTimesheetCacheKey(keyReq({ include_empty: '1' })));
    expect(buildTimesheetTodayCacheKey(keyReq({})))
      .toBe(buildTimesheetTodayCacheKey(keyReq({ include_empty: '1' })));
  });

  it('разные employee_ids (HR-снимки) → разные ключи', () => {
    expect(buildTimesheetCacheKey(keyReq({ employee_ids: '1,2,3' })))
      .not.toBe(buildTimesheetCacheKey(keyReq({ employee_ids: '1,2,4' })));
    expect(buildTimesheetCacheKey(keyReq({ employee_ids: '1,2,3' })))
      .not.toBe(buildTimesheetCacheKey(keyReq({})));
  });

  it('ключи ts и ts-today не пересекаются', () => {
    expect(buildTimesheetCacheKey(keyReq({})))
      .not.toBe(buildTimesheetTodayCacheKey(keyReq({})));
  });
});
