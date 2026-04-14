import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, TimeStatus, IResolvedSchedule, WorkCategory } from '../types/index.js';
import { exportTimesheet } from './timesheet-export.controller.js';
import { exportTimesheetMass } from './timesheet-mass-export.controller.js';
import { resolveSchedulesForPeriod, isWorkingDay, getEffectiveLateThreshold, getScheduleForDate, loadCalendarMonth } from '../services/schedule.service.js';
import { canAccessEmployeeInScope, resolveRequestDataScope, resolveScopedDepartmentId } from '../services/data-scope.service.js';
import { employeeChangesService } from '../services/employee-changes.service.js';
import { employeeCache } from '../services/employee-cache.service.js';
import { settingsService } from '../services/settings.service.js';
import {
  buildAttendanceEntries,
  deleteAttendanceAdjustmentBySource,
  getAttendanceAdjustmentById,
  updateAttendanceAdjustmentById,
  upsertAttendanceAdjustment,
} from '../services/attendance.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { OBJECT_ADJUSTMENT_SOURCE_TYPE } from '../services/timesheet-object.service.js';

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

function getWorkingDaysInMonth(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function getWorkingDaysUpToToday(year: number, month: number): number {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (year < curYear || (year === curYear && month < curMonth)) {
    return getWorkingDaysInMonth(year, month);
  }
  if (year > curYear || (year === curYear && month > curMonth)) {
    return 0;
  }
  const today = now.getDate();
  let count = 0;
  for (let d = 1; d <= today; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function toMonthIndex(year: number, month: number): number {
  return year * 12 + month - 1;
}

function isDepartmentMonthAllowed(year: number, month: number, referenceDate = new Date()): boolean {
  const requestedMonthIndex = toMonthIndex(year, month);
  const currentMonthIndex = toMonthIndex(referenceDate.getFullYear(), referenceDate.getMonth() + 1);
  return requestedMonthIndex >= currentMonthIndex - 1 && requestedMonthIndex <= currentMonthIndex;
}

async function resolveRemoteHoursByItems(items: Array<{ employee_id: number; work_date: string }>): Promise<Map<string, number>> {
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

async function ensureTimesheetTeamManagementEnabled(): Promise<boolean> {
  const config = await settingsService.getTimesheetTeamManagementConfig();
  return config.enabled;
}

async function isTimesheetTeamManagementAvailable(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.position_type === 'super_admin') {
    return true;
  }

  return ensureTimesheetTeamManagementEnabled();
}

async function resolveManagedDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId: string,
): Promise<string | null> {
  const scope = await resolveRequestDataScope(req);
  if (!scope || scope === 'self') return null;
  return resolveScopedDepartmentId(req, requestedDepartmentId);
}

export const timesheetController = {
  /** GET /api/timesheet?month=YYYY-MM&department_id=...&employee_id=... */
  async getAll(req: AuthenticatedRequest, res: Response) {
    try {
      const { month } = req.query;
      const scope = await resolveRequestDataScope(req);
      if (!scope) {
        return res.status(403).json({ success: false, error: 'Data scope не настроен для роли' });
      }
      const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
      const requestedEmployeeId = typeof req.query.employee_id === 'string'
        ? Number.parseInt(req.query.employee_id, 10)
        : null;
      const department_id = await resolveScopedDepartmentId(req, requestedDepartmentId);

      if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, error: 'Параметр month обязателен (формат YYYY-MM)' });
      }

      const [yearStr, monthStr] = month.split('-');
      const year = parseInt(yearStr);
      const mon = parseInt(monthStr);
      const today = new Date();
      if (scope === 'department' && !isDepartmentMonthAllowed(year, mon, today)) {
        return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
      }
      const startDate = `${month}-01`;
      const endDate = `${month}-${new Date(year, mon, 0).getDate()}`;
      const todayStr = formatDateToISO(today);

      const hasDeptFilter = department_id && typeof department_id === 'string';
      const hasEmployeeFilter = Number.isInteger(requestedEmployeeId) && (requestedEmployeeId as number) > 0;

      if (hasEmployeeFilter && !(await canAccessEmployeeInScope(req, requestedEmployeeId))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }

      if (scope === 'self' && !req.user.employee_id) {
        return res.json({
          success: true,
          data: {
            employees: [],
            entries: [],
            object_entries: [],
            stats: { employeeCount: 0, workingDays: getWorkingDaysUpToToday(year, mon), normHours: getWorkingDaysUpToToday(year, mon) * 8, actualHours: 0, deviations: { late: 0, absent: 0, sick: 0 } },
          },
        });
      }

      if (scope !== 'self' && !hasDeptFilter && !hasEmployeeFilter) {
        return res.json({
          success: true,
          data: {
            employees: [],
            entries: [],
            object_entries: [],
            stats: { employeeCount: 0, workingDays: getWorkingDaysUpToToday(year, mon), normHours: getWorkingDaysUpToToday(year, mon) * 8, actualHours: 0, deviations: { late: 0, absent: 0, sick: 0 } },
          },
        });
      }

      // Fetch employees
      let empQuery = supabase
        .from('employees')
        .select('id, full_name, position_id, org_department_id, employment_status, work_category')
        .eq('employment_status', 'active')
        .eq('is_archived', false)
        .order('full_name');

      if (hasEmployeeFilter) {
        empQuery = empQuery.eq('id', requestedEmployeeId as number);
      } else if (scope === 'self' && req.user.employee_id) {
        empQuery = empQuery.eq('id', req.user.employee_id);
      } else if (hasDeptFilter) {
        empQuery = empQuery.eq('org_department_id', department_id as string);
      }

      const { data: employees, error: empError } = await empQuery;
      if (empError) throw empError;

      const employeeIds = (employees || []).map(e => e.id);

      // Resolve графики для всех сотрудников по каждому дню месяца + производственный календарь
      const empList = (employees || []).map(e => ({
        id: e.id as number,
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
	          id: employee.id as number,
	          full_name: (employee.full_name as string | null) || null,
	          work_category: (employee.work_category as string | null) || null,
	        })),
	        startDate,
	        endDate,
	        dailySchedulesMap,
	        calendarMonth,
	        todayStr,
	      });

	      const daysInMonth = new Date(year, mon, 0).getDate();

      // Compute stats (schedule-aware)
      let normHours = 0;
      let totalWorkingDays = 0;
      for (const empId of employeeIds) {
        let empWorkDays = 0;
        let empNormHours = 0;
        for (let d = 1; d <= daysInMonth; d++) {
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
      }

      let actualHours = 0;
      const deviations = { late: 0, absent: 0, sick: 0 };

      for (const entry of entries) {
        if (entry.hours_worked && typeof entry.hours_worked === 'number') {
          actualHours += entry.hours_worked;
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
      const scope = await resolveRequestDataScope(req);
      if (scope === 'department') {
        const [yearStr, monthStr] = parsed.work_date.split('-');
        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
        }
      }
      if (!(await canAccessEmployeeInScope(req, parsed.employee_id))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }
      const normalizedHours = parsed.status === 'remote'
        ? (await resolveRemoteHoursByItems([{ employee_id: parsed.employee_id, work_date: parsed.work_date }]))
          .get(`${parsed.employee_id}_${parsed.work_date}`) ?? 8
        : (parsed.hours_worked ?? null);

	      const raw = await upsertAttendanceAdjustment({
	        employee_id: parsed.employee_id,
	        work_date: parsed.work_date,
	        status: parsed.status,
	        hours_override: normalizedHours,
	        source_type: 'manual',
	        source_id: 'manual',
	        reason: parsed.notes ?? null,
	        created_by: req.user.id,
	      });

	      const data = {
	        id: Number(raw.id),
	        employee_id: parsed.employee_id,
	        work_date: parsed.work_date,
	        status: parsed.status,
	        hours_worked: normalizedHours,
	        notes: parsed.notes ?? null,
	        is_correction: true,
	        corrected_at: String(raw.updated_at ?? raw.created_at ?? new Date().toISOString()),
	        corrected_by_name: null,
	      };

	      await auditService.logFromRequest(req, req.user.id, 'CREATE_TIMESHEET_ENTRY', {
	        entityType: 'timesheet',
	        entityId: String(data.id),
	        details: {
	          employee_id: parsed.employee_id,
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
	      const scope = await resolveRequestDataScope(req);
	      if (scope === 'department') {
	        const workDate = String(existing.work_date ?? '');
	        const [yearStr, monthStr] = workDate.split('-');
	        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
	          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
	        }
	      }
	      if (!(await canAccessEmployeeInScope(req, Number(existing.employee_id)))) {
	        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
	      }
        const nextStatus = (parsed.status ?? String(existing.status)) as TimeStatus;
        const normalizedHours = nextStatus === 'remote'
          ? (await resolveRemoteHoursByItems([{
            employee_id: Number(existing.employee_id),
            work_date: String(existing.work_date),
          }])).get(`${Number(existing.employee_id)}_${String(existing.work_date)}`) ?? 8
          : parsed.hours_worked;

	      const updated = await updateAttendanceAdjustmentById(id, {
	        ...(parsed.status ? { status: parsed.status } : {}),
	        ...(nextStatus === 'remote'
            ? { hours_override: normalizedHours }
            : (parsed.hours_worked !== undefined ? { hours_override: parsed.hours_worked } : {})),
	        ...(parsed.notes !== undefined ? { reason: parsed.notes ?? null } : {}),
	        created_by: req.user.id,
	      });
	      if (!updated) return res.status(404).json({ success: false, error: 'Запись не найдена' });

	      const data = {
	        id: Number(updated.id),
	        employee_id: Number(updated.employee_id),
	        work_date: String(updated.work_date),
	        status: String(updated.status),
	        hours_worked: typeof updated.hours_override === 'number'
	          ? updated.hours_override
	          : (typeof updated.hours_worked === 'number' ? updated.hours_worked : null),
	        notes: typeof updated.reason === 'string' ? updated.reason : null,
	        is_correction: true,
	        corrected_at: String(updated.updated_at ?? updated.created_at ?? new Date().toISOString()),
	        corrected_by_name: null,
	      };

	      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
	        entityType: 'timesheet',
	        entityId: String(id),
	        details: { ...parsed },
      });

      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.update error:', err);
      res.status(500).json({ success: false, error: 'Ошибка обновления записи' });
    }
  },

  /** POST /api/timesheet/bulk */
  async bulkSave(req: AuthenticatedRequest, res: Response) {
    try {
      const parsed = bulkCorrectionSchema.parse(req.body);
      const scope = await resolveRequestDataScope(req);
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
      const employeeIds = [...new Set(uniqueItems.map(item => item.employee_id))];
      const accessResults = await Promise.all(
        employeeIds.map(async employeeId => ({
          employeeId,
          allowed: await canAccessEmployeeInScope(req, employeeId),
        })),
      );
      const denied = accessResults.find(result => !result.allowed);
      if (denied) {
        return res.status(403).json({ success: false, error: 'Нет доступа к одному или нескольким сотрудникам' });
      }
      const remoteHoursByItem = parsed.status === 'remote'
        ? await resolveRemoteHoursByItems(uniqueItems)
        : new Map<string, number>();

      await Promise.all(uniqueItems.map(item => upsertAttendanceAdjustment({
        employee_id: item.employee_id,
        work_date: item.work_date,
        status: parsed.status,
        hours_override: parsed.status === 'remote'
          ? (remoteHoursByItem.get(`${item.employee_id}_${item.work_date}`) ?? 8)
          : (parsed.hours_worked ?? null),
        source_type: 'manual',
        source_id: 'manual',
        reason: parsed.notes ?? null,
        created_by: req.user.id,
      })));

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet',
        entityId: `bulk:${Date.now()}`,
        details: {
          count: uniqueItems.length,
          employees: employeeIds.length,
          status: parsed.status,
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
      const scope = await resolveRequestDataScope(req);
      if (scope === 'department') {
        const [yearStr, monthStr] = parsed.work_date.split('-');
        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
        }
      }
      if (!(await canAccessEmployeeInScope(req, parsed.employee_id))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }

      const raw = await upsertAttendanceAdjustment({
        employee_id: parsed.employee_id,
        work_date: parsed.work_date,
        status: 'manual',
        hours_override: parsed.hours_worked,
        source_type: OBJECT_ADJUSTMENT_SOURCE_TYPE,
        source_id: parsed.object_key,
        reason: parsed.notes ?? null,
        created_by: req.user.id,
        metadata: {
          object_id: parsed.object_id ?? null,
          object_name: parsed.object_name,
        },
      });

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet_object_entry',
        entityId: `${parsed.employee_id}:${parsed.work_date}:${parsed.object_key}`,
        details: {
          employee_id: parsed.employee_id,
          work_date: parsed.work_date,
          object_key: parsed.object_key,
          object_name: parsed.object_name,
          hours_worked: parsed.hours_worked,
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
          hours_worked: parsed.hours_worked,
          base_hours_worked: parsed.hours_worked,
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
      const scope = await resolveRequestDataScope(req);
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
        return res.status(403).json({ success: false, error: 'Ручное управление составом табеля отключено администратором' });
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
        .select('id, full_name, org_department_id')
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
        return res.status(403).json({ success: false, error: 'Ручное управление составом табеля отключено администратором' });
      }

      const parsed = teamManagementMutationSchema.parse(req.body);
      const targetDepartmentId = await resolveManagedDepartmentId(req, parsed.department_id);
      if (!targetDepartmentId) {
        return res.status(403).json({ success: false, error: 'Нет доступа к управлению составом этого отдела' });
      }

      const { data: employee, error } = await supabase
        .from('employees')
        .select('id, full_name, org_department_id, employment_status, is_archived')
        .eq('id', parsed.employee_id)
        .single();
      if (error || !employee) {
        return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      }
      if (employee.employment_status !== 'active' || employee.is_archived) {
        return res.status(409).json({ success: false, error: 'Можно добавлять только активных сотрудников' });
      }
      if (employee.org_department_id === targetDepartmentId) {
        return res.status(409).json({ success: false, error: 'Сотрудник уже находится в выбранном отделе' });
      }

      await employeeChangesService.changeDepartment(parsed.employee_id, targetDepartmentId, {
        reason: 'Перевод из табеля',
        createdBy: req.user.id,
        lockDepartment: true,
      });
      employeeCache.invalidate(parsed.employee_id);

      await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
        entityType: 'employee',
        entityId: String(parsed.employee_id),
        details: {
          source: 'timesheet_team_management',
          from_department_id: employee.org_department_id,
          to_department_id: targetDepartmentId,
        },
      });

      res.json({
        success: true,
        data: {
          employee_id: parsed.employee_id,
          department_id: targetDepartmentId,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
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
        return res.status(403).json({ success: false, error: 'Ручное управление составом табеля отключено администратором' });
      }

      const parsed = teamManagementMutationSchema.parse(req.body);
      const targetDepartmentId = await resolveManagedDepartmentId(req, parsed.department_id);
      if (!targetDepartmentId) {
        return res.status(403).json({ success: false, error: 'Нет доступа к управлению составом этого отдела' });
      }

      const { data: employee, error } = await supabase
        .from('employees')
        .select('id, full_name, org_department_id, employment_status, is_archived')
        .eq('id', parsed.employee_id)
        .single();
      if (error || !employee) {
        return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      }
      if (employee.org_department_id !== targetDepartmentId) {
        return res.status(409).json({ success: false, error: 'Сотрудник не относится к выбранному отделу' });
      }
      if (employee.is_archived) {
        return res.status(409).json({ success: false, error: 'Сотрудник уже находится во внутреннем архиве' });
      }
      if (employee.employment_status !== 'active') {
        return res.status(409).json({ success: false, error: 'Можно исключать только активных сотрудников' });
      }

      const archivedAt = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('employees')
        .update({
          is_archived: true,
          archived_at: archivedAt,
          updated_at: archivedAt,
        })
        .eq('id', parsed.employee_id);
      if (updateError) throw updateError;

      employeeCache.invalidate(parsed.employee_id);

      await auditService.logFromRequest(req, req.user.id, 'ARCHIVE_EMPLOYEE', {
        entityType: 'employee',
        entityId: String(parsed.employee_id),
        details: {
          source: 'timesheet_team_management',
          department_id: targetDepartmentId,
        },
      });

      res.json({
        success: true,
        data: {
          employee_id: parsed.employee_id,
          archived_at: archivedAt,
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
      const scope = await resolveRequestDataScope(req);
      if (scope === 'department') {
        const [yearStr, monthStr] = parsed.work_date.split('-');
        if (!isDepartmentMonthAllowed(Number(yearStr), Number(monthStr))) {
          return res.status(403).json({ success: false, error: 'Руководителю доступен только текущий и предыдущий месяц табеля' });
        }
      }
      if (!(await canAccessEmployeeInScope(req, parsed.employee_id))) {
        return res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      }

      await deleteAttendanceAdjustmentBySource({
        employee_id: parsed.employee_id,
        work_date: parsed.work_date,
        source_type: OBJECT_ADJUSTMENT_SOURCE_TYPE,
        source_id: parsed.object_key,
      });

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TIMESHEET_ENTRY', {
        entityType: 'timesheet_object_entry',
        entityId: `${parsed.employee_id}:${parsed.work_date}:${parsed.object_key}`,
        details: {
          employee_id: parsed.employee_id,
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

  /** GET /api/timesheet/export?month=YYYY-MM&department_id=... */
  export: exportTimesheet,

  /** POST /api/timesheet/export-mass  body: { month, department_ids } */
  exportMass: exportTimesheetMass,
};
