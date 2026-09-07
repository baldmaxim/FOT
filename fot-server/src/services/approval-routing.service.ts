import { listEffectiveDepartmentManagers } from './department-managers.service.js';
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
 *  - `weekday_correction` — корректировка в рабочий день. Согласуют начальник(и)
 *    отдела (ручной full-доступ), и только если их нет — непосредственный
 *    руководитель из employee_direct_reports. Порядок именно такой: табель ведёт
 *    руководитель отдела, значит и корректировки смотрит он, а личный руководитель
 *    остаётся ответственным лишь там, где руководителя отдела нет (ЛИНИЯ и
 *    ЛИНИЯ-Общестрой).
 *
 * Нет ответственного → пустой список (fallback на текущую scope-логику/админа,
 * решается в контроллере).
 */

/**
 * Начальники отдела как согласующие, без самого сотрудника строки: иначе руководитель
 * согласовал бы собственную заявку. Если у отдела два руководителя — останется второй;
 * если больше некому, вызывающий уходит на личного руководителя.
 */
function pickHeads(
  deptManagers: Map<string, number[]>,
  departmentId: string | null,
  employeeId: number,
): number[] {
  if (!departmentId) return [];
  return (deptManagers.get(String(departmentId)) ?? []).filter(id => id !== employeeId);
}

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

/**
 * deptId → employee_id начальников отдела, которые реально могут вести табель:
 * ручной full-доступ + активный сотрудник + одобренный профиль + право edit на
 * /timesheet. Без последнего условия «руководитель отдела» перехватил бы маршрут
 * у личного руководителя и заявление осталось бы без согласующего.
 */
export async function listFullManagersForDepartments(
  departmentIds: string[],
): Promise<Map<string, number[]>> {
  return listEffectiveDepartmentManagers(departmentIds);
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
    const employeeId = Number(row.employee_id);
    const heads = pickHeads(deptManagers, row.org_department_id, employeeId);
    if (heads.length > 0) {
      result.set(row.id, heads);
      continue;
    }
    const dm = directMgrs.get(employeeId);
    result.set(row.id, dm ? [dm.managerId] : []);
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
    const heads = pickHeads(deptManagers, e.org_department_id, empId);
    if (heads.length > 0) {
      result.set(empId, heads);
      continue;
    }
    const dm = directMgrs.get(empId);
    result.set(empId, dm ? [dm.managerId] : []);
  }
  return result;
}
