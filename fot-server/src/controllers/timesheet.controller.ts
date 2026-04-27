import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type {
  AuthenticatedRequest,
  IResolvedSchedule,
  TimeStatus,
  TimesheetApprovalStatus,
  WorkCategory,
} from '../types/index.js';
import type { DataScope } from '../config/access-control.js';
import { exportTimesheet } from './timesheet-export.controller.js';
import { exportTimesheetMass } from './timesheet-mass-export.controller.js';
import { exportTimesheetAssigned, listAssignedEmployees, emailTimesheetAssigned } from './timesheet-assigned-export.controller.js';
import { resolveSchedulesForPeriod, resolveObjectSchedule, isWorkingDay, getEffectiveLateThreshold, getScheduleForDate, loadCalendarMonth } from '../services/schedule.service.js';
import {
  getMinSelfHistoryDate,
  isSelfEmployeeRequest,
  resolveManagedDepartmentIds,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { hasPageEdit, hasPageView } from '../services/access-control.service.js';
import { employeeCache } from '../services/employee-cache.service.js';
import {
  buildAttendanceEntries,
  deleteAttendanceAdjustmentById,
  deleteAttendanceAdjustmentBySource,
  getAttendanceAdjustmentById,
  loadAttendanceAdjustmentsWithAuthors,
  updateAttendanceAdjustmentById,
  upsertAttendanceAdjustment,
} from '../services/attendance.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { OBJECT_ADJUSTMENT_SOURCE_TYPE } from '../services/timesheet-object.service.js';
import {
  formatDateShift,
  isEmployeeAssignedToDepartmentOnDate,
  listEmployeeIdsAssignedToDepartmentPeriod,
  resolveTimesheetDateRange,
  resolveTimesheetPeriodRange,
} from '../services/timesheet-department-assignments.service.js';
import { fetchTimesheetDataForDepartment } from '../services/timesheet-export.service.js';
import {
  getErrorMessage,
  getHttpErrorCode,
  getHttpErrorStatus,
  loadEmployeeLifecycleRow,
  loadTargetDepartment,
  moveEmployeeToDepartmentInternal,
} from './employee-lifecycle.controller.js';
import {
  loadEmployeeFullName as loadEmployeeFullNameForAudit,
  loadDepartmentName as loadDepartmentNameForAudit,
  loadEmployeeFullNamesMap,
} from '../services/audit-context.helpers.js';
import { sigurService } from '../services/sigur.service.js';
import {
  acquirePresencePollingLock,
  releasePresencePollingLock,
  ManualSyncInProgressError,
} from '../services/presence-polling.service.js';
import { syncEventsLogic } from '../services/sigur-sync-events.service.js';

const validStatuses = ['work', 'vacation', 'dayoff', 'remote', 'unpaid', 'absent', 'sick', 'business_trip', 'manual'] as const satisfies readonly [TimeStatus, ...TimeStatus[]];

const createEntrySchema = z.object({
  employee_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(validStatuses),
  hours_worked: z.number().min(0).max(24).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const updateEntrySchema = z.object({
  status: z.enum(validStatuses).optional(),
  hours_worked: z.number().min(0).max(24).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const bulkCorrectionSchema = z.object({
  items: z.array(z.object({
    employee_id: z.number().int().positive(),
    work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })).min(1).max(1000),
  status: z.enum(validStatuses),
  hours_worked: z.number().min(0).max(24).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const upsertObjectEntrySchema = z.object({
  employee_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  object_key: z.string().trim().min(1).max(255),
  object_id: z.string().trim().min(1).max(255).nullable().optional(),
  object_name: z.string().trim().min(1).max(255),
  hours_worked: z.number().min(0).max(24),
  notes: z.string().max(500).nullable().optional(),
});

const deleteObjectEntrySchema = z.object({
  employee_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  object_key: z.string().trim().min(1).max(255),
});

const teamManagementSearchSchema = z.object({
  q: z.string().trim().min(2).max(100),
  department_id: z.string().uuid(),
});

const teamManagementMutationSchema = z.object({
  employee_id: z.number().int().positive(),
  department_id: z.string().uuid(),
});

const teamManagementAddEmployeeSchema = teamManagementMutationSchema.extend({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Корректировка считается автоматически согласованной (`auto_approved`), если день
 * рабочий по графику сотрудника. Иначе (Сб/Вс/праздник либо нерабочий по графику)
 * требуется отдельное согласование админом — `pending`.
 */
async function resolveAdjustmentApprovalStatus(
  employeeId: number,
  workDate: string,
): Promise<'auto_approved' | 'pending'> {
  const { data: employee, error } = await supabase
    .from('employees')
    .select('id, work_category')
    .eq('id', employeeId)
    .maybeSingle();
  if (error || !employee) return 'auto_approved';

  const schedules = await resolveSchedulesForPeriod(
    [{
      id: Number(employee.id),
      work_category: (employee.work_category as WorkCategory | null) ?? null,
    }],
    workDate,
    workDate,
  );
  const schedule = schedules.get(employeeId)?.get(workDate);
  if (!schedule) return 'auto_approved';

  const dateObj = new Date(`${workDate}T00:00:00`);
  const monthCalendar = await loadCalendarMonth(dateObj.getFullYear(), dateObj.getMonth() + 1);
  return isWorkingDay(schedule, dateObj, monthCalendar) ? 'auto_approved' : 'pending';
}

const MANAGED_TIMESHEET_PAGE_KEYS = ['/timesheet', '/timesheet-hr'] as const;
const TIMESHEET_TEAM_MANAGEMENT_PAGE_KEY = '/timesheet/team-management';

interface IManagedDepartmentTimesheetSummary {
  department_id: string;
  department_name: string;
  employee_count: number;
  norm_hours: number;
  actual_hours: number;
  deviations: { late: number; absent: number; sick: number };
  approval_status: TimesheetApprovalStatus | null;
  approvals: Array<{
    id: number;
    start_date: string;
    end_date: string;
    status: TimesheetApprovalStatus;
  }>;
  is_primary: boolean;
}

interface IApprovalLockInfo {
  id: number;
  start_date: string;
  end_date: string;
  status: TimesheetApprovalStatus;
}

/** Возвращает список активных (submitted/approved/returned) согласований отдела, покрывающих рабочую дату. */
async function findApprovalLockForDate(
  departmentId: string,
  workDate: string,
): Promise<IApprovalLockInfo | null> {
  const { data, error } = await supabase
    .from('timesheet_approvals')
    .select('id, start_date, end_date, status')
    .eq('department_id', departmentId)
    .in('status', ['submitted', 'approved', 'returned'])
    .lte('start_date', workDate)
    .gte('end_date', workDate)
    .order('status', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as IApprovalLockInfo | null) ?? null;
}

/**
 * Возвращает ISO-даты, для которых существует активный согласованный диапазон отдела сотрудника
 * в пределах [startDate..endDate]. Используется для блокировки редактирования у руководителя.
 */
async function loadApprovalLockedDatesForDepartment(
  departmentId: string,
  startDate: string,
  endDate: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('timesheet_approvals')
    .select('start_date, end_date, status')
    .eq('department_id', departmentId)
    .in('status', ['submitted', 'approved', 'returned'])
    .lte('start_date', endDate)
    .gte('end_date', startDate);

  if (error) throw error;

  const locked = new Set<string>();
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  for (const row of data || []) {
    const aStart = new Date(`${row.start_date}T00:00:00Z`);
    const aEnd = new Date(`${row.end_date}T00:00:00Z`);
    const cursor = new Date(Math.max(aStart.getTime(), start.getTime()));
    const stop = new Date(Math.min(aEnd.getTime(), end.getTime()));
    while (cursor <= stop) {
      locked.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return [...locked].sort();
}

/** Пытается найти отдел сотрудника на дату среди managed-отделов запроса. */
async function resolveEmployeeManagedDepartment(
  req: AuthenticatedRequest,
  employeeId: number,
  workDate: string,
): Promise<string | null> {
  const managedDepartmentIds = await resolveManagedDepartmentIds(req);
  for (const departmentId of managedDepartmentIds) {
    if (await isEmployeeAssignedToDepartmentOnDate(employeeId, departmentId, workDate)) {
      return departmentId;
    }
  }
  return null;
}

/** Проверяет, заблокирована ли редакция записи табеля руководителем (approved/submitted/returned диапазон). */
async function ensureNotLockedForScope(
  req: AuthenticatedRequest,
  scope: string | null,
  employeeId: number,
  workDate: string,
): Promise<IApprovalLockInfo | null> {
  if (scope !== 'department') return null;
  const departmentId = await resolveEmployeeManagedDepartment(req, employeeId, workDate);
  if (!departmentId) return null;
  return findApprovalLockForDate(departmentId, workDate);
}

function toMonthIndex(year: number, month: number): number {
  return year * 12 + month - 1;
}

function isDepartmentMonthAllowed(year: number, month: number, referenceDate = new Date()): boolean {
  const requestedMonthIndex = toMonthIndex(year, month);
  const currentMonthIndex = toMonthIndex(referenceDate.getFullYear(), referenceDate.getMonth() + 1);
  return requestedMonthIndex >= currentMonthIndex - 1 && requestedMonthIndex <= currentMonthIndex;
}

async function resolvePlannedHoursByItems(items: Array<{ employee_id: number; work_date: string }>): Promise<Map<string, number>> {
  const uniqueItems = Array.from(
    new Map(items.map(item => [`${item.employee_id}_${item.work_date}`, item] as const)).values(),
  );
  if (uniqueItems.length === 0) return new Map();

  const employeeIds = [...new Set(uniqueItems.map(item => item.employee_id))];
  const { data: employees, error } = await supabase
    .from('employees')
    .select('id, work_category')
    .in('id', employeeIds);
  if (error) throw error;

  const employeeRows = (employees || []).map(employee => ({
    id: Number(employee.id),
    work_category: (employee.work_category as WorkCategory | null) ?? null,
  }));

  const startDate = uniqueItems.reduce((min, item) => (item.work_date < min ? item.work_date : min), uniqueItems[0].work_date);
  const endDate = uniqueItems.reduce((max, item) => (item.work_date > max ? item.work_date : max), uniqueItems[0].work_date);
  const schedules = await resolveSchedulesForPeriod(employeeRows, startDate, endDate);

  return new Map(uniqueItems.map(item => {
    const schedule = schedules.get(item.employee_id)?.get(item.work_date);
    const plannedHours = schedule
      ? getScheduleForDate(schedule, new Date(`${item.work_date}T00:00:00`)).work_hours
      : 8;
    return [`${item.employee_id}_${item.work_date}`, plannedHours] as const;
  }));
}

async function resolvePlannedHoursForObjectItem(params: {
  employee_id: number;
  work_date: string;
  object_id?: string | null;
}): Promise<number | null> {
  const { data: employee, error } = await supabase
    .from('employees')
    .select('id, work_category')
    .eq('id', params.employee_id)
    .maybeSingle();

  if (error) throw error;
  if (!employee) return null;

  const employeeSchedule = await resolveSchedulesForPeriod(
    [{
      id: Number(employee.id),
      work_category: (employee.work_category as WorkCategory | null) ?? null,
    }],
    params.work_date,
    params.work_date,
  );

  const objectSchedule = params.object_id
    ? await resolveObjectSchedule(params.object_id, params.work_date)
    : null;
  const effectiveSchedule = objectSchedule || employeeSchedule.get(params.employee_id)?.get(params.work_date) || null;
  if (!effectiveSchedule) return null;

  return getScheduleForDate(effectiveSchedule, new Date(`${params.work_date}T00:00:00`)).work_hours;
}

async function canAccessEmployeeForTimesheetDate(
  req: AuthenticatedRequest,
  employeeId: number | null | undefined,
  workDate: string,
): Promise<boolean> {
  if (!employeeId) {
    return false;
  }

  const scope = await resolveTimesheetScope(req);
  if (!scope) {
    return false;
  }

  if (scope === 'all') {
    return true;
  }

  if (scope === 'self') {
    return req.user.employee_id === employeeId;
  }

  if (scope === 'department' && req.user.employee_id === employeeId) {
    return true;
  }

  const managedDepartmentIds = await resolveManagedDepartmentIds(req);
  if (managedDepartmentIds.length === 0) {
    return false;
  }

  const matches = await Promise.all(
    managedDepartmentIds.map(departmentId => isEmployeeAssignedToDepartmentOnDate(employeeId, departmentId, workDate)),
  );
  return matches.some(Boolean);
}

async function canAccessEmployeeForTimesheetPeriod(
  req: AuthenticatedRequest,
  employeeId: number | null | undefined,
  startDate: string,
  endDate: string,
): Promise<boolean> {
  if (!employeeId) {
    return false;
  }

  const scope = await resolveTimesheetScope(req);
  if (!scope) {
    return false;
  }

  if (scope === 'all') {
    return true;
  }

  if (scope === 'self') {
    return req.user.employee_id === employeeId;
  }

  if (scope === 'department' && req.user.employee_id === employeeId) {
    return true;
  }

  const managedDepartmentIds = await resolveManagedDepartmentIds(req);
  if (managedDepartmentIds.length === 0) {
    return false;
  }

  const employeeIdsByDepartment = await Promise.all(
    managedDepartmentIds.map(departmentId => listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate)),
  );
  return employeeIdsByDepartment.flat().includes(employeeId);
}

function clampInputHoursForScope(
  scope: string | null,
  hoursWorked: number | null | undefined,
  plannedHours: number | null | undefined,
): number | null | undefined {
  if (hoursWorked == null || plannedHours == null || scope !== 'department') {
    return hoursWorked;
  }

  return Math.max(0, Math.min(hoursWorked, plannedHours));
}

async function resolveAllowedObjectHours(
  scope: string | null,
  employeeId: number,
  workDate: string,
  objectId: string | null | undefined,
  requestedHours: number,
): Promise<number> {
  if (scope !== 'department') {
    return requestedHours;
  }

  const plannedHours = await resolvePlannedHoursForObjectItem({
    employee_id: employeeId,
    work_date: workDate,
    object_id: objectId ?? null,
  });
  if (plannedHours == null) {
    return requestedHours;
  }

  return Math.max(0, Math.min(requestedHours, plannedHours));
}

async function hasManagedTimesheetAccess(
  req: AuthenticatedRequest,
  action: 'view' | 'edit',
): Promise<boolean> {
  const checker = action === 'edit' ? hasPageEdit : hasPageView;
  const checks = await Promise.all(MANAGED_TIMESHEET_PAGE_KEYS.map(pageKey => checker(req.user.role_code, pageKey)));
  return checks.some(Boolean);
}

async function resolveTimesheetScope(req: AuthenticatedRequest): Promise<DataScope | null> {
  if (req.user.is_admin) {
    return 'all';
  }

  if (await hasManagedTimesheetAccess(req, 'view')) {
    const managedDepartmentIds = await resolveManagedDepartmentIds(req);
    if (managedDepartmentIds.length > 0) {
      return 'department';
    }
  }

  if (req.user.employee_id) {
    return 'self';
  }

  return null;
}

async function resolveTimesheetScopedDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId?: string | null,
): Promise<string | null> {
  const scope = await resolveTimesheetScope(req);
  if (!scope) {
    return null;
  }

  if (scope === 'all') {
    return requestedDepartmentId ?? null;
  }

  if (scope === 'department') {
    return resolveScopedDepartmentId(req, requestedDepartmentId);
  }

  return null;
}

async function isTimesheetTeamManagementAvailable(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.is_admin) {
    return true;
  }

  if (await hasPageEdit(req.user.role_code, TIMESHEET_TEAM_MANAGEMENT_PAGE_KEY)) {
    return hasManagedTimesheetAccess(req, 'view');
  }

  return hasManagedTimesheetAccess(req, 'edit');
}

async function resolveManagedDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId: string,
): Promise<string | null> {
  const scope = await resolveTimesheetScope(req);
  if (!scope || scope === 'self') return null;
  return resolveTimesheetScopedDepartmentId(req, requestedDepartmentId);
}

const APPROVAL_STATUS_PRIORITY: Record<TimesheetApprovalStatus, number> = {
  rejected: 4,
  returned: 3,
  submitted: 2,
  approved: 1,
  draft: 0,
};

function pickDominantApprovalStatus(
  approvals: Array<{ status: TimesheetApprovalStatus }>,
): TimesheetApprovalStatus | null {
  if (approvals.length === 0) return null;
  return approvals.reduce<TimesheetApprovalStatus>((acc, current) => (
    APPROVAL_STATUS_PRIORITY[current.status] > APPROVAL_STATUS_PRIORITY[acc]
      ? current.status
      : acc
  ), approvals[0].status);
}

async function buildManagedDepartmentTimesheetSummary(params: {
  departmentId: string;
  month: string;
  startDate: string;
  endDate: string;
  isPrimary: boolean;
}): Promise<IManagedDepartmentTimesheetSummary> {
  const data = await fetchTimesheetDataForDepartment(
    params.month,
    params.departmentId,
    { startDate: params.startDate, endDate: params.endDate },
    'capped_to_schedule',
  );

  let normHours = 0;
  for (const employee of data.employees) {
    for (const day of data.exportDays) {
      const dateStr = `${params.month}-${String(day).padStart(2, '0')}`;
      const schedule = data.dailySchedulesMap.get(employee.id)?.get(dateStr);
      if (!schedule || !isWorkingDay(schedule, new Date(data.year, data.mon - 1, day), data.calendarMonth)) {
        continue;
      }
      normHours += getScheduleForDate(schedule, new Date(data.year, data.mon - 1, day)).work_hours;
    }
  }

  let actualHours = 0;
  const deviations = { late: 0, absent: 0, sick: 0 };
  for (const entry of data.entries) {
    const visibleHours = entry.display_hours_worked ?? entry.hours_worked;
    if (typeof visibleHours === 'number') {
      actualHours += visibleHours;
    }
    if (entry.status === 'absent') deviations.absent++;
    if (entry.status === 'sick') deviations.sick++;

    const workDate = entry.work_date;
    const schedule = data.dailySchedulesMap.get(entry.employee_id)?.get(workDate) || data.schedulesMap.get(entry.employee_id);
    const lateThreshold = schedule ? getEffectiveLateThreshold(schedule, new Date(`${workDate}T00:00:00`)) : '09:00:00';
    if (entry.status === 'work' && entry.first_entry && entry.first_entry > lateThreshold) {
      deviations.late++;
    }
  }

  const { data: approvals, error: approvalsError } = await supabase
    .from('timesheet_approvals')
    .select('id, start_date, end_date, status')
    .eq('department_id', params.departmentId)
    .lte('start_date', params.endDate)
    .gte('end_date', params.startDate);

  if (approvalsError) {
    throw approvalsError;
  }

  const approvalsTyped = (approvals || []).map(row => ({
    id: Number(row.id),
    start_date: String(row.start_date),
    end_date: String(row.end_date),
    status: row.status as TimesheetApprovalStatus,
  }));

  return {
    department_id: params.departmentId,
    department_name: data.departmentName,
    employee_count: data.employees.length,
    norm_hours: normHours,
    actual_hours: actualHours,
    deviations,
    approval_status: pickDominantApprovalStatus(approvalsTyped),
    approvals: approvalsTyped,
    is_primary: params.isPrimary,
  };
}

export const timesheetController = {
  /** GET /api/timesheet/overview?month=YYYY-MM&from=YYYY-MM-DD&to=YYYY-MM-DD */
  async getOverview(req: AuthenticatedRequest, res: Response) {
    try {
      const month = typeof req.query.month === 'string' ? req.query.month : null;
      const fromParam = typeof req.query.from === 'string' ? req.query.from : null;
      const toParam = typeof req.query.to === 'string' ? req.query.to : null;
      const scope = await resolveTimesheetScope(req);
      if (scope !== 'department') {
        return res.status(403).json({ success: false, error: 'Overview табелей доступен только для руководителей отделов' });
      }
      if (!month) {
        return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
      }
      const periodRange = (fromParam && toParam)
        ? resolveTimesheetDateRange(month, fromParam, toParam)
        : resolveTimesheetPeriodRange(month, typeof req.query.half === 'string' ? req.query.half : null);
      if (!periodRange) {
        return res.status(400).json({ success: false, error: 'Некорректный диапазон' });
      }

      const managedDepartmentIds = await resolveManagedDepartmentIds(req);
      if (managedDepartmentIds.length === 0) {
        return res.json({ success: true, data: [] });
      }

      const summaries = await Promise.all(
        managedDepartmentIds.map(departmentId => buildManagedDepartmentTimesheetSummary({
          departmentId,
          month,
          startDate: periodRange.startDate,
          endDate: periodRange.endDate,
          isPrimary: departmentId === req.user.department_id,
        })),
      );

      res.json({
        success: true,
        data: summaries.sort((left, right) => {
          if (left.is_primary !== right.is_primary) {
            return left.is_primary ? -1 : 1;
          }
          return left.department_name.localeCompare(right.department_name, 'ru');
        }),
      });
    } catch (err) {
      console.error('timesheet.getOverview error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки обзора табелей' });
    }
  },

  /** GET /api/timesheet?month=YYYY-MM&department_id=...&employee_id=... */
  async getAll(req: AuthenticatedRequest, res: Response) {
    try {
      const month = typeof req.query.month === 'string' ? req.query.month : null;
      const scope = await resolveTimesheetScope(req);
      if (!scope) {
        return res.status(403).json({ success: false, error: 'Data scope не настроен для роли' });
      }
      const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
      const requestedEmployeeId = typeof req.query.employee_id === 'string'
        ? Number.parseInt(req.query.employee_id, 10)
        : null;
      const department_id = await resolveTimesheetScopedDepartmentId(req, requestedDepartmentId);

      if (!month) {
        return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
      }
      const fromParam = typeof req.query.from === 'string' ? req.query.from : null;
      const toParam = typeof req.query.to === 'string' ? req.query.to : null;
      const periodRange = (fromParam && toParam)
        ? resolveTimesheetDateRange(month, fromParam, toParam)
        : resolveTimesheetPeriodRange(month, typeof req.query.half === 'string' ? req.query.half : null);
      if (!periodRange) {
        return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
      }

      const { year, month: mon, startDate, endDate } = periodRange;
      const today = new Date();
      if (scope === 'department' && !isDepartmentMonthAllowed(year, mon, today)) {
        return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
      }
      const todayStr = formatDateToISO(today);

      const hasDeptFilter = department_id && typeof department_id === 'string';
      const hasEmployeeFilter = Number.isInteger(requestedEmployeeId) && (requestedEmployeeId as number) > 0;
      const emptyResponse = {
        success: true,
        data: {
          employees: [],
          entries: [],
          object_entries: [],
          schedules: {},
          daily_schedules: {},
          calendar: null,
          stats: {
            employeeCount: 0,
            workingDays: 0,
            normHours: 0,
            actualHours: 0,
            deviations: { late: 0, absent: 0, sick: 0 },
          },
        },
      };

      if (hasEmployeeFilter && !(await canAccessEmployeeForTimesheetPeriod(req, requestedEmployeeId, startDate, endDate))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }

      if (
        hasEmployeeFilter
        && isSelfEmployeeRequest(req, requestedEmployeeId)
        && startDate < getMinSelfHistoryDate()
      ) {
        return res.status(403).json({ success: false, error: 'Доступ только за текущий и прошлый месяц' });
      }

      if (scope === 'self' && !req.user.employee_id) {
        return res.json(emptyResponse);
      }

      if (scope !== 'self' && !hasDeptFilter && !hasEmployeeFilter) {
        return res.json(emptyResponse);
      }

      // При фильтре по конкретному сотруднику доступ уже проверен в canAccessEmployeeForTimesheetPeriod;
      // дополнительный AND по авто-резолвнутому department_id ломает кейс «руководитель ведёт несколько отделов,
      // сотрудник числится не в первом».
      const shouldApplyDeptFilter = hasDeptFilter && !hasEmployeeFilter;
      const departmentEmployeeIds = shouldApplyDeptFilter
        ? await listEmployeeIdsAssignedToDepartmentPeriod(department_id as string, startDate, endDate)
        : [];
      if (shouldApplyDeptFilter && departmentEmployeeIds.length === 0) {
        return res.json(emptyResponse);
      }

      // Для approvals при запросе конкретного сотрудника берём его фактический отдел в managed-поддереве,
      // иначе approval_locked_dates прилетят от чужого отдела.
      let effectiveApprovalDeptId: string | null = department_id ?? null;
      if (hasEmployeeFilter && scope === 'department') {
        effectiveApprovalDeptId =
          (await resolveEmployeeManagedDepartment(req, requestedEmployeeId as number, endDate))
          ?? department_id
          ?? null;
      }

      let empQuery = supabase
        .from('employees')
        .select('id, full_name, position_id, org_department_id, employment_status, work_category')
        .eq('employment_status', 'active')
        .eq('is_archived', false)
        .eq('excluded_from_timesheet', false)
        .order('full_name');

      if (shouldApplyDeptFilter) {
        empQuery = empQuery.in('id', departmentEmployeeIds);
      }
      if (hasEmployeeFilter) {
        empQuery = empQuery.eq('id', requestedEmployeeId as number);
      } else if (scope === 'self' && req.user.employee_id) {
        empQuery = empQuery.eq('id', req.user.employee_id);
      }

      const { data: employees, error: empError } = await empQuery;
      if (empError) throw empError;

      // [DEBUG] временный лог — удалю после починки
      console.log('[DEBUG timesheet.getAll]', {
        scope,
        is_admin: req.user.is_admin,
        user_employee_id: req.user.employee_id,
        requestedEmployeeId,
        requestedDepartmentId,
        resolved_department_id: department_id,
        hasDeptFilter,
        hasEmployeeFilter,
        shouldApplyDeptFilter,
        departmentEmployeeIds_len: departmentEmployeeIds.length,
        employees_returned: (employees || []).length,
        employee_ids_returned: (employees || []).map(e => e.id),
      });

      const employeeIds = (employees || []).map(e => Number(e.id)).filter(Number.isFinite);

      const empList = (employees || []).map(e => ({
        id: Number(e.id),
        work_category: (e.work_category as string | null) || null,
      }));
      const [dailySchedulesMap, calendarMonth] = await Promise.all([
        resolveSchedulesForPeriod(empList, startDate, endDate),
        loadCalendarMonth(year, mon),
      ]);
      const referenceDate = todayStr < startDate ? startDate : (todayStr > endDate ? endDate : todayStr);
      const schedulesMap = new Map<number, IResolvedSchedule>();
      for (const [employeeId, dailyMap] of dailySchedulesMap) {
        const schedule = dailyMap.get(referenceDate) || dailyMap.get(startDate);
        if (schedule) schedulesMap.set(employeeId, schedule);
      }

      // Fetch position names
      const positionIds = [...new Set((employees || []).map(e => e.position_id).filter(Boolean))];
      const posMap = new Map<string, string>();
      if (positionIds.length > 0) {
        const { data: positions } = await supabase
          .from('positions')
          .select('id, name')
          .in('id', positionIds);
        (positions || []).forEach((p: { id: string; name: string }) => posMap.set(p.id, p.name));
      }

      const { entries, objectEntries } = await buildAttendanceEntries({
        employees: (employees || []).map(employee => ({
          id: Number(employee.id),
          full_name: (employee.full_name as string | null) || null,
          work_category: (employee.work_category as string | null) || null,
        })),
        startDate,
        endDate,
        dailySchedulesMap,
        calendarMonth,
        todayStr,
        displayMode: scope === 'department' ? 'capped_to_schedule' : 'actual',
      });

      const startDay = Number.parseInt(startDate.slice(-2), 10);
      const endDay = Number.parseInt(endDate.slice(-2), 10);

      // Compute stats (schedule-aware)
      let normHours = 0;
      let totalWorkingDays = 0;
      const employeeStatsMap = new Map<number, { norm_hours: number; fact_hours: number }>();
      for (const empId of employeeIds) {
        let empWorkDays = 0;
        let empNormHours = 0;
        for (let d = startDay; d <= endDay; d++) {
          const dateObj = new Date(year, mon - 1, d);
          const dateStr = `${month}-${String(d).padStart(2, '0')}`;
          if (dateStr > todayStr) continue;

          const sched = dailySchedulesMap.get(empId)?.get(dateStr);
          if (!sched) continue;
          if (!isWorkingDay(sched, dateObj, calendarMonth)) continue;

          empWorkDays++;
          empNormHours += getScheduleForDate(sched, dateObj).work_hours;
        }

        normHours += empNormHours;
        totalWorkingDays = Math.max(totalWorkingDays, empWorkDays);
        employeeStatsMap.set(empId, { norm_hours: empNormHours, fact_hours: 0 });
      }

      let actualHours = 0;
      const deviations = { late: 0, absent: 0, sick: 0 };

      for (const entry of entries) {
        const visibleHours = entry.display_hours_worked ?? entry.hours_worked;
        if (typeof visibleHours === 'number') {
          actualHours += visibleHours;
          const empStats = employeeStatsMap.get(entry.employee_id as number);
          if (empStats) empStats.fact_hours += visibleHours;
        }
        if (entry.status === 'absent') deviations.absent++;
        if (entry.status === 'sick') deviations.sick++;

        // Проверка опоздания по времени прихода
        const workDate = entry.work_date as string;
        const entryDate = new Date(`${workDate}T00:00:00`);
        const empSched = dailySchedulesMap.get(entry.employee_id as number)?.get(workDate) || schedulesMap.get(entry.employee_id as number);
        const lateThreshold = empSched ? getEffectiveLateThreshold(empSched, entryDate) : '09:00:00';
        if (entry.status === 'work' && entry.first_entry && entry.first_entry > lateThreshold) {
          deviations.late++;
        }
      }

      const employeesWithNames = (employees || []).map(e => ({
        ...e,
        position_name: e.position_id ? posMap.get(e.position_id) || null : null,
      }));

      // Сериализация графиков для фронтенда
      const schedulesObj: Record<number, IResolvedSchedule> = {};
      for (const [id, sched] of schedulesMap) {
        schedulesObj[id] = sched;
      }
      const dailySchedulesObj: Record<number, Record<string, IResolvedSchedule>> = {};
      for (const [employeeId, dailyMap] of dailySchedulesMap) {
        dailySchedulesObj[employeeId] = {};
        for (const [date, sched] of dailyMap) {
          dailySchedulesObj[employeeId][date] = sched;
        }
      }

      // Согласования, пересекающиеся с выбранным диапазоном отдела.
      // Для scope=department они дают список заблокированных дат (руководитель не может редактировать submitted/approved/returned).
      let departmentApprovals: Array<{ id: number; start_date: string; end_date: string; status: TimesheetApprovalStatus }> = [];
      let approvalLockedDates: string[] = [];
      if (effectiveApprovalDeptId) {
        const { data: approvalsRows, error: approvalsErr } = await supabase
          .from('timesheet_approvals')
          .select('id, start_date, end_date, status')
          .eq('department_id', effectiveApprovalDeptId)
          .lte('start_date', endDate)
          .gte('end_date', startDate)
          .order('start_date', { ascending: true });
        if (approvalsErr) throw approvalsErr;
        departmentApprovals = (approvalsRows || []).map(row => ({
          id: Number(row.id),
          start_date: String(row.start_date),
          end_date: String(row.end_date),
          status: row.status as TimesheetApprovalStatus,
        }));
        if (scope === 'department') {
          approvalLockedDates = await loadApprovalLockedDatesForDepartment(
            effectiveApprovalDeptId,
            startDate,
            endDate,
          );
        }
      }

      res.json({
        success: true,
        data: {
          employees: employeesWithNames,
          entries,
          object_entries: objectEntries,
          schedules: schedulesObj,
          daily_schedules: dailySchedulesObj,
          calendar: calendarMonth,
          stats: {
            employeeCount: employeeIds.length,
            workingDays: totalWorkingDays,
            normHours,
            actualHours,
            deviations,
          },
          employee_stats: [...employeeStatsMap.entries()].map(([employee_id, value]) => ({
            employee_id,
            norm_hours: Math.round(value.norm_hours * 100) / 100,
            fact_hours: Math.round(value.fact_hours * 100) / 100,
            deviation_hours: Math.round((value.norm_hours - value.fact_hours) * 100) / 100,
          })),
          approvals: departmentApprovals,
          approval_locked_dates: approvalLockedDates,
        },
      });
    } catch (err) {
      console.error('timesheet.getAll error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки табеля' });
    }
  },

  /** POST /api/timesheet */
  async create(req: AuthenticatedRequest, res: Response) {
    try {
      const parsed = createEntrySchema.parse(req.body);
      const scope = await resolveTimesheetScope(req);
      if (scope === 'department') {
        const [yearStr, monthStr] = parsed.work_date.split('-');
        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
        }
      }
      if (!(await canAccessEmployeeForTimesheetDate(req, parsed.employee_id, parsed.work_date))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }
      const approvalLock = await ensureNotLockedForScope(req, scope, parsed.employee_id, parsed.work_date);
      if (approvalLock) {
        return res.status(409).json({
          success: false,
          error: `Период ${approvalLock.start_date} – ${approvalLock.end_date} уже ${approvalLock.status === 'approved' ? 'утверждён' : 'на проверке'}. Редактирование закрыто.`,
        });
      }
      const plannedHours = (await resolvePlannedHoursByItems([{ employee_id: parsed.employee_id, work_date: parsed.work_date }]))
        .get(`${parsed.employee_id}_${parsed.work_date}`) ?? null;
      const normalizedHours = parsed.status === 'remote'
        ? (plannedHours ?? 8)
        : (clampInputHoursForScope(scope, parsed.hours_worked ?? null, plannedHours) ?? null);

      const approvalStatus = await resolveAdjustmentApprovalStatus(parsed.employee_id, parsed.work_date);

	      const raw = await upsertAttendanceAdjustment({
	        employee_id: parsed.employee_id,
	        work_date: parsed.work_date,
	        status: parsed.status,
	        hours_override: normalizedHours,
	        source_type: 'manual',
	        source_id: 'manual',
	        reason: parsed.notes ?? null,
	        created_by: req.user.id,
          approval_status: approvalStatus,
	      });

	      const data = {
	        id: Number(raw.id),
	        employee_id: parsed.employee_id,
	        work_date: parsed.work_date,
	        status: parsed.status,
	        hours_worked: normalizedHours,
          display_hours_worked: normalizedHours,
	        notes: parsed.notes ?? null,
	        is_correction: true,
	        corrected_at: String(raw.updated_at ?? raw.created_at ?? new Date().toISOString()),
	        corrected_by_name: null,
	      };

	      const auditFullName = await loadEmployeeFullNameForAudit(parsed.employee_id);

	      await auditService.logFromRequest(req, req.user.id, 'CREATE_TIMESHEET_ENTRY', {
	        entityType: 'timesheet',
	        entityId: String(data.id),
	        details: {
	          employee_id: parsed.employee_id,
          employee_full_name: auditFullName,
          work_date: parsed.work_date,
          status: parsed.status,
        },
      });

      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.create error:', err);
      res.status(500).json({ success: false, error: 'Ошибка создания записи' });
    }
  },

  /** PUT /api/timesheet/:id */
  async update(req: AuthenticatedRequest, res: Response) {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ success: false, error: 'Некорректный ID' });

	      const parsed = updateEntrySchema.parse(req.body);
	      const existing = await getAttendanceAdjustmentById(id);
	      if (!existing) {
	        return res.status(404).json({ success: false, error: 'Запись не найдена' });
	      }
	      if (String(existing.source_type) === OBJECT_ADJUSTMENT_SOURCE_TYPE) {
	        return res.status(409).json({ success: false, error: 'Для корректировки объекта используйте отдельный endpoint object-entry' });
	      }
	      const scope = await resolveTimesheetScope(req);
	      if (scope === 'department') {
	        const workDate = String(existing.work_date ?? '');
	        const [yearStr, monthStr] = workDate.split('-');
	        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
	          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
	        }
	      }
	      if (!(await canAccessEmployeeForTimesheetDate(req, Number(existing.employee_id), String(existing.work_date)))) {
	        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
	      }
	      const existingCreatedBy = typeof existing.created_by === 'string' ? existing.created_by : null;
	      if (scope === 'department' && existingCreatedBy && existingCreatedBy !== req.user.id) {
	        return res.status(403).json({ success: false, error: 'Редактировать можно только свои корректировки' });
	      }
	      const approvalLockUpdate = await ensureNotLockedForScope(
	        req,
	        scope,
	        Number(existing.employee_id),
	        String(existing.work_date),
	      );
	      if (approvalLockUpdate) {
	        return res.status(409).json({
	          success: false,
	          error: `Период ${approvalLockUpdate.start_date} – ${approvalLockUpdate.end_date} уже ${approvalLockUpdate.status === 'approved' ? 'утверждён' : 'на проверке'}. Редактирование закрыто.`,
	        });
	      }
        const nextStatus = (parsed.status ?? String(existing.status)) as TimeStatus;
        const plannedHours = (await resolvePlannedHoursByItems([{
          employee_id: Number(existing.employee_id),
          work_date: String(existing.work_date),
        }])).get(`${Number(existing.employee_id)}_${String(existing.work_date)}`) ?? null;
        const normalizedHours = nextStatus === 'remote'
          ? (plannedHours ?? 8)
          : clampInputHoursForScope(scope, parsed.hours_worked, plannedHours);

        const approvalStatus = await resolveAdjustmentApprovalStatus(
          Number(existing.employee_id),
          String(existing.work_date),
        );

	      const updated = await updateAttendanceAdjustmentById(id, {
	        ...(parsed.status ? { status: parsed.status } : {}),
	        ...(nextStatus === 'remote'
            ? { hours_override: normalizedHours }
            : (normalizedHours !== undefined ? { hours_override: normalizedHours } : {})),
	        ...(parsed.notes !== undefined ? { reason: parsed.notes ?? null } : {}),
	        updated_by: req.user.id,
          approval_status: approvalStatus,
	      });
	      if (!updated) return res.status(404).json({ success: false, error: 'Запись не найдена' });

        const actualHours = typeof updated.hours_override === 'number'
          ? updated.hours_override
          : (typeof updated.hours_worked === 'number' ? updated.hours_worked : null);
        const displayHours = typeof actualHours === 'number'
          ? (clampInputHoursForScope(scope, actualHours, plannedHours) ?? actualHours)
          : actualHours;

	      const data = {
	        id: Number(updated.id),
	        employee_id: Number(updated.employee_id),
	        work_date: String(updated.work_date),
	        status: String(updated.status),
	        hours_worked: actualHours,
          display_hours_worked: displayHours,
	        notes: typeof updated.reason === 'string' ? updated.reason : null,
	        is_correction: true,
	        corrected_at: String(updated.updated_at ?? updated.created_at ?? new Date().toISOString()),
	        corrected_by_name: null,
	      };

	      const auditFullNameUpd = await loadEmployeeFullNameForAudit(Number(updated.employee_id));

	      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
	        entityType: 'timesheet',
	        entityId: String(id),
	        details: {
	          ...parsed,
	          employee_id: Number(updated.employee_id),
	          employee_full_name: auditFullNameUpd,
	          work_date: String(updated.work_date),
	        },
      });

      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.update error:', err);
      const message = err instanceof Error ? err.message : '';
      if (/schema cache/i.test(message)) {
        return res.status(503).json({
          success: false,
          error: 'Схема БД устарела в кэше PostgREST. Выполните NOTIFY pgrst, \'reload schema\' и повторите.',
        });
      }
      res.status(500).json({ success: false, error: 'Ошибка обновления записи' });
    }
  },

  /** POST /api/timesheet/bulk */
  async bulkSave(req: AuthenticatedRequest, res: Response) {
    try {
      const parsed = bulkCorrectionSchema.parse(req.body);
      const scope = await resolveTimesheetScope(req);
      const uniqueItems = Array.from(
        new Map(
          parsed.items.map(item => [`${item.employee_id}_${item.work_date}`, item] as const),
        ).values(),
      );
      if (scope === 'department') {
        const hasForbiddenMonth = uniqueItems.some(item => {
          const [yearStr, monthStr] = item.work_date.split('-');
          return !isDepartmentMonthAllowed(Number(yearStr), Number(monthStr));
        });
        if (hasForbiddenMonth) {
          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
        }
      }
      const accessResults = await Promise.all(
        uniqueItems.map(async item => ({
          employeeId: item.employee_id,
          workDate: item.work_date,
          allowed: await canAccessEmployeeForTimesheetDate(req, item.employee_id, item.work_date),
        })),
      );
      const denied = accessResults.find(result => !result.allowed);
      if (denied) {
        return res.status(403).json({ success: false, error: 'Нет доступа к одному или нескольким сотрудникам' });
      }
      const lockResults = await Promise.all(
        uniqueItems.map(item => ensureNotLockedForScope(req, scope, item.employee_id, item.work_date)),
      );
      const lockedItem = lockResults.find(info => info !== null);
      if (lockedItem) {
        return res.status(409).json({
          success: false,
          error: `Период ${lockedItem.start_date} – ${lockedItem.end_date} уже ${lockedItem.status === 'approved' ? 'утверждён' : 'на проверке'}. Редактирование закрыто.`,
        });
      }
      const employeeIds = [...new Set(uniqueItems.map(item => item.employee_id))];
      const plannedHoursByItem = await resolvePlannedHoursByItems(uniqueItems);

      await Promise.all(uniqueItems.map(item => upsertAttendanceAdjustment({
        employee_id: item.employee_id,
        work_date: item.work_date,
        status: parsed.status,
        hours_override: parsed.status === 'remote'
          ? (plannedHoursByItem.get(`${item.employee_id}_${item.work_date}`) ?? 8)
          : (clampInputHoursForScope(
            scope,
            parsed.hours_worked ?? null,
            plannedHoursByItem.get(`${item.employee_id}_${item.work_date}`) ?? null,
          ) ?? null),
        source_type: 'manual',
        source_id: 'manual',
        reason: parsed.notes ?? null,
        created_by: req.user.id,
      })));

      const auditNamesMap = await loadEmployeeFullNamesMap(employeeIds);
      const auditEmployeeNames = employeeIds
        .map(empId => auditNamesMap.get(empId))
        .filter((name): name is string => Boolean(name));
      const MAX_AUDIT_NAMES = 10;
      const truncatedNames = auditEmployeeNames.length > MAX_AUDIT_NAMES
        ? [
            ...auditEmployeeNames.slice(0, MAX_AUDIT_NAMES),
            `+${auditEmployeeNames.length - MAX_AUDIT_NAMES}`,
          ]
        : auditEmployeeNames;
      const sortedDates = uniqueItems.map(item => item.work_date).sort();
      const dateFrom = sortedDates[0] ?? null;
      const dateTo = sortedDates[sortedDates.length - 1] ?? null;

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet',
        entityId: `bulk:${Date.now()}`,
        details: {
          count: uniqueItems.length,
          employees: employeeIds.length,
          status: parsed.status,
          employee_names: truncatedNames,
          date_from: dateFrom,
          date_to: dateTo,
        },
      });

      res.json({
        success: true,
        data: {
          processed: uniqueItems.length,
          employees: employeeIds.length,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.bulkSave error:', err);
      res.status(500).json({ success: false, error: 'Ошибка массового обновления табеля' });
    }
  },

  /** PUT /api/timesheet/object-entry */
  async upsertObjectEntry(req: AuthenticatedRequest, res: Response) {
    try {
      const parsed = upsertObjectEntrySchema.parse(req.body);
      const scope = await resolveTimesheetScope(req);
      if (scope === 'department') {
        const [yearStr, monthStr] = parsed.work_date.split('-');
        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
        }
      }
      if (!(await canAccessEmployeeForTimesheetDate(req, parsed.employee_id, parsed.work_date))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }
      const approvalLockObj = await ensureNotLockedForScope(req, scope, parsed.employee_id, parsed.work_date);
      if (approvalLockObj) {
        return res.status(409).json({
          success: false,
          error: `Период ${approvalLockObj.start_date} – ${approvalLockObj.end_date} уже ${approvalLockObj.status === 'approved' ? 'утверждён' : 'на проверке'}. Редактирование закрыто.`,
        });
      }
      const allowedHours = await resolveAllowedObjectHours(
        scope,
        parsed.employee_id,
        parsed.work_date,
        parsed.object_id,
        parsed.hours_worked,
      );

      const raw = await upsertAttendanceAdjustment({
        employee_id: parsed.employee_id,
        work_date: parsed.work_date,
        status: 'manual',
        hours_override: allowedHours,
        source_type: OBJECT_ADJUSTMENT_SOURCE_TYPE,
        source_id: parsed.object_key,
        reason: parsed.notes ?? null,
        created_by: req.user.id,
        metadata: {
          object_id: parsed.object_id ?? null,
          object_name: parsed.object_name,
        },
      });

      const auditFullNameObj = await loadEmployeeFullNameForAudit(parsed.employee_id);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet_object_entry',
        entityId: `${parsed.employee_id}:${parsed.work_date}:${parsed.object_key}`,
        details: {
          employee_id: parsed.employee_id,
          employee_full_name: auditFullNameObj,
          work_date: parsed.work_date,
          object_key: parsed.object_key,
          object_name: parsed.object_name,
          hours_worked: allowedHours,
        },
      });

      res.json({
        success: true,
        data: {
          adjustment_id: Number(raw.id),
          employee_id: parsed.employee_id,
          work_date: parsed.work_date,
          object_key: parsed.object_key,
          object_id: parsed.object_id ?? null,
          object_name: parsed.object_name,
          hours_worked: allowedHours,
          display_hours_worked: allowedHours,
          base_hours_worked: allowedHours,
          is_correction: true,
          notes: parsed.notes ?? null,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.upsertObjectEntry error:', err);
      res.status(500).json({ success: false, error: 'Ошибка сохранения корректировки по объекту' });
    }
  },

  /** GET /api/timesheet/team-management-config */
  async getTeamManagementConfig(req: AuthenticatedRequest, res: Response) {
    try {
      const enabled = await isTimesheetTeamManagementAvailable(req);
      const scope = await resolveTimesheetScope(req);
      res.json({
        success: true,
        data: {
          enabled,
          scope,
          can_manage: enabled && scope !== 'self',
        },
      });
    } catch (err) {
      console.error('timesheet.getTeamManagementConfig error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки настроек управления составом табеля' });
    }
  },

  /** GET /api/timesheet/team-management/search-employees?q=...&department_id=... */
  async searchTeamEmployees(req: AuthenticatedRequest, res: Response) {
    try {
      const enabled = await isTimesheetTeamManagementAvailable(req);
      if (!enabled) {
        return res.status(403).json({ success: false, error: 'Недостаточно прав для управления составом табеля' });
      }

      const parsed = teamManagementSearchSchema.parse({
        q: typeof req.query.q === 'string' ? req.query.q : '',
        department_id: typeof req.query.department_id === 'string' ? req.query.department_id : '',
      });

      const targetDepartmentId = await resolveManagedDepartmentId(req, parsed.department_id);
      if (!targetDepartmentId) {
        return res.status(403).json({ success: false, error: 'Нет доступа к управлению составом этого отдела' });
      }

      const { data: employees, error } = await supabase
        .from('employees')
        .select('id, full_name, org_department_id, excluded_from_timesheet')
        .ilike('full_name', `%${parsed.q}%`)
        .eq('employment_status', 'active')
        .eq('is_archived', false)
        .neq('org_department_id', targetDepartmentId)
        .order('full_name')
        .limit(20);

      if (error) throw error;

      const departmentIds = [...new Set((employees || [])
        .map(employee => employee.org_department_id)
        .filter((value): value is string => Boolean(value)))];

      const departmentNameById = new Map<string, string>();
      if (departmentIds.length > 0) {
        const { data: departments, error: departmentsError } = await supabase
          .from('org_departments')
          .select('id, name')
          .in('id', departmentIds);

        if (departmentsError) throw departmentsError;
        for (const department of departments || []) {
          departmentNameById.set(String(department.id), String(department.name || ''));
        }
      }

      res.json({
        success: true,
        data: (employees || []).map(employee => ({
          id: Number(employee.id),
          full_name: String(employee.full_name || ''),
          org_department_id: (employee.org_department_id as string | null) ?? null,
          department_name: employee.org_department_id
            ? departmentNameById.get(String(employee.org_department_id)) || null
            : null,
          excluded_from_timesheet: Boolean(employee.excluded_from_timesheet),
        })),
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.searchTeamEmployees error:', err);
      res.status(500).json({ success: false, error: 'Ошибка поиска сотрудников для табеля' });
    }
  },

  /** POST /api/timesheet/team-management/add-employee */
  async addEmployeeToDepartment(req: AuthenticatedRequest, res: Response) {
    try {
      const enabled = await isTimesheetTeamManagementAvailable(req);
      if (!enabled) {
        return res.status(403).json({ success: false, error: 'Недостаточно прав для управления составом табеля' });
      }

      const parsed = teamManagementAddEmployeeSchema.parse(req.body);
      const targetDepartmentId = await resolveManagedDepartmentId(req, parsed.department_id);
      if (!targetDepartmentId) {
        return res.status(403).json({ success: false, error: 'Нет доступа к управлению составом этого отдела' });
      }

      const [employeeRow, targetDepartment, excludedFlagRow] = await Promise.all([
        loadEmployeeLifecycleRow(parsed.employee_id),
        loadTargetDepartment(targetDepartmentId),
        supabase
          .from('employees')
          .select('excluded_from_timesheet')
          .eq('id', parsed.employee_id)
          .maybeSingle(),
      ]);

      if (!employeeRow) {
        return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      }
      if (!targetDepartment) {
        return res.status(400).json({ success: false, error: 'Целевой отдел не найден' });
      }
      if (employeeRow.employment_status !== 'active') {
        return res.status(409).json({ success: false, error: 'Можно добавлять только активных сотрудников' });
      }
      if (await isEmployeeAssignedToDepartmentOnDate(parsed.employee_id, targetDepartmentId, parsed.effective_from)) {
        return res.status(409).json({ success: false, error: 'Сотрудник уже находится в выбранном отделе' });
      }

      const fromDepartmentId = employeeRow.org_department_id;
      const restoredFromExclusion = Boolean(excludedFlagRow.data?.excluded_from_timesheet);

      const moveResult = await moveEmployeeToDepartmentInternal({
        req,
        employee: employeeRow,
        targetDepartment,
        reason: 'Перевод из табеля',
        effectiveDate: parsed.effective_from,
      });

      if (restoredFromExclusion) {
        const { error: unexcludeError } = await supabase
          .from('employees')
          .update({
            excluded_from_timesheet: false,
            excluded_from_timesheet_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', parsed.employee_id);
        if (unexcludeError) throw unexcludeError;
      }

      employeeCache.invalidate(parsed.employee_id);

      await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
        entityType: 'employee',
        entityId: String(parsed.employee_id),
        details: {
          source: 'timesheet_team_management',
          move_result: moveResult,
          from_department_id: fromDepartmentId,
          to_department_id: targetDepartmentId,
          effective_from: parsed.effective_from,
          restored_from_exclusion: restoredFromExclusion,
        },
      });

      res.json({
        success: true,
        data: {
          employee_id: parsed.employee_id,
          department_id: targetDepartmentId,
          effective_from: parsed.effective_from,
          move_result: moveResult,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      const status = getHttpErrorStatus(err);
      if (status) {
        const code = getHttpErrorCode(err);
        return res.status(status).json({
          success: false,
          error: getErrorMessage(err, 'Ошибка добавления сотрудника в отдел табеля'),
          ...(code ? { code } : {}),
        });
      }
      console.error('timesheet.addEmployeeToDepartment error:', err);
      res.status(500).json({ success: false, error: 'Ошибка добавления сотрудника в отдел табеля' });
    }
  },

  /** POST /api/timesheet/team-management/exclude-employee */
  async excludeEmployeeFromDepartment(req: AuthenticatedRequest, res: Response) {
    try {
      const enabled = await isTimesheetTeamManagementAvailable(req);
      if (!enabled) {
        return res.status(403).json({ success: false, error: 'Недостаточно прав для управления составом табеля' });
      }

      const parsed = teamManagementMutationSchema.parse(req.body);
      const targetDepartmentId = await resolveManagedDepartmentId(req, parsed.department_id);
      if (!targetDepartmentId) {
        return res.status(403).json({ success: false, error: 'Нет доступа к управлению составом этого отдела' });
      }

      const { data: employee, error } = await supabase
        .from('employees')
        .select('id, full_name, org_department_id, employment_status, excluded_from_timesheet')
        .eq('id', parsed.employee_id)
        .single();
      if (error || !employee) {
        return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      }
      if (employee.org_department_id !== targetDepartmentId) {
        return res.status(409).json({ success: false, error: 'Сотрудник не относится к выбранному отделу' });
      }
      if (employee.excluded_from_timesheet) {
        return res.status(409).json({ success: false, error: 'Сотрудник уже исключён из табеля' });
      }
      if (employee.employment_status !== 'active') {
        return res.status(409).json({ success: false, error: 'Можно исключать только активных сотрудников' });
      }

      const excludedAt = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('employees')
        .update({
          excluded_from_timesheet: true,
          excluded_from_timesheet_at: excludedAt,
          updated_at: excludedAt,
        })
        .eq('id', parsed.employee_id);
      if (updateError) throw updateError;

      const todayIso = excludedAt.slice(0, 10);
      const previousDay = formatDateShift(todayIso, -1);
      const { error: closeAssignmentError } = await supabase
        .from('employee_assignments')
        .update({ effective_to: previousDay, updated_at: excludedAt })
        .eq('employee_id', parsed.employee_id)
        .eq('org_department_id', targetDepartmentId)
        .is('effective_to', null);
      if (closeAssignmentError) throw closeAssignmentError;

      employeeCache.invalidate(parsed.employee_id);

      const auditDeptName = await loadDepartmentNameForAudit(targetDepartmentId);

      await auditService.logFromRequest(req, req.user.id, 'EXCLUDE_FROM_TIMESHEET', {
        entityType: 'employee',
        entityId: String(parsed.employee_id),
        details: {
          source: 'timesheet_team_management',
          employee_id: parsed.employee_id,
          employee_full_name: (employee.full_name as string | null) ?? null,
          department_id: targetDepartmentId,
          department_name: auditDeptName,
        },
      });

      res.json({
        success: true,
        data: {
          employee_id: parsed.employee_id,
          excluded_from_timesheet_at: excludedAt,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.excludeEmployeeFromDepartment error:', err);
      res.status(500).json({ success: false, error: 'Ошибка исключения сотрудника из табеля' });
    }
  },

  /** DELETE /api/timesheet/object-entry */
  async deleteObjectEntry(req: AuthenticatedRequest, res: Response) {
    try {
      const parsed = deleteObjectEntrySchema.parse(req.body);
      const scope = await resolveTimesheetScope(req);
      if (scope === 'department') {
        const [yearStr, monthStr] = parsed.work_date.split('-');
        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
        }
      }
      if (!(await canAccessEmployeeForTimesheetDate(req, parsed.employee_id, parsed.work_date))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }
      const approvalLockDel = await ensureNotLockedForScope(req, scope, parsed.employee_id, parsed.work_date);
      if (approvalLockDel) {
        return res.status(409).json({
          success: false,
          error: `Период ${approvalLockDel.start_date} – ${approvalLockDel.end_date} уже ${approvalLockDel.status === 'approved' ? 'утверждён' : 'на проверке'}. Редактирование закрыто.`,
        });
      }

      await deleteAttendanceAdjustmentBySource({
        employee_id: parsed.employee_id,
        work_date: parsed.work_date,
        source_type: OBJECT_ADJUSTMENT_SOURCE_TYPE,
        source_id: parsed.object_key,
      });

      const auditFullNameObjDel = await loadEmployeeFullNameForAudit(parsed.employee_id);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet_object_entry',
        entityId: `${parsed.employee_id}:${parsed.work_date}:${parsed.object_key}`,
        details: {
          employee_id: parsed.employee_id,
          employee_full_name: auditFullNameObjDel,
          work_date: parsed.work_date,
          object_key: parsed.object_key,
        },
      });

      res.json({ success: true, data: null });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.deleteObjectEntry error:', err);
      res.status(500).json({ success: false, error: 'Ошибка удаления корректировки по объекту' });
    }
  },

  /** GET /api/timesheet/corrections?start_date&end_date&department_id? */
  async listCorrections(req: AuthenticatedRequest, res: Response) {
    try {
      const scope = await resolveTimesheetScope(req);
      if (!scope) return res.status(403).json({ success: false, error: 'Нет доступа' });
      if (scope === 'self') return res.status(403).json({ success: false, error: 'Нет доступа' });

      const startDate = String(req.query.start_date ?? '');
      const endDate = String(req.query.end_date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) {
        return res.status(400).json({ success: false, error: 'Некорректный диапазон дат' });
      }

      const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
      let employeeIds: number[] = [];
      if (scope === 'department') {
        const managedIds = await resolveManagedDepartmentIds(req);
        const departmentIds = requestedDepartmentId && managedIds.includes(requestedDepartmentId)
          ? [requestedDepartmentId]
          : managedIds;
        const ids = new Set<number>();
        for (const deptId of departmentIds) {
          const list = await listEmployeeIdsAssignedToDepartmentPeriod(deptId, startDate, endDate);
          for (const id of list) ids.add(id);
        }
        employeeIds = [...ids];
      } else if (requestedDepartmentId) {
        employeeIds = await listEmployeeIdsAssignedToDepartmentPeriod(requestedDepartmentId, startDate, endDate);
      } else {
        const { data, error } = await supabase.from('employees').select('id');
        if (error) throw error;
        employeeIds = (data || []).map((row) => Number(row.id));
      }

      if (employeeIds.length === 0) {
        return res.json({ success: true, data: [] });
      }

      const adjustments = await loadAttendanceAdjustmentsWithAuthors(employeeIds, startDate, endDate);
      const rows = await Promise.all(adjustments.map(async (item) => {
        const lockInfo = scope === 'department'
          ? await ensureNotLockedForScope(req, 'department', item.employee_id, item.work_date)
          : null;
        const approvalLocked = Boolean(lockInfo);
        const isOwner = scope === 'department' ? item.created_by === req.user.id : true;
        const [yStr, mStr] = item.work_date.split('-');
        const monthAllowed = scope === 'all'
          ? true
          : isDepartmentMonthAllowed(Number(yStr), Number(mStr));
        const canEdit = scope === 'all'
          ? !(lockInfo && lockInfo.status === 'approved')
          : isOwner && !approvalLocked && monthAllowed && item.source_type === 'manual';
        const canDelete = canEdit && item.source_type === 'manual';
        return {
          id: item.id,
          employee_id: item.employee_id,
          employee_full_name: item.employee_full_name,
          work_date: item.work_date,
          status: item.status,
          hours_override: item.hours_override,
          source_type: item.source_type,
          reason: item.reason,
          author_name: item.author_name,
          created_by: item.created_by,
          created_at: item.created_at,
          updated_at: item.updated_at,
          can_edit: canEdit,
          can_delete: canDelete,
          approval_locked: approvalLocked,
          month_out_of_range: scope === 'department' ? !monthAllowed : false,
        };
      }));

      res.json({ success: true, data: rows });
    } catch (err) {
      console.error('timesheet.listCorrections error:', err);
      res.status(500).json({ success: false, error: 'Ошибка получения корректировок' });
    }
  },

  /** DELETE /api/timesheet/:id */
  async deleteEntry(req: AuthenticatedRequest, res: Response) {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ success: false, error: 'Некорректный id' });
      }

      const scope = await resolveTimesheetScope(req);
      if (!scope) return res.status(403).json({ success: false, error: 'Нет доступа' });
      if (scope === 'self') return res.status(403).json({ success: false, error: 'Нет доступа' });

      const existing = await getAttendanceAdjustmentById(id);
      if (!existing) return res.status(404).json({ success: false, error: 'Запись не найдена' });

      const sourceType = String(existing.source_type ?? '');
      if (sourceType !== 'manual') {
        return res.status(409).json({ success: false, error: 'Эта корректировка не удаляется' });
      }

      if (scope === 'department') {
        const workDate = String(existing.work_date ?? '');
        const [yearStr, monthStr] = workDate.split('-');
        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
          return res.status(403).json({
            success: false,
            error: 'Руководителю доступен только текущий и предыдущий месяц табеля',
          });
        }
      }

      if (!(await canAccessEmployeeForTimesheetDate(req, Number(existing.employee_id), String(existing.work_date)))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }

      const existingCreatedBy = typeof existing.created_by === 'string' ? existing.created_by : null;
      if (scope === 'department' && existingCreatedBy && existingCreatedBy !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Удалять можно только свои корректировки' });
      }

      const approvalLockDel = await ensureNotLockedForScope(
        req,
        scope,
        Number(existing.employee_id),
        String(existing.work_date),
      );
      if (approvalLockDel) {
        return res.status(409).json({
          success: false,
          error: `Период ${approvalLockDel.start_date} – ${approvalLockDel.end_date} уже ${approvalLockDel.status === 'approved' ? 'утверждён' : 'на проверке'}. Редактирование закрыто.`,
        });
      }

      const ok = await deleteAttendanceAdjustmentById(id);
      if (!ok) return res.status(404).json({ success: false, error: 'Запись не найдена' });

      const auditFullName = await loadEmployeeFullNameForAudit(Number(existing.employee_id));
      await auditService.logFromRequest(req, req.user.id, 'DELETE_TIMESHEET_ENTRY', {
        entityType: 'timesheet',
        entityId: String(id),
        details: {
          employee_id: Number(existing.employee_id),
          employee_full_name: auditFullName,
          work_date: String(existing.work_date),
        },
      });

      res.json({ success: true });
    } catch (err) {
      console.error('timesheet.deleteEntry error:', err);
      const message = err instanceof Error ? err.message : '';
      if (/schema cache/i.test(message)) {
        return res.status(503).json({
          success: false,
          error: 'Схема БД устарела в кэше PostgREST. Выполните NOTIFY pgrst, \'reload schema\' и повторите.',
        });
      }
      res.status(500).json({ success: false, error: 'Ошибка удаления корректировки' });
    }
  },

  /** POST /api/timesheet/refresh { start_date, end_date } */
  async refresh(req: AuthenticatedRequest, res: Response) {
    try {
      const scope = await resolveTimesheetScope(req);
      if (!scope) return res.status(403).json({ success: false, error: 'Нет доступа' });

      const startDate = String(req.body?.start_date ?? '');
      const endDate = String(req.body?.end_date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) {
        return res.status(400).json({ success: false, error: 'Некорректный диапазон дат' });
      }

      const diffDays = Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000);
      if (diffDays > 62) {
        return res.status(400).json({ success: false, error: 'Диапазон не должен превышать 62 дня' });
      }

      let syncResult: { sigurTotal?: number; imported?: number; skipped?: number; errors_count?: number; matched?: number } | null = null;
      if (await sigurService.isConfigured()) {
        try {
          await acquirePresencePollingLock();
        } catch (err) {
          if (err instanceof ManualSyncInProgressError) {
            return res.status(409).json({ success: false, error: 'Синхронизация уже выполняется', code: 'SYNC_IN_PROGRESS' });
          }
          throw err;
        }
        try {
          const result = await syncEventsLogic(startDate, endDate);
          syncResult = {
            sigurTotal: result?.sigurTotal,
            imported: result?.imported,
            skipped: result?.skipped,
            errors_count: Array.isArray(result?.errors) ? result.errors.length : 0,
            matched: result?.matched,
          };
        } finally {
          await releasePresencePollingLock();
        }
      }

      let employeeIds: number[] = [];
      if (scope === 'department') {
        const managedIds = await resolveManagedDepartmentIds(req);
        const ids = new Set<number>();
        for (const deptId of managedIds) {
          const list = await listEmployeeIdsAssignedToDepartmentPeriod(deptId, startDate, endDate);
          for (const id of list) ids.add(id);
        }
        employeeIds = [...ids];
      }

      let conflicts: Array<{ employee_id: number; work_date: string; skud_minutes: number }> = [];
      if (employeeIds.length > 0 || scope === 'all') {
        const adjQuery = supabase
          .from('attendance_adjustments')
          .select('employee_id, work_date')
          .eq('source_type', 'manual')
          .eq('status', 'absent')
          .gte('work_date', startDate)
          .lte('work_date', endDate);
        if (employeeIds.length > 0) adjQuery.in('employee_id', employeeIds);
        const adjRes = await adjQuery;
        if (adjRes.error) throw adjRes.error;
        const absentRows = (adjRes.data || []) as Array<{ employee_id: number; work_date: string }>;
        if (absentRows.length > 0) {
          const empIdsForCheck = [...new Set(absentRows.map((r) => Number(r.employee_id)))];
          const skudRes = await supabase
            .from('skud_daily_summary')
            .select('employee_id, date, total_minutes')
            .in('employee_id', empIdsForCheck)
            .gte('date', startDate)
            .lte('date', endDate)
            .gt('total_minutes', 0);
          if (skudRes.error) throw skudRes.error;
          const skudMap = new Map<string, number>();
          for (const row of skudRes.data || []) {
            skudMap.set(`${Number(row.employee_id)}_${String(row.date)}`, Number(row.total_minutes ?? 0));
          }
          for (const row of absentRows) {
            const mins = skudMap.get(`${Number(row.employee_id)}_${String(row.work_date)}`);
            if (mins && mins > 0) {
              conflicts.push({ employee_id: Number(row.employee_id), work_date: String(row.work_date), skud_minutes: mins });
            }
          }
        }
      }

      await auditService.logFromRequest(req, req.user.id, 'TIMESHEET_REFRESH', {
        entityType: 'timesheet',
        details: { start_date: startDate, end_date: endDate, sync: syncResult, conflicts_count: conflicts.length },
      });

      res.json({ success: true, data: { sync: syncResult, conflicts } });
    } catch (err) {
      console.error('timesheet.refresh error:', err);
      res.status(500).json({ success: false, error: 'Ошибка обновления табеля' });
    }
  },

  /** GET /api/timesheet/export?month=YYYY-MM&department_id=... */
  export: exportTimesheet,

  /** POST /api/timesheet/export-mass  body: { month, department_ids } */
  exportMass: exportTimesheetMass,

  /** POST /api/timesheet/export-assigned  body: { month, half, group_by, export_as_1c, employee_ids? } */
  exportAssigned: exportTimesheetAssigned,

  /** GET /api/timesheet/assigned-employees */
  listAssignedEmployees,

  /** POST /api/timesheet/email-assigned */
  emailAssigned: emailTimesheetAssigned,
};
