import { query } from '../config/postgres.js';
import { resolveSchedulesForPeriod, isWorkingDay, loadCalendarMonth } from './schedule.service.js';
import { loadAssignmentMaps, resolveFromMaps } from './weekend-approval-assignments.service.js';
import { getActiveDirectManagersFor } from './employee-direct-reports.service.js';

/**
 * Маршрутизация согласований корректировок к ответственным.
 *
 * Категория строки:
 *  - `weekend` — work/remote в нерабочий по графику день (выходной/праздник,
 *    необязательная сб/вс). Согласует назначенный в «Выходных» ответственный
 *    (weekend_approval_assignments): приоритет по сотруднику → по его отделу.
 *  - `weekday_correction` — корректировка в рабочий день. Согласует
 *    непосредственный руководитель (employee_direct_reports), иначе начальник(и)
 *    отдела с full-доступом (ручное назначение, source<>'sigur_sync').
 *
 * Нет ответственного → пустой список (fallback на текущую scope-логику/админа,
 * решается в контроллере).
 */

export interface IRoutableRow {
  id: number;
  employee_id: number;
  work_date: string;
  org_department_id: string | null;
}

/** rowId → true, если строка приходится на нерабочий по графику день (выходной/праздник). */
export async function classifyWeekendRows(rows: IRoutableRow[]): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (rows.length === 0) return result;

  const empIds = [...new Set(rows.map(r => Number(r.employee_id)))];
  const dates = rows.map(r => r.work_date).sort();
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const schedules = await resolveSchedulesForPeriod(empIds.map(id => ({ id })), startDate, endDate);

  const calendarCache = new Map<string, Awaited<ReturnType<typeof loadCalendarMonth>>>();
  const getCalendar = async (dateObj: Date) => {
    const key = `${dateObj.getFullYear()}-${dateObj.getMonth() + 1}`;
    if (!calendarCache.has(key)) {
      calendarCache.set(key, await loadCalendarMonth(dateObj.getFullYear(), dateObj.getMonth() + 1));
    }
    return calendarCache.get(key) ?? null;
  };

  for (const row of rows) {
    const schedule = schedules.get(Number(row.employee_id))?.get(row.work_date);
    if (!schedule) {
      // Нет графика — на согласование такой день обычно не попадает; считаем будним.
      result.set(row.id, false);
      continue;
    }
    const dateObj = new Date(`${row.work_date}T00:00:00`);
    const calendar = await getCalendar(dateObj);
    result.set(row.id, !isWorkingDay(schedule, dateObj, calendar));
  }
  return result;
}

/** deptId → employee_id начальников отдела (ручной full-доступ, не sigur_sync). */
export async function listFullManagersForDepartments(
  departmentIds: string[],
): Promise<Map<string, number[]>> {
  const ids = [...new Set(departmentIds.filter(id => typeof id === 'string' && id.length > 0))];
  const map = new Map<string, number[]>();
  if (ids.length === 0) return map;
  const rows = await query<{ employee_id: number; department_id: string }>(
    `SELECT employee_id, department_id
       FROM employee_department_access
      WHERE department_id = ANY($1::uuid[])
        AND is_active = true
        AND access_level = 'full'
        AND source <> 'sigur_sync'`,
    [ids],
  );
  for (const r of rows) {
    const dept = String(r.department_id);
    const list = map.get(dept) ?? [];
    list.push(Number(r.employee_id));
    map.set(dept, list);
  }
  return map;
}

/**
 * Для каждой строки — employee_id ответственного(их). Пусто = ответственного нет
 * (fallback решает контроллер).
 */
export async function resolveResponsibleEmployeeIdsForRows(
  rows: IRoutableRow[],
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  if (rows.length === 0) return result;

  const [isWeekendMap, weekendMaps, directMgrs] = await Promise.all([
    classifyWeekendRows(rows),
    loadAssignmentMaps(),
    getActiveDirectManagersFor([...new Set(rows.map(r => Number(r.employee_id)))]),
  ]);

  const deptIds = [...new Set(rows
    .map(r => r.org_department_id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const deptManagers = await listFullManagersForDepartments(deptIds);

  for (const row of rows) {
    const isWeekend = isWeekendMap.get(row.id) ?? false;
    if (isWeekend) {
      const responsible = resolveFromMaps(weekendMaps, Number(row.employee_id), row.org_department_id);
      result.set(row.id, responsible != null ? [responsible] : []);
      continue;
    }
    const dm = directMgrs.get(Number(row.employee_id));
    if (dm) {
      result.set(row.id, [dm.managerId]);
      continue;
    }
    const heads = row.org_department_id ? (deptManagers.get(String(row.org_department_id)) ?? []) : [];
    result.set(row.id, heads);
  }
  return result;
}

/**
 * Адресная маршрутизация по сотруднику (без привязки к дате) — для заявлений
 * (отпуск/больничный/за свой счёт). Приоритет: непосредственный руководитель
 * (employee_direct_reports), иначе начальник(и) отдела с full-доступом
 * (ручное назначение, source<>'sigur_sync'). Пусто = ответственного нет.
 */
export async function resolveResponsibleEmployeeIdsByEmployee(
  employees: Array<{ employee_id: number; org_department_id: string | null }>,
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  if (employees.length === 0) return result;

  const empIds = [...new Set(employees.map(e => Number(e.employee_id)))];
  const [directMgrs, deptManagers] = await Promise.all([
    getActiveDirectManagersFor(empIds),
    listFullManagersForDepartments(
      [...new Set(employees
        .map(e => e.org_department_id)
        .filter((v): v is string => typeof v === 'string' && v.length > 0))],
    ),
  ]);

  for (const e of employees) {
    const empId = Number(e.employee_id);
    const dm = directMgrs.get(empId);
    if (dm) {
      result.set(empId, [dm.managerId]);
      continue;
    }
    const heads = e.org_department_id ? (deptManagers.get(String(e.org_department_id)) ?? []) : [];
    result.set(empId, heads);
  }
  return result;
}
