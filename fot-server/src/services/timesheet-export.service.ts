import { query, queryOne } from '../config/postgres.js';
import { loadCalendarMonth, resolveSchedulesForPeriod } from './schedule.service.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import { buildAttendanceEntries, type IAttendanceEntry } from './attendance.service.js';
import type { IAttendanceObjectEntry } from './timesheet-object.service.js';
import {
  listEmployeeIdsAssignedToDepartmentPeriod,
  resolveTimesheetDateRange,
  resolveTimesheetPeriodRange,
} from './timesheet-department-assignments.service.js';

export type TimesheetExportHalf = 'H1' | 'H2' | 'FULL';
export type TimesheetExportRange = { startDate: string; endDate: string };
export type TimesheetExportRangeArg = TimesheetExportHalf | TimesheetExportRange;
export type TimesheetExportGrouping = 'employees' | 'objects';
export type TimesheetExportPresentation = 'hr' | 'manager';

function isExportRange(value: TimesheetExportRangeArg): value is TimesheetExportRange {
  return typeof value === 'object' && value !== null
    && typeof value.startDate === 'string' && typeof value.endDate === 'string';
}

export interface IExportEmployee {
  id: number;
  full_name: string;
  position_id: string | null;
  org_department_id: string | null;
  sigur_employee_id: number | null;
}

export interface IDepartmentTimesheetData {
  departmentName: string;
  departmentId: string | null;
  isBrigade: boolean;
  employees: IExportEmployee[];
  schedulesMap: Map<number, IResolvedSchedule>;
  dailySchedulesMap: Map<number, Map<string, IResolvedSchedule>>;
  calendarMonth: IProductionCalendarMonth | null;
  entries: IAttendanceEntry[];
  dataMap: Map<number, Map<string, { status: string; hours: number; corrected?: boolean }>>;
  objectEntries: IAttendanceObjectEntry[];
  skudMap: Map<number, Map<string, { hours: number; corrected: boolean }>>;
  posMap: Map<string, string>;
  year: number;
  mon: number;
  daysInMonth: number;
  exportHalf: TimesheetExportHalf;
  exportDays: number[];
  // true → отдавать фактические часы по СКУД (hours_worked) во всех табличных
  // и Excel-представлениях; false → текущее поведение (display_hours_worked,
  // т.е. часы, обрезанные под плановую норму дня).
  showActualHours: boolean;
}

export const resolveTimesheetExportDays = (
  year: number,
  mon: number,
  half: TimesheetExportHalf,
): number[] => {
  const daysInMonth = new Date(year, mon, 0).getDate();
  if (half === 'H1') {
    return Array.from({ length: Math.min(15, daysInMonth) }, (_, index) => index + 1);
  }
  if (half === 'H2') {
    return Array.from({ length: Math.max(0, daysInMonth - 15) }, (_, index) => index + 16);
  }
  return Array.from({ length: daysInMonth }, (_, index) => index + 1);
};

