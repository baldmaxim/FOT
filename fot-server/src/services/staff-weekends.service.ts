import { query } from '../config/postgres.js';
import { describeBranches, loadBranchOwnership, type IBranchPathNode } from './staff-branch-ownership.service.js';
import { resolveTimesheetPeriodRange } from './timesheet-department-assignments.service.js';
import { listWeekendMissingDays } from './weekend-missing-days.service.js';

/**
 * «Управление кадрами» → «Выходные» (миграция 346): кто работал в выходной по СКУД (в том числе вошёл без пары —
 * часов нет), а корректировки на этот день нет. По всем отделам и бригадам месяца, кроме подрядчиков и «Уволенных».
 *
 * Правила дня — weekend-missing-days.service (общие с рамками «Табеля»). Отделы и владелец дня —
 * staff-branch-ownership.service: день достаётся самому глубокому отделу, охват применяется после.
 */

/** Строка сетки вкладки. Часов нет намеренно: часы показывает табель, в сводке СКУД обед не вычтен. */
export interface IStaffWeekendGridRow {
  employee_id: number;
  full_name: string;
  position: string | null;
  /** Дни этого отдела, YYYY-MM-DD по возрастанию. */
  days: string[];
}

export interface IStaffWeekendBranch {
  id: string;
  name: string;
  /** Предки от корня до родителя: список отделов — деревом. */
  path: IBranchPathNode[];
  rows: IStaffWeekendGridRow[];
}

export interface IWeekendBranchScope {
  /** Все кандидаты месяца: по ним определяется владелец дня. */
  ownershipBranchIds: readonly string[];
  /** Отделы в охвате пользователя: только они попадают в ответ. */
  visibleBranchIds: readonly string[];
}

interface IEmployeeDetails {
  id: number;
  full_name: string | null;
  position: string | null;
}

const loadEmployeeDetails = (employeeIds: readonly number[]): Promise<IEmployeeDetails[]> => query<IEmployeeDetails>(
  `SELECT e.id, e.full_name, p.name AS position
     FROM employees e
     LEFT JOIN positions p ON p.id = e.position_id
    WHERE e.id = ANY($1::int[])`,
  [employeeIds],
);

/**
 * Сетка вкладки за месяц YYYY-MM: каждый видимый отдел, в том числе без людей (отбор делает контроллер), по пути
 * в дереве. Переведённый внутри месяца — по строке в каждом отделе со своими днями; квота плановых суббот общая на
 * человека — проверка одна на всех.
 */
export const listWeekendsByBranch = async (
  month: string,
  { ownershipBranchIds, visibleBranchIds }: IWeekendBranchScope,
): Promise<IStaffWeekendBranch[]> => {
  const range = resolveTimesheetPeriodRange(month);
  if (!range || visibleBranchIds.length === 0) return [];

  const visible = new Set(visibleBranchIds);
  const ownership = await loadBranchOwnership(month, ownershipBranchIds);
  const missing = await listWeekendMissingDays(ownership.employeeIds, range);

  // Отдел → сотрудник → дни.
  const daysByBranch = new Map<string, Map<number, string[]>>();
  for (const { employee_id: employeeId, date } of missing) {
    const branchId = ownership.ownerOf(employeeId, date);
    if (!branchId || !visible.has(branchId)) continue;
    let byEmployee = daysByBranch.get(branchId);
    if (!byEmployee) {
      byEmployee = new Map();
      daysByBranch.set(branchId, byEmployee);
    }
    byEmployee.set(employeeId, [...(byEmployee.get(employeeId) ?? []), date]);
  }

  const employeeIds = [...new Set([...daysByBranch.values()].flatMap(byEmployee => [...byEmployee.keys()]))];
  const [employees, branches] = await Promise.all([
    employeeIds.length > 0 ? loadEmployeeDetails(employeeIds) : Promise.resolve([]),
    describeBranches([...visible]),
  ]);
  const employeeById = new Map(employees.map(employee => [Number(employee.id), employee]));

  return branches.map(({ id, name, path }): IStaffWeekendBranch => ({
    id,
    name,
    path,
    rows: [...(daysByBranch.get(id) ?? new Map<number, string[]>())]
      .map(([employeeId, days]): IStaffWeekendGridRow => {
        const employee = employeeById.get(employeeId);
        return {
          employee_id: employeeId,
          full_name: employee?.full_name ?? '',
          position: employee?.position ?? null,
          days: [...new Set(days)].sort(),
        };
      })
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru')),
  }));
};
