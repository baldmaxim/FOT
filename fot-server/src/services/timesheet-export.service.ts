import { query, queryOne } from '../config/postgres.js';
import { isWorkingDay, loadCalendarMonth, resolveSchedulesForPeriod } from './schedule.service.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import { buildAttendanceEntries, type IAttendanceEntry } from './attendance.service.js';
import { computeMandatoryExemptions } from './timesheet-mandatory-weekend.service.js';
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
  // 'fired' → уволенный: единый файл для 1С исключает его целиком.
  employment_status?: string | null;
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
  dataMap: Map<number, Map<string, { status: string; hours: number; corrected?: boolean; hoursOverridden?: boolean }>>;
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
  // Дата (включительно), С КОТОРОЙ дни сотрудника НЕ считаются (не идут в норму/факт/ячейку).
  // Заполняется ТОЛЬКО для уволенных (employment_status='fired'): min(excluded_from_timesheet_date,
  // dismissal_date+1). Для активных не задаётся → их выгрузка не меняется. Аналог cutoff онлайн-табеля.
  cutoffByEmployeeId?: Map<number, string | null>;
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

/**
 * Плановые (обязательные по квоте графика) выходные за ПОЛНЫЙ календарный месяц.
 * Считаем за весь месяц — не только за период выгрузки — иначе «первые N суббот»
 * определятся неверно при экспорте за половину/диапазон. Возвращает набор
 * `${employeeId}|${date}` дней, которые считаются плановыми (сырой СКУД без
 * корректировки, в пределах квоты expected_saturdays/sundays_per_month).
 */