export async function fetchTimesheetDataForDepartment(
  month: string,
  departmentId: string | null,
  rangeArg: TimesheetExportRangeArg = 'FULL',
  displayMode: 'actual' | 'capped_to_schedule' = 'actual',
  showActualHours = false,
): Promise<IDepartmentTimesheetData> {
  // Per-role show_actual_hours форсит «фактические часы по СКУД» во всех
  // визуальных представлениях. При этом capped_to_schedule перетирает
  // hours_worked = display_hours_worked в attendance.service, поэтому
  // override displayMode на 'actual' нужен, иначе entry.hours_worked будет
  // уже урезанным.
  const effectiveDisplayMode = showActualHours ? 'actual' : displayMode;
  const periodRange = isExportRange(rangeArg)
    ? resolveTimesheetDateRange(month, rangeArg.startDate, rangeArg.endDate)
    : resolveTimesheetPeriodRange(month, rangeArg);
  if (!periodRange) {
    throw new Error('Invalid export month');
  }
  const { year, month: mon, daysInMonth, startDate, endDate } = periodRange;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const startDay = Number.parseInt(startDate.slice(-2), 10);
  const endDay = Number.parseInt(endDate.slice(-2), 10);
  const exportDays = Array.from({ length: endDay - startDay + 1 }, (_, i) => startDay + i);
  const exportHalf: TimesheetExportHalf = isExportRange(rangeArg) ? 'FULL' : rangeArg;

  // Имя отдела
  let departmentName = 'Все отделы';
  if (departmentId) {
    const dept = await queryOne<{ name: string }>(
      `SELECT name FROM org_departments WHERE id = $1 LIMIT 1`,
      [departmentId],
    );
    if (dept?.name) departmentName = dept.name;
  }

  // Сотрудники
  const assignedEmployeeIds = departmentId
    ? await listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate)
    : [];
  let employees: Array<Record<string, unknown>> = [];
  if (!departmentId || assignedEmployeeIds.length > 0) {
    if (departmentId) {
      employees = await query<Record<string, unknown>>(
        `SELECT id, full_name, position_id, org_department_id, sigur_employee_id
           FROM employees
           WHERE (employment_status = 'active'
                  OR (employment_status = 'fired'
                      AND dismissal_date IS NOT NULL
                      AND dismissal_date >= $2::date))
             AND is_archived = false
             AND excluded_from_timesheet = false
             AND id = ANY($1::int[])
           ORDER BY full_name`,
        [assignedEmployeeIds, startDate],
      );
    } else {
      employees = await query<Record<string, unknown>>(
        `SELECT id, full_name, position_id, org_department_id, sigur_employee_id
           FROM employees
           WHERE (employment_status = 'active'
                  OR (employment_status = 'fired'
                      AND dismissal_date IS NOT NULL
                      AND dismissal_date >= $1::date))
             AND is_archived = false
             AND excluded_from_timesheet = false
           ORDER BY full_name`,
        [startDate],
      );
    }
  }
  const empArr: IExportEmployee[] = (employees || []).map(e => ({
    id: e.id as number,
    full_name: e.full_name as string,
    position_id: (e.position_id as string | null),
    org_department_id: (e.org_department_id as string | null),
    sigur_employee_id: (e.sigur_employee_id as number | null),
  }));
  // Графики
  const empList = empArr.map(e => ({ id: e.id }));
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

  const attendance = await buildAttendanceEntries({
    employees: empArr.map(employee => ({
      id: employee.id,
      full_name: employee.full_name,
    })),
    startDate,
    endDate,
    dailySchedulesMap,
    calendarMonth,
    todayStr,
    displayMode: effectiveDisplayMode,
  });

  const dataMap = new Map<number, Map<string, { status: string; hours: number; corrected?: boolean }>>();
  for (const [employeeId, dateMap] of attendance.byEmployeeDate) {
    dataMap.set(employeeId, new Map());
    for (const [date, entry] of dateMap) {
      const visibleHours = showActualHours
        ? (typeof entry.hours_worked === 'number' ? entry.hours_worked : 0)
        : (typeof entry.display_hours_worked === 'number'
          ? entry.display_hours_worked
          : (typeof entry.hours_worked === 'number' ? entry.hours_worked : 0));
      dataMap.get(employeeId)!.set(date, {
        status: entry.status,
        hours: visibleHours,
        corrected: entry.is_correction,
      });
    }
  }

  const skudMap = attendance.skudMap;

  // Positions
  const positionIds = [...new Set(empArr.map(e => e.position_id).filter(Boolean))] as string[];
  const posMap = new Map<string, string>();
  if (positionIds.length > 0) {
    const positions = await query<{ id: string; name: string }>(
      `SELECT id, name FROM positions WHERE id = ANY($1::uuid[])`,
      [positionIds],
    );
    positions.forEach(p => posMap.set(p.id, p.name));
  }

  return {
    departmentName,
    departmentId,
    isBrigade: departmentName.toLowerCase().startsWith('бр.'),
    employees: empArr,
    schedulesMap,
    dailySchedulesMap,
    calendarMonth,
    entries: attendance.entries,
    dataMap,
    objectEntries: attendance.objectEntries,
    skudMap,
    posMap,
    year,
    mon,
    daysInMonth,
    exportHalf,
    exportDays,
    showActualHours,
  };
}

