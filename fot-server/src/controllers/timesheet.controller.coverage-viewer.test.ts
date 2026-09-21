import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// ─── Моки графа импортов timesheet.controller ───
// Цель теста — проводка viewerEmployeeId в грид: руководитель, который сам владеет
// табелем отдела, не должен получать своих же прямых подчинённых как «покрытых»
// (covered_dates гасят и клик по дню, и массовое выделение).

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  memberships: vi.fn(),
  supervisors: vi.fn(),
  buildAttendance: vi.fn(),
  directSubs: vi.fn(async () => [] as number[]),
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
  exportTimesheetAssignedUnified: vi.fn(),
  listAssignedEmployees: vi.fn(),
  emailTimesheetAssigned: vi.fn(),
  getDepartmentSupervisor: vi.fn(),
  listBrigadeSupervisorEmployeeIds: h.supervisors,
}));
vi.mock('./timesheet-department-export.controller.js', () => ({
  exportTimesheetDepartmentUnified: vi.fn(),
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
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  isSelfEmployeeRequest: vi.fn(() => false),
  normalizeUuidParam: vi.fn((value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)),
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all'),
  resolveAccessibleEmployeeIds: vi.fn(async () => 'all'),
  resolveManagedDepartmentIds: vi.fn(async () => []),
  resolveEditableDepartmentIds: vi.fn(async () => 'all'),
  resolveEditableEmployeeIds: vi.fn(async () => 'all'),
  resolveScopedDepartmentId: vi.fn(async (_req: unknown, id: string | null) => id),
  resolveEffectiveDirectSubordinates: h.directSubs,
  hasObjectViewScope: vi.fn(async () => false),
  resolveWritableScopedDepartmentId: vi.fn(async (_req: unknown, id: string | null) => id),
  resolveTimesheetEditableDepartmentIds: vi.fn(async () => 'all'),
  resolveTimesheetEditableEmployeeIds: vi.fn(async () => 'all'),
}));

vi.mock('../services/timesheet-scope.service.js', () => ({
  resolveTimesheetScope: vi.fn(async () => 'department'),
  resolveTimesheetScopedDepartmentId: vi.fn(async (_req: unknown, id: string | null) => id ?? null),
  resolveTimesheetReadableDepartmentId: vi.fn(async (_req: unknown, id: string | null) => id ?? null),
  canAccessEmployeeForTimesheetPeriod: vi.fn(async () => true),
  hasManagedTimesheetAccess: vi.fn(async () => true),
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
  resolveDayAllocationSuggestion: vi.fn(async () => ({
    distribution: [], resolution_source: null, requires_allocation: false, ambiguous: false, candidates: [],
  })),
  validateRequestedAllocations: vi.fn(async () => ({ ok: true, allocations: [] })),
  readObjectAllocations: vi.fn(() => []),
  hasObjectAllocations: vi.fn(() => false),
  allocationsEqual: vi.fn(() => true),
  OBJECT_ADJUSTMENT_SOURCE_TYPE: 'manual_object',
  OBJECT_ALLOCATIONS_KEY: 'object_allocations',
  ALLOCATION_SOURCE_KEY: 'allocation_source',
  MAX_OBJECT_ALLOCATIONS: 10,
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

const MONTH = '2026-07';
const DEPT = 'D1';
/** Руководитель, открывший грид: он же единственный владелец табеля отдела. */
const VIEWER = 900;
/** Его прямой подчинённый из этого же отдела. */
const SUB = 1;

interface IEmployeeRow {
  id: number;
  source: string;
  editable: boolean;
  covered_dates: string[] | null;
}

const employeeRow = (id: number, name: string) => ({
  id,
  full_name: name,
  position_id: null,
  org_department_id: DEPT,
  employment_status: 'active',
  excluded_from_timesheet: false,
  excluded_from_timesheet_date: null,
  dismissal_date: null,
});

/** Владельцы табеля отдела: JOIN system_roles — «начальники», отдельная выборка — заместители. */
const setupDb = (owners: number[]): void => {
  h.pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employee_assignments')) return [];
    if (sql.includes('FROM employee_department_access')) {
      if (sql.includes("access_level = 'deputy'")) return [];
      return owners.map(employee_id => ({
        employee_id, department_id: DEPT, role_code: 'manager', is_admin: false,
      }));
    }
    // Покрытие спрашивает snapshot-отдел, контроллер — карточки сотрудников.
    if (sql.includes('org_department_id::text AS org_department_id')) {
      return [{ id: SUB, org_department_id: DEPT }];
    }
    if (sql.includes('FROM employees')) return [employeeRow(SUB, 'Подчинённый П.')];
    return [];
  });
};

function makeReq(): AuthenticatedRequest {
  return {
    params: {},
    body: {},
    query: { month: MONTH, department_id: DEPT, schedule_payload: 'compact' },
    user: {
      id: 'manager-user',
      email: 'm@example.com',
      is_admin: false,
      role_code: 'site_supervisor',
      employee_id: VIEWER,
      show_actual_hours: false,
      // Окно месяцев для scope='department' — широкое, чтобы тест не зависел от даты прогона.
      timesheet_months_back: 240,
      timesheet_months_forward: 240,
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

const rowOf = (res: { _json: unknown }, employeeId: number): IEmployeeRow => {
  const data = (res._json as { data: { employees: IEmployeeRow[] } }).data;
  const row = data.employees.find(e => Number(e.id) === employeeId);
  if (!row) throw new Error(`В ответе нет сотрудника ${employeeId}: ${JSON.stringify(data.employees)}`);
  return row;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.directSubs.mockResolvedValue([SUB]);
  h.memberships.mockResolvedValue([]);
  h.supervisors.mockResolvedValue([]);
  h.buildAttendance.mockResolvedValue({ entries: [], objectEntries: [] });
  h.pgQueryOne.mockResolvedValue(null);
});

describe('getAll — покрытие не отбирает правку у владельца отдела', () => {
  it('владелец табеля отдела = сам руководитель → строка редактируема, покрытых дат нет', async () => {
    setupDb([VIEWER]);
    const res = makeRes();

    await timesheetController.getAll(makeReq(), res);

    const row = rowOf(res, SUB);
    expect(row.source).not.toBe('direct_report_covered');
    expect(row.covered_dates ?? []).toEqual([]);
    expect(row.editable).toBe(true);
  });

  it('владелец отдела — другой человек → поведение прежнее: покрыт и read-only', async () => {
    setupDb([VIEWER + 1]);
    const res = makeRes();

    await timesheetController.getAll(makeReq(), res);

    const row = rowOf(res, SUB);
    expect(row.source).toBe('direct_report_covered');
    expect(row.covered_dates ?? []).not.toEqual([]);
    expect(row.editable).toBe(false);
  });
});