async function computeExportWeekendExemptions(
  employeeIds: number[],
  year: number,
  mon: number,
  calendar: IProductionCalendarMonth | null,
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const mm = String(mon).padStart(2, '0');
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-${String(new Date(year, mon, 0).getDate()).padStart(2, '0')}`;
  const holidayDates = [
    ...(calendar?.holidays ?? []),
    ...(calendar?.mandatory_holidays ?? []),
  ];
  // Кандидаты — присутствия в календарные выходные (сб/вс) ИЛИ в праздники месяца
  // (праздник-будень может засчитываться в субботнюю квоту). Функция сама отфильтрует
  // лишнее по графику/календарю.
  const skudRows = await query<{ employee_id: number; date: string }>(
    `SELECT employee_id, date::text AS date
       FROM skud_daily_summary
      WHERE employee_id = ANY($1::int[])
        AND date >= $2::date AND date <= $3::date
        AND (is_present = true OR COALESCE(total_hours, 0) > 0)
        AND (EXTRACT(DOW FROM date) IN (0, 6) OR date::text = ANY($4::text[]))`,
    [employeeIds, monthStart, monthEnd, holidayDates],
  );
  if (skudRows.length === 0) return new Set();
  const adjRows = await query<{ employee_id: number; work_date: string }>(
    `SELECT employee_id, work_date::text AS work_date
       FROM attendance_adjustments
      WHERE employee_id = ANY($1::int[])
        AND work_date >= $2::date AND work_date <= $3::date`,
    [employeeIds, monthStart, monthEnd],
  );
  const adjSet = new Set(adjRows.map(r => `${r.employee_id}|${r.work_date}`));
  return computeMandatoryExemptions(skudRows, adjSet);
}

/**
 * Включать ли часы дня в выгрузку. Рабочий день по личному графику — всегда да.
 * Выходной день — только если работа согласована (approved/auto_approved) ИЛИ это
 * плановая суббота/воскресенье (в наборе exemptions). Иначе (сырой СКУД-проход,
 * pending/rejected, необязательный выход) — часы обнуляются. Одинаково для обоих
 * режимов (HR/actual и начальник участка/capped), поэтому выходные у них сходятся.
 */
export function includeExportDayHours(
  entry: IAttendanceEntry,
  schedule: IResolvedSchedule | undefined,
  employeeId: number,
  date: string,
  calendar: IProductionCalendarMonth | null,
  exemptions: Set<string>,
): boolean {
  if (!schedule) return true;
  const [y, m, d] = date.split('-').map(Number);
  if (isWorkingDay(schedule, new Date(y, m - 1, d), calendar)) return true;
  if (entry.approval_status === 'approved' || entry.approval_status === 'auto_approved') return true;
  return exemptions.has(`${employeeId}|${date}`);
}

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
        `SELECT id, full_name, position_id, org_department_id, sigur_employee_id,
                employment_status, dismissal_date, excluded_from_timesheet_date
           FROM employees
           WHERE (employment_status = 'active'
                  OR (employment_status = 'fired'
                      AND dismissal_date IS NOT NULL
                      AND dismissal_date >= $2::date))
             AND is_archived = false
             AND id = ANY($1::int[])
           ORDER BY full_name`,
        [assignedEmployeeIds, startDate],
      );
    } else {
      employees = await query<Record<string, unknown>>(
        `SELECT id, full_name, position_id, org_department_id, sigur_employee_id,
                employment_status, dismissal_date, excluded_from_timesheet_date
           FROM employees
           WHERE (employment_status = 'active'
                  OR (employment_status = 'fired'
                      AND dismissal_date IS NOT NULL
                      AND dismissal_date >= $1::date))
             AND is_archived = false
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
    employment_status: (e.employment_status as string | null),
  }));
  // Дата выхода (cutoff) ТОЛЬКО для уволенных: дни >= cutoff не считаются в Excel
  // (норма/факт/ячейка), как в онлайн-табеле. Активных не трогаем.
  const cutoffByEmployeeId = buildFiredCutoffMap(employees, startDate);
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
    // Экспорт — read-only: не переписывать skud_travel_segments (тяжёлый write на больших выборках).
    persistTravelSegments: false,
  });

  // Плановые выходные за полный месяц — для решения, оставлять ли часы выходного дня.
  const weekendExemptions = await computeExportWeekendExemptions(
    empArr.map(e => e.id), year, mon, calendarMonth,
  );

  const dataMap = new Map<number, Map<string, { status: string; hours: number; corrected?: boolean; hoursOverridden?: boolean }>>();
  for (const [employeeId, dateMap] of attendance.byEmployeeDate) {
    dataMap.set(employeeId, new Map());
    for (const [date, entry] of dateMap) {
      const visibleHours = showActualHours
        ? (typeof entry.hours_worked === 'number' ? entry.hours_worked : 0)
        : (typeof entry.display_hours_worked === 'number'
          ? entry.display_hours_worked
          : (typeof entry.hours_worked === 'number' ? entry.hours_worked : 0));
      // Несогласованные/необязательные часы выходного не выгружаем (см. includeExportDayHours).
      const keepHours = includeExportDayHours(
        entry, dailySchedulesMap.get(employeeId)?.get(date), employeeId, date, calendarMonth, weekendExemptions,
      );
      dataMap.get(employeeId)!.set(date, {
        status: entry.status,
        hours: keepHours ? visibleHours : 0,
        corrected: entry.is_correction,
        hoursOverridden: entry.hours_overridden ?? false,
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
    cutoffByEmployeeId,
  };
}

/**
 * Строит cutoff-карту ТОЛЬКО для уволенных: дата (включительно), с которой дни
 * не считаются. cutoff = min(excluded_from_timesheet_date [если > startDate], dismissal_date+1).
 * Активные в карту не попадают → их выгрузка не меняется.
 */
function buildFiredCutoffMap(
  rows: Array<Record<string, unknown>>,
  startDate: string,
): Map<number, string | null> {
  const addOneIso = (iso: string): string => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  };
  const toIsoDate = (v: unknown): string | null => {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return null;
  };
  const map = new Map<number, string | null>();
  for (const e of rows) {
    if ((e.employment_status as string | null) !== 'fired') continue;
    const empId = Number(e.id);
    if (!Number.isFinite(empId)) continue;
    const excluded = toIsoDate(e.excluded_from_timesheet_date);
    const dismissal = toIsoDate(e.dismissal_date);
    const dismissalCutoff = dismissal ? addOneIso(dismissal) : null;
    // excluded учитываем только если оно ПОСЛЕ начала периода (иначе не ограничивает наш период).
    const excludedEff = excluded && excluded > startDate ? excluded : null;
    const candidates = [excludedEff, dismissalCutoff].filter((v): v is string => !!v);
    if (candidates.length === 0) continue;
    map.set(empId, candidates.reduce((min, v) => (v < min ? v : min)));
  }
  return map;
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
      `SELECT id, full_name, position_id, org_department_id, sigur_employee_id,
              employment_status, dismissal_date, excluded_from_timesheet_date
         FROM employees
         WHERE id = ANY($1::int[])
           AND (employment_status = 'active'
                OR (employment_status = 'fired'
                    AND dismissal_date IS NOT NULL
                    AND dismissal_date >= $2::date))
           AND is_archived = false
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
    employment_status: (e.employment_status as string | null),
  }));
  const cutoffByEmployeeId = buildFiredCutoffMap(employees, startDate);

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
    // Экспорт — read-only: не переписывать skud_travel_segments (тяжёлый write на больших выборках).
    persistTravelSegments: false,
  });

  // Плановые выходные за полный месяц — для решения, оставлять ли часы выходного дня.
  const weekendExemptions = await computeExportWeekendExemptions(
    empArr.map(e => e.id), year, mon, calendarMonth,
  );

  const dataMap = new Map<number, Map<string, { status: string; hours: number; corrected?: boolean; hoursOverridden?: boolean }>>();
  for (const [employeeId, dateMap] of attendance.byEmployeeDate) {
    dataMap.set(employeeId, new Map());
    for (const [date, entry] of dateMap) {
      const visibleHours = showActualHours
        ? (typeof entry.hours_worked === 'number' ? entry.hours_worked : 0)
        : (typeof entry.display_hours_worked === 'number'
          ? entry.display_hours_worked
          : (typeof entry.hours_worked === 'number' ? entry.hours_worked : 0));
      // Несогласованные/необязательные часы выходного не выгружаем (см. includeExportDayHours).
      const keepHours = includeExportDayHours(
        entry, dailySchedulesMap.get(employeeId)?.get(date), employeeId, date, calendarMonth, weekendExemptions,
      );
      dataMap.get(employeeId)!.set(date, {
        status: entry.status,
        hours: keepHours ? visibleHours : 0,
        corrected: entry.is_correction,
        hoursOverridden: entry.hours_overridden ?? false,
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
    cutoffByEmployeeId,
  };
}

/**
 * Нарезает результат одного bulk-прогона `fetchTimesheetDataForEmployees` обратно
 * в «поотдельские» `IDepartmentTimesheetData` по списку сотрудников отдела.
 * Тяжёлые выборки (attendance/skud) делаются один раз на всех — нарезка чисто
 * in-memory: фильтрация массивов/Map по множеству employee_id. Общие поля
 * (calendarMonth, posMap, year/mon/exportDays, showActualHours) копируются по ссылке.
 */
export function sliceTimesheetDataByEmployees(
  bulk: IDepartmentTimesheetData,
  employeeIds: number[],
  departmentName: string,
  departmentId: string | null,
): IDepartmentTimesheetData {
  const ids = new Set(employeeIds);
  const filterByEmployeeMap = <V>(map: Map<number, V>): Map<number, V> => {
    const next = new Map<number, V>();
    for (const [employeeId, value] of map) {
      if (ids.has(employeeId)) next.set(employeeId, value);
    }
    return next;
  };

  return {
    ...bulk,
    departmentName,
    departmentId,
    isBrigade: departmentName.toLowerCase().startsWith('бр.'),
    employees: bulk.employees.filter(e => ids.has(e.id)),
    schedulesMap: filterByEmployeeMap(bulk.schedulesMap),
    dailySchedulesMap: filterByEmployeeMap(bulk.dailySchedulesMap),
    entries: bulk.entries.filter(entry => ids.has(entry.employee_id)),
    dataMap: filterByEmployeeMap(bulk.dataMap),
    objectEntries: bulk.objectEntries.filter(entry => ids.has(entry.employee_id)),
    skudMap: filterByEmployeeMap(bulk.skudMap),
    cutoffByEmployeeId: bulk.cutoffByEmployeeId
      ? filterByEmployeeMap(bulk.cutoffByEmployeeId)
      : undefined,
  };
}
