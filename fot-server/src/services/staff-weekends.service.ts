import { query } from '../config/postgres.js';
import { validateCorrectionAttachments } from './timesheet-approval-correction-validation.service.js';
import {
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  listEmployeeMembershipsForDepartmentPeriod,
  resolveTimesheetPeriodRange,
  type IMembershipWindow,
} from './timesheet-department-assignments.service.js';

/**
 * «Управление кадрами» → «Выходные» (миграция 346): кто из ЛИНИЯ и ЛИНИЯ-Общестрой работал в выходной по СКУД,
 * а корректировки на этот день нет.
 *
 * Правила дня (личный график, плановые субботы, СКУД, корректировка, заявление на согласовании) — из проверки
 * подачи табеля (validateCorrectionAttachments), своей копии правил здесь нет. Состав свой, как в сетке табеля:
 * уволенный виден в месяце увольнения до его даты, нижняя граница окна — только при настоящем переводе.
 */

/** ЛИНИЯ и ЛИНИЯ-Общестрой. По id, а не по названию: переименование отдела список не обнулит. */
export const STAFF_WEEKENDS_BRANCH_IDS: readonly string[] = [
  '60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4',
  '0b24809e-5f04-45e1-bbe2-8a82990d6bdd',
];

/** Месяцев за один запрос прежнего списка (?months=), пока старая вкладка не выведена. */
export const STAFF_WEEKENDS_MAX_MONTHS = 12;

export interface IStaffWeekendRow {
  employee_id: number;
  full_name: string;
  /** Отдел на последний показанный день: ЛИНИЯ или ЛИНИЯ-Общестрой, а не текущий («Уволенные» у уволенного). */
  department: string | null;
  /** Текущая должность. */
  position: string | null;
  /** Дни YYYY-MM-DD по возрастанию. */
  days: string[];
  /** Минуты СКУД за эти дни. */
  total_minutes: number;
}

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
  rows: IStaffWeekendGridRow[];
}

interface IBranchWindows {
  branchId: string;
  windows: Map<number, IMembershipWindow>;
}

/** Сотрудник → день → отдел этого дня. */
type DaysByEmployee = Map<number, Map<string, string>>;

/** В каком отделе сотрудник числился в этот день; ни в каком — null. */
const branchOfDay = (branches: readonly IBranchWindows[], employeeId: number, date: string): string | null => {
  const found = branches.find(({ windows }) => {
    const window = windows.get(employeeId);
    // Без окна isWithinMembershipWindow вернул бы true: сотрудник другого отдела, а не «без ограничений».
    return window !== undefined && isWithinMembershipWindow(window, date, 'viaTransferOnly');
  });
  return found?.branchId ?? null;
};

/** Дни одного месяца — в общую карту. */
const collectMonthDays = async (month: string, branchIds: readonly string[], result: DaysByEmployee): Promise<void> => {
  const range = resolveTimesheetPeriodRange(month);
  if (!range) return;

  // Окна — своя карта на отдел: при переводе между отделами окно второго не должно затереть первое.
  const branches: IBranchWindows[] = [];
  for (const branchId of branchIds) {
    const memberships = await listEmployeeMembershipsForDepartmentPeriod(
      branchId, range.startDate, range.endDate, undefined, { firedInDismissalMonth: true },
    );
    branches.push({ branchId, windows: buildMembershipWindowMap(memberships) });
  }
  const employeeIds = [...new Set(branches.flatMap(({ windows }) => [...windows.keys()]))];
  if (employeeIds.length === 0) return;

  // Один вызов на всех: плановые субботы — квота человека за месяц, а не его отрезка в отделе.
  const validation = await validateCorrectionAttachments({ kind: 'personal', employeeIds }, range);
  if (validation.ok) return;

  for (const { kind, employee_id: employeeId, date } of validation.missing) {
    if (kind !== 'weekend_no_correction') continue;
    const branchId = branchOfDay(branches, employeeId, date);
    if (!branchId) continue;
    let days = result.get(employeeId);
    if (!days) {
      days = new Map();
      result.set(employeeId, days);
    }
    days.set(date, branchId);
  }
};

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
 * Сетка вкладки за месяц YYYY-MM: каждый отдел отдельно, в порядке branchIds, в том числе без людей.
 * Переведённый между отделами внутри месяца — по строке в каждом, со своими днями. Квота плановых суббот при этом
 * общая на человека: проверка одна на оба отдела (collectMonthDays).
 */
