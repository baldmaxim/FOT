import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// ─── Моки графа импортов timesheet.controller ───
// Цель теста — режим «По сотруднику»: period_department_id включает штатный
// membership-путь, доступ считается на границах периода, поиск и список периодов
// не отдают чужих сотрудников.

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
  formatDateShift: (date: string, days: number) => {
    const cursor = new Date(`${date}T00:00:00`);
    cursor.setDate(cursor.getDate() + days);
    const pad = (v: number) => String(v).padStart(2, '0');
    return `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
  },
  isEmployeeAssignedToDepartmentOnDate: vi.fn(async () => true),
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(async () => []),
  listEmployeeMembershipsForDepartmentPeriod: h.memberships,
  findApprovalLockForDate: vi.fn(async () => null),
  // Явные from/to — нужны для проверки полумесяца (там и проявляется ложный cutoff).
  resolveTimesheetDateRange: vi.fn((month: string, from?: string | null, to?: string | null) => {
    const [y, m] = month.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
    const daysInMonth = new Date(y, m, 0).getDate();
    return {
      year: y,
      month: m,
      daysInMonth,
      startDate: from || `${month}-01`,
      endDate: to || `${month}-${String(daysInMonth).padStart(2, '0')}`,
    };
  }),
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


const scope = vi.hoisted(() => ({
  resolveTimesheetScope: vi.fn(async () => 'department' as const),
  canAccess: vi.fn(async () => true),
  hasManagedTimesheetAccess: vi.fn(async () => true),
  periods: vi.fn(async () => []),
}));

vi.mock('../services/timesheet-scope.service.js', () => ({
  MANAGED_TIMESHEET_PAGE_KEYS: ['/timesheet', '/timesheet-hr'],
  hasManagedTimesheetAccess: scope.hasManagedTimesheetAccess,
  resolveTimesheetScope: scope.resolveTimesheetScope,
  resolveTimesheetScopedDepartmentId: vi.fn(async (_req: unknown, id: string | null) => id),
  resolveTimesheetReadableDepartmentId: vi.fn(async (_req: unknown, id: string | null) => id),
  canAccessEmployeeForTimesheetPeriod: scope.canAccess,
  filterEmployeeIdsByTimesheetScope: vi.fn(async (_req: unknown, ids: number[]) => ids),
  filterAdditionalEmployeeIdsForTimesheetPeriod: vi.fn(async (_req: unknown, ids: number[]) => ids),
}));

vi.mock('../services/timesheet-employee-periods.service.js', () => ({
  listEmployeeDepartmentPeriods: scope.periods,
}));

vi.mock('../utils/search.utils.js', () => ({
  escapeLike: (value: string) => value,
}));

vi.mock('../services/timesheet-lock.service.js', () => ({
  findApprovalLockForEmployeeDate: vi.fn(async () => null),
  findApprovalLocksForEmployeeDates: vi.fn(async () => new Map()),
  flattenApprovalLockDates: vi.fn(() => []),
  loadApprovalLocksForEmployeesInPeriod: vi.fn(async () => []),
  lockKey: (employeeId: number, date: string) => `${employeeId}_${date}`,
}));

import { timesheetController } from './timesheet.controller.js';

const MONTH = '2026-08';
const DEPT_A = 'dept-a';
const DEPT_B = 'dept-b';
const EMP = 77;

const membership = (overrides: Record<string, unknown> = {}) => ({
  employee_id: EMP,
  transferred_out_date: null,
  joined_date: null,
  joined_via_transfer: false,
  ...overrides,
});

const employeeRow = () => ({
  id: EMP,
  full_name: 'Иванов Иван Иванович',
  position_id: null,
  org_department_id: DEPT_A,
  employment_status: 'active',
  excluded_from_timesheet: false,
  excluded_from_timesheet_date: null,
  dismissal_date: null,
});

const makeRes = () => {
  const res = {
    _status: 200,
    _json: null as unknown,
    status(code: number) { this._status = code; return this; },
    json(payload: unknown) { this._json = payload; return this; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res as unknown as Response & { _status: number; _json: any };
};

const makeReq = (query: Record<string, unknown>, params: Record<string, string> = {}) => ({
  query,
  params,
  body: {},
  user: {
    id: 'u1',
    employee_id: 1,
    is_admin: false,
    role_code: 'header',
    show_actual_hours: false,
    timesheet_months_back: 12,
    timesheet_months_forward: 12,
  },
}) as unknown as AuthenticatedRequest;

beforeEach(() => {
  vi.clearAllMocks();
  scope.resolveTimesheetScope.mockResolvedValue('department');
  scope.canAccess.mockResolvedValue(true);
  scope.hasManagedTimesheetAccess.mockResolvedValue(true);
  scope.periods.mockResolvedValue([]);
  h.supervisors.mockResolvedValue([]);
  h.memberships.mockResolvedValue([membership()]);
  h.buildAttendance.mockResolvedValue({ entries: [], objectEntries: [] });
  h.pgQuery.mockResolvedValue([]);
  h.pgQueryOne.mockResolvedValue(null);
});

const getAllWithPeriod = async (query: Record<string, unknown> = {}) => {
  h.pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employees')) return [employeeRow()];
    return [];
  });
  const res = makeRes();
  await timesheetController.getAll(makeReq({
    month: MONTH,
    employee_id: String(EMP),
    period_department_id: DEPT_A,
    ...query,
  }), res);
  return res;
};

describe('getAll — режим «По сотруднику»', () => {
  it('period_department_id включает membership-путь по этому отделу', async () => {
    await getAllWithPeriod();

    expect(h.memberships).toHaveBeenCalledWith(DEPT_A, `${MONTH}-01`, `${MONTH}-31`);
  });

  it('строка начальника участка в персональном режиме не подмешивается', async () => {
    await getAllWithPeriod();

    expect(h.supervisors).not.toHaveBeenCalled();
  });

  it('границы периода сужают окно членства (A → B → A)', async () => {
    // membership отдаёт ОДНО окно на отдел с самой ранней датой входа —
    // без сужения дни, проведённые в B, не стали бы серыми в первой строке A.
    h.memberships.mockResolvedValue([membership({ joined_date: `${MONTH}-01` })]);

    const res = await getAllWithPeriod({
      period_from: `${MONTH}-01`,
      period_to: `${MONTH}-09`,
    });

    const employee = res._json.data.employees[0];
    // Первый отрезок открыт с начала диапазона — нижней границы нет, верхняя закрывает
    // дни, проведённые в отделе B (иначе они не стали бы серыми в этой строке).
    expect(employee.joined_date).toBeNull();
    expect(employee.transferred_out_date).toBe(`${MONTH}-10`);

    // Третий отрезок — возврат в тот же отдел: membership отдаёт ту же раннюю дату
    // входа, поэтому нижняя граница обязана подтянуться к началу отрезка.
    const back = await getAllWithPeriod({
      period_from: `${MONTH}-20`,
      period_to: `${MONTH}-31`,
    });
    expect(back._json.data.employees[0].joined_date).toBe(`${MONTH}-20`);
  });

  it('нижняя граница периода применяется и к активному сотруднику', async () => {
    h.memberships.mockResolvedValue([membership()]);

    const res = await getAllWithPeriod({
      period_from: `${MONTH}-20`,
      period_to: `${MONTH}-31`,
    });

    expect(res._json.data.employees[0].joined_date).toBe(`${MONTH}-20`);
  });

  it('более раннее увольнение не затирается границей периода', async () => {
    h.memberships.mockResolvedValue([membership({ transferred_out_date: `${MONTH}-05` })]);

    const res = await getAllWithPeriod({ period_to: `${MONTH}-20` });

    expect(res._json.data.employees[0].transferred_out_date).toBe(`${MONTH}-05`);
  });

  it('период до конца диапазона не выдаёт себя за перевод', async () => {
    // Последняя строка любого сотрудника упирается в конец диапазона. Если считать
    // это переводом, строка получает бейдж «Переведён 01.09» на пустом месте —
    // и ложный cutoff, который на первой половине месяца ломает «Откл.».
    h.memberships.mockResolvedValue([membership()]);

    const res = await getAllWithPeriod({
      period_from: `${MONTH}-01`,
      period_to: `${MONTH}-31`,
    });

    expect(res._json.data.employees[0].transferred_out_date).toBeNull();
    expect(res._json.data.employees[0].joined_date).toBeNull();
  });

  it('без period_from нижняя граница берётся из membership', async () => {
    // Первый период начинается датой приёма, а не переводом: фронт нижнюю границу
    // не шлёт, и дни до неё остаются обычными — как в запросе отдела.
    h.memberships.mockResolvedValue([membership({ joined_date: `${MONTH}-20` })]);

    const res = await getAllWithPeriod({ period_to: `${MONTH}-31` });

    // joined_via_transfer=false у активного → нижняя граница не применяется.
    expect(res._json.data.employees[0].joined_date).toBeNull();
  });

  it('403, если доступа к сотруднику на границах периода нет', async () => {
    scope.canAccess.mockImplementation(async (_req: unknown, _id: number, from: string) => (
      from === `${MONTH}-01`
    ));

    const res = await getAllWithPeriod({
      period_from: `${MONTH}-20`,
      period_to: `${MONTH}-31`,
    });

    expect(res._status).toBe(403);
    expect(h.buildAttendance).not.toHaveBeenCalled();
  });

  it('без period_department_id прежнее поведение сохраняется', async () => {
    h.pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM employees')) return [employeeRow()];
      return [];
    });
    const res = makeRes();
    await timesheetController.getAll(makeReq({ month: MONTH, employee_id: String(EMP) }), res);

    expect(res._status).toBe(200);
    expect(h.memberships).not.toHaveBeenCalled();
  });
});

describe('listEmployeeAssignmentPeriods', () => {
  const call = async (query: Record<string, unknown>, employeeId = String(EMP)) => {
    const res = makeRes();
    await timesheetController.listEmployeeAssignmentPeriods(
      makeReq(query, { employeeId }),
      res,
    );
    return res;
  };

  it('чужой employeeId → 403', async () => {
    scope.canAccess.mockResolvedValue(false);

    const res = await call({ from: `${MONTH}-01`, to: `${MONTH}-31` });

    expect(res._status).toBe(403);
    expect(scope.periods).not.toHaveBeenCalled();
  });

  it('некорректный диапазон → 400', async () => {
    const res = await call({ from: `${MONTH}-31`, to: `${MONTH}-01` });

    expect(res._status).toBe(400);
  });

  it('accessible/editable считаются на границах каждого периода', async () => {
    scope.periods.mockResolvedValue([
      { org_department_id: DEPT_A, department_name: 'Отдел А', from: `${MONTH}-01`, to: `${MONTH}-09` },
      { org_department_id: DEPT_B, department_name: 'Отдел Б', from: `${MONTH}-10`, to: `${MONTH}-31` },
    ]);
    // Доступ есть только к первому периоду.
    scope.canAccess.mockImplementation(async (_req: unknown, _id: number, from: string) => (
      from === `${MONTH}-01`
    ));

    const res = await call({ from: `${MONTH}-01`, to: `${MONTH}-31` });

    expect(res._status).toBe(200);
    expect(res._json.data).toEqual([
      expect.objectContaining({ org_department_id: DEPT_A, accessible: true, editable: true }),
      expect.objectContaining({ org_department_id: DEPT_B, accessible: false, editable: false }),
    ]);
  });

  it('без права правки страницы периоды не редактируемы', async () => {
    scope.hasManagedTimesheetAccess.mockResolvedValue(false);
    scope.periods.mockResolvedValue([
      { org_department_id: DEPT_A, department_name: 'Отдел А', from: `${MONTH}-01`, to: `${MONTH}-31` },
    ]);

    const res = await call({ from: `${MONTH}-01`, to: `${MONTH}-31` });

    expect(res._json.data[0]).toMatchObject({ accessible: true, editable: false });
  });
});

describe('searchEmployeesForTimesheet', () => {
  const call = async (query: Record<string, unknown>) => {
    const res = makeRes();
    await timesheetController.searchEmployeesForTimesheet(makeReq(query), res);
    return res;
  };

  const candidates = [
    { id: 1, full_name: 'Иванов Иван', org_department_id: null, employment_status: 'active' },
    { id: 2, full_name: 'Иванов Пётр', org_department_id: null, employment_status: 'fired' },
  ];

  it('без диапазона дат → 400', async () => {
    const res = await call({ q: 'Иванов' });

    expect(res._status).toBe(400);
  });

  it('короткий запрос не идёт в БД', async () => {
    const res = await call({ q: 'И', from: `${MONTH}-01`, to: `${MONTH}-31` });

    expect(res._json.data).toEqual([]);
    expect(h.pgQuery).not.toHaveBeenCalled();
  });

  it('неглобальный скоуп: недоступные сотрудники отсеиваются поштучно', async () => {
    h.pgQuery.mockImplementation(async (sql: string) => (
      sql.includes('FROM employees') ? candidates : []
    ));
    scope.canAccess.mockImplementation(async (_req: unknown, id: number) => id === 1);

    const res = await call({ q: 'Иванов', from: `${MONTH}-01`, to: `${MONTH}-31` });

    expect(res._json.data).toEqual([
      expect.objectContaining({ id: 1, full_name: 'Иванов Иван' }),
    ]);
  });

  it('self-скоуп не видит чужих сотрудников', async () => {
    scope.resolveTimesheetScope.mockResolvedValue('self');
    h.pgQuery.mockImplementation(async (sql: string) => (
      sql.includes('FROM employees') ? candidates : []
    ));
    // canAccessEmployeeForTimesheetPeriod при self пропускает только самого себя,
    // а сам пользователь под этот поисковый запрос не подходит.
    scope.canAccess.mockImplementation(async (_req: unknown, id: number) => id === 999);

    const res = await call({ q: 'Иванов', from: `${MONTH}-01`, to: `${MONTH}-31` });

    expect(res._json.data).toEqual([]);
  });

  it('глобальный скоуп не делает поштучных проверок', async () => {
    scope.resolveTimesheetScope.mockResolvedValue('all');
    h.pgQuery.mockImplementation(async (sql: string) => (
      sql.includes('FROM employees') ? candidates : []
    ));

    const res = await call({ q: 'Иванов', from: `${MONTH}-01`, to: `${MONTH}-31` });

    expect(res._json.data).toHaveLength(2);
    expect(scope.canAccess).not.toHaveBeenCalled();
  });
});

// ─── Эталон корректности режима «По сотруднику» ───
// Строка персонального режима обязана считаться ТЕМ ЖЕ путём, что строка внутри
// отдела. Отдельно проверяем обязательные выходные: они считаются ПОМЕСЯЧНО
// (гейт `endDate < last` в getAll), поэтому персональный режим шлёт полный
// диапазон месяца, а не границы периода. Обрезка from/to под период отдавала бы
// всю месячную норму поздней строке и гасила недобор в ранней.
describe('паритет статистики: «По сотруднику» против «По отделу»', () => {
  const MANDATORY_SCHEDULE = {
    work_hours: 8,
    expected_saturdays_per_month: 1,
    expected_sundays_per_month: 0,
    respects_holidays: true,
    schedule_type: '5+2',
  };

  // Последняя суббота августа 2026 — 29-е, она уже в прошлом относительно «сегодня» теста.
  const SATURDAYS = [`${MONTH}-01`, `${MONTH}-08`, `${MONTH}-15`, `${MONTH}-22`, `${MONTH}-29`];

  const withMandatoryWeekends = async (): Promise<void> => {
    const scheduleModule = await import('../services/schedule.service.js');
    vi.mocked(scheduleModule.resolveSchedulesForPeriod).mockResolvedValue(
      new Map([[EMP, new Map(SATURDAYS.map(date => [date, MANDATORY_SCHEDULE]))]]),
    );
    const weekendModule = await import('../services/timesheet-weekend-days.util.js');
    vi.mocked(weekendModule.listNonHolidayWeekendDays).mockImplementation(
      (_y: number, _m: number, _cal: unknown, _holidays: unknown, dow: number) => (
        dow === 6 ? SATURDAYS : []
      ),
    );
  };

  const statsFor = async (query: Record<string, unknown>) => {
    h.pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM employees')) return [employeeRow()];
      return [];
    });
    const res = makeRes();
    await timesheetController.getAll(makeReq({ month: MONTH, ...query }), res);
    return res._json.data;
  };

  beforeEach(async () => {
    await withMandatoryWeekends();
    // Сотрудник переведён 20-го: membership отдела A закрывается этой датой.
    h.memberships.mockResolvedValue([membership({ transferred_out_date: `${MONTH}-20` })]);
  });

  it('employee_stats строки совпадает со строкой того же отдела', async () => {
    const byDepartment = await statsFor({ department_id: DEPT_A });
    const byEmployee = await statsFor({
      employee_id: String(EMP),
      period_department_id: DEPT_A,
      period_from: `${MONTH}-01`,
      period_to: `${MONTH}-19`,
    });

    expect(byEmployee.employee_stats).toEqual(byDepartment.employee_stats);
    expect(byEmployee.employees[0].transferred_out_date)
      .toBe(byDepartment.employees[0].transferred_out_date);
    expect(byEmployee.employees[0].joined_date)
      .toBe(byDepartment.employees[0].joined_date);
  });

  it('первая половина месяца: «Откл.» совпадает с отделом', async () => {
    // Кейс ложного cutoff. На 1–15 недобор обязательной субботы НЕ определяется
    // (последняя суббота месяца ещё впереди — гейт `endDate < last`). Если конец
    // диапазона принять за перевод, окно суббот схлопывается до 1/8/15, месяц
    // выглядит закрытым, и в персональном режиме появляется недобор, которого
    // в том же отделе нет.
    h.memberships.mockResolvedValue([membership()]);
    const half = { from: `${MONTH}-01`, to: `${MONTH}-15` };

    const byDepartment = await statsFor({ department_id: DEPT_A, ...half });
    const byEmployee = await statsFor({
      employee_id: String(EMP),
      period_department_id: DEPT_A,
      period_to: `${MONTH}-15`,
      ...half,
    });

    expect(byEmployee.employee_stats).toEqual(byDepartment.employee_stats);
    expect(byEmployee.employees[0].transferred_out_date).toBeNull();
  });

  it('строка после перевода совпадает со строкой нового отдела', async () => {
    // Недобор обязательной субботы привязан к окну членства: у строки A месяц уже
    // закрыт переводом, у строки B последняя суббота ещё не наступила. Сумма по
    // строкам НЕ обязана равняться месяцу — важно, что каждая строка совпадает
    // со своим отделом, иначе норма выходных «переехала» бы между отделами.
    h.memberships.mockResolvedValue([membership({ joined_date: `${MONTH}-20`, joined_via_transfer: true })]);

    const byDepartment = await statsFor({ department_id: DEPT_B });
    const byEmployee = await statsFor({
      employee_id: String(EMP),
      period_department_id: DEPT_B,
      period_from: `${MONTH}-20`,
      period_to: `${MONTH}-31`,
    });

    expect(byEmployee.employee_stats).toEqual(byDepartment.employee_stats);
    expect(byEmployee.employees[0].joined_date).toBe(`${MONTH}-20`);
  });

  it('норма обязательной субботы не задваивается между строками перевода', async () => {
    const normOf = (data: any) => data.employee_stats[0]?.norm_hours ?? 0;

    const rowA = await statsFor({
      employee_id: String(EMP),
      period_department_id: DEPT_A,
      period_from: `${MONTH}-01`,
      period_to: `${MONTH}-19`,
    });

    h.memberships.mockResolvedValue([membership({ joined_date: `${MONTH}-20`, joined_via_transfer: true })]);
    const rowB = await statsFor({
      employee_id: String(EMP),
      period_department_id: DEPT_B,
      period_from: `${MONTH}-20`,
      period_to: `${MONTH}-31`,
    });

    // Норма месячных выходных попадает ровно в одну строку, а не в обе.
    expect([normOf(rowA) > 0, normOf(rowB) > 0].filter(Boolean)).toHaveLength(1);
  });
});