/**
 * Аналог fetchTimesheetDataForDepartment, но принимает явный список employee_ids
 * вместо department_id. Используется для виртуальных «псевдо-ячеек» в overview
 * (прямые подчинённые руководителя, сам руководитель — когда в БД нет реального
 * org_department, объединяющего этих людей).
 */
export async function fetchTimesheetDataForEmployees(
  month: string,
  employeeIds: number[],
  virtualName: string,
  rangeArg: TimesheetExportRangeArg = 'FULL',
  displayMode: 'actual' | 'capped_to_schedule' = 'actual',
  showActualHours = false,
): Promise<IDepartmentTimesheetData> {
  const effectiveDisplayMode = showActualHours ? 'actual' : displayMode;
  const periodRange = isExportRange(rangeArg)
    ? resolveTimesheetDateRange(month, rangeArg.startDate, rangeArg.endDate)
    : resolveTimesheetPeriodRange(month, rangeArg);
  if (!periodRange) {
    throw new Error('Invalid export month');
  }
  const { year, month: mon, daysInMonth, startDate, endDate } = periodRange;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const startDay = Number.parseInt(startDate.slice(-2), 10);
  const endDay = Number.parseInt(endDate.slice(-2), 10);
  const exportDays = Array.from({ length: endDay - startDay + 1 }, (_, i) => startDay + i);
  const exportHalf: TimesheetExportHalf = isExportRange(rangeArg) ? 'FULL' : rangeArg;

  const uniqueIds = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  let employees: Array<Record<string, unknown>> = [];
  if (uniqueIds.length > 0) {
    employees = await query<Record<string, unknown>>(
      `SELECT id, full_name, position_id, org_department_id, sigur_employee_id
         FROM employees
         WHERE id = ANY($1::int[])
           AND (employment_status = 'active'
                OR (employment_status = 'fired'
                    AND dismissal_date IS NOT NULL
                    AND dismissal_date >= $2::date))
           AND is_archived = false
           AND excluded_from_timesheet = false
         ORDER BY full_name`,
      [uniqueIds, startDate],
    );
  }
  const empArr: IExportEmployee[] = employees.map(e => ({
    id: e.id as number,
    full_name: e.full_name as string,
    position_id: (e.position_id as string | null),
    org_department_id: (e.org_department_id as string | null),
    sigur_employee_id: (e.sigur_employee_id as number | null),
  }));

  const empList = empArr.map(e => ({ id: e.id }));
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

  const attendance = await buildAttendanceEntries({
    employees: empArr.map(employee => ({
      id: employee.id,
      full_name: employee.full_name,
    })),
    startDate,
    endDate,
    dailySchedulesMap,
    calendarMonth,
    todayStr,
    displayMode: effectiveDisplayMode,
  });

  const dataMap = new Map<number, Map<string, { status: string; hours: number; corrected?: boolean }>>();
  for (const [employeeId, dateMap] of attendance.byEmployeeDate) {
    dataMap.set(employeeId, new Map());
    for (const [date, entry] of dateMap) {
      const visibleHours = showActualHours
        ? (typeof entry.hours_worked === 'number' ? entry.hours_worked : 0)
        : (typeof entry.display_hours_worked === 'number'
          ? entry.display_hours_worked
          : (typeof entry.hours_worked === 'number' ? entry.hours_worked : 0));
      dataMap.get(employeeId)!.set(date, {
        status: entry.status,
        hours: visibleHours,
        corrected: entry.is_correction,
      });
    }
  }

  const positionIds = [...new Set(empArr.map(e => e.position_id).filter(Boolean))] as string[];
  const posMap = new Map<string, string>();
  if (positionIds.length > 0) {
    const positions = await query<{ id: string; name: string }>(
      `SELECT id, name FROM positions WHERE id = ANY($1::uuid[])`,
      [positionIds],
    );
    positions.forEach(p => posMap.set(p.id, p.name));
  }

  return {
    departmentName: virtualName,
    departmentId: null,
    isBrigade: false,
    employees: empArr,
    schedulesMap,
    dailySchedulesMap,
    calendarMonth,
    entries: attendance.entries,
    dataMap,
    objectEntries: attendance.objectEntries,
    skudMap: attendance.skudMap,
    posMap,
    year,
    mon,
    daysInMonth,
    exportHalf,
    exportDays,
    showActualHours,
  };
}