export const listWeekendsByBranch = async (
  month: string,
  branchIds: readonly string[],
): Promise<IStaffWeekendBranch[]> => {
  if (branchIds.length === 0) return [];

  const daysByEmployee: DaysByEmployee = new Map();
  await collectMonthDays(month, branchIds, daysByEmployee);
  const employeeIds = [...daysByEmployee.keys()];

  const [employees, branches] = await Promise.all([
    employeeIds.length > 0 ? loadEmployeeDetails(employeeIds) : Promise.resolve([]),
    query<{ id: string; name: string }>(
      'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
      [[...branchIds]],
    ),
  ]);
  const branchName = new Map(branches.map(branch => [branch.id, branch.name]));

  return branchIds.map((branchId): IStaffWeekendBranch => ({
    id: branchId,
    name: branchName.get(branchId) ?? '',
    rows: employees
      .map((employee): IStaffWeekendGridRow => {
        const employeeId = Number(employee.id);
        const days = [...(daysByEmployee.get(employeeId) ?? new Map<string, string>())]
          .filter(([, dayBranch]) => dayBranch === branchId)
          .map(([day]) => day)
          .sort();
        return { employee_id: employeeId, full_name: employee.full_name ?? '', position: employee.position, days };
      })
      .filter(row => row.days.length > 0)
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru')),
  }));
};

/**
 * Строка на сотрудника за выбранные месяцы (YYYY-MM), по ФИО. branchIds — отделы в охвате пользователя;
 * пустой — пустой список без запросов к БД.
 */
export const listWeekendsWithoutCorrection = async (
  months: readonly string[],
  branchIds: readonly string[],
): Promise<IStaffWeekendRow[]> => {
  if (branchIds.length === 0) return [];

  const daysByEmployee: DaysByEmployee = new Map();
  for (const month of months) {
    await collectMonthDays(month, branchIds, daysByEmployee);
  }
  const employeeIds = [...daysByEmployee.keys()];
  if (employeeIds.length === 0) return [];
  const allDates = [...new Set([...daysByEmployee.values()].flatMap(days => [...days.keys()]))];

  const [employees, summaries, branches] = await Promise.all([
    loadEmployeeDetails(employeeIds),
    query<{ employee_id: number; date: string; total_minutes: number }>(
      `SELECT employee_id, date::text AS date, total_minutes
         FROM skud_daily_summary
        WHERE employee_id = ANY($1::int[]) AND date = ANY($2::date[])`,
      [employeeIds, allDates],
    ),
    query<{ id: string; name: string }>(
      'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
      [[...branchIds]],
    ),
  ]);

  const minutesByDay = new Map(summaries.map(row => [`${Number(row.employee_id)}|${row.date}`, Number(row.total_minutes)]));
  const branchName = new Map(branches.map(branch => [branch.id, branch.name]));

  return employees
    .map((employee): IStaffWeekendRow => {
      const employeeId = Number(employee.id);
      const dayBranches = daysByEmployee.get(employeeId) ?? new Map<string, string>();
      const days = [...dayBranches.keys()].sort();
      const lastBranch = dayBranches.get(days[days.length - 1] ?? '');
      return {
        employee_id: employeeId,
        full_name: employee.full_name ?? '',
        department: lastBranch ? branchName.get(lastBranch) ?? null : null,
        position: employee.position,
        days,
        total_minutes: days.reduce((sum, day) => sum + (minutesByDay.get(`${employeeId}|${day}`) ?? 0), 0),
      };
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));
};
