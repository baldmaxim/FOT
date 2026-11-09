/**
 * Компания сотрудника на дату прохода — для статистики «Сотрудники на объектах» за месяц.
 *
 * Текущий отдел для прошлого месяца не годится: уволенный после периода лежит в «Уволенных»,
 * переведённый — в новом отделе. Поэтому отдел на дату берётся из истории назначений
 * (employee_assignments) по той же трактовке, что сегменты переводов единого файла 1С
 * (buildTransferSegments): порядок effective_from + id, «Уволенные» — промежуток увольнения,
 * его дни относятся к ближайшему предыдущему неархивному назначению (нет его — следующему).
 *
 * Отдел → компания: узел-ребёнок корня «Объект» (getCompanyResolveIndex), как на экране.
 * Только для проходов с карточкой сотрудника; внешним компанию даёт группа Sigur.
 */
import { query } from '../config/postgres.js';
import { getCompanyResolveIndex } from './skud-shared.service.js';
import {
  compareAssignmentRows,
  normalizeArchiveAssignments,
  type IAssignmentPeriodRow,
} from './timesheet-department-assignments.service.js';

export const NO_COMPANY_KEY = 'nocompany';
export const NO_COMPANY_NAME = 'Без компании';

export interface ICompanyRef {
  key: string;
  name: string;
}

export interface IDismissalRow {
  employee_id: number;
  from_department_id: string | null;
  dismissal_date: string;
}

export interface ICompanyOnDateSource {
  /** Назначения сотрудника: отсортированы, архив заменён соседним отделом. */
  assignmentsByEmployee: Map<number, IAssignmentPeriodRow[]>;
  currentDeptByEmployee: Map<number, string | null>;
  /** Неотменённые увольнения с отделом, по возрастанию даты. */
  dismissalsByEmployee: Map<number, IDismissalRow[]>;
  archiveDeptId: string;
  companyOfDept: (deptId: string) => ICompanyRef | null;
}

export const NO_COMPANY: ICompanyRef = { key: NO_COMPANY_KEY, name: NO_COMPANY_NAME };

/**
 * Отдел на дату:
 *  1) назначение, покрывающее дату (несколько — последнее в порядке effective_from, id);
 *  2) дата в промежутке — предыдущее назначение, раньше первой записи — первое
 *     (текущий отдел назад не тянем);
 *  3) назначений нет — текущий org_department_id;
 *  4) отдела нет или остался «Уволенные» (донора не нашлось) — отдел увольнения:
 *     ближайшее увольнение с датой ≥ дня прохода, иначе последнее.
 * null — отдела нет ни в одном источнике.
 */
export function resolveDeptOnDate(
  source: ICompanyOnDateSource,
  employeeId: number,
  date: string,
): string | null {
  const assignments = source.assignmentsByEmployee.get(employeeId) ?? [];
  let deptId: string | null;

  if (assignments.length > 0) {
    const started = assignments.filter(row => row.effective_from <= date);
    const covering = started.filter(row => row.effective_to == null || row.effective_to >= date);
    if (covering.length > 0) deptId = covering[covering.length - 1].org_department_id;
    else if (started.length > 0) deptId = started[started.length - 1].org_department_id;
    else deptId = assignments[0].org_department_id;
  } else {
    deptId = source.currentDeptByEmployee.get(employeeId) ?? null;
  }

  if (deptId && deptId !== source.archiveDeptId) return deptId;

  const dismissals = source.dismissalsByEmployee.get(employeeId) ?? [];
  const dismissal = dismissals.find(row => row.dismissal_date >= date) ?? dismissals[dismissals.length - 1];
  return dismissal?.from_department_id ?? deptId;
}

export function resolveCompanyOnDate(
  source: ICompanyOnDateSource,
  employeeId: number,
  date: string,
): ICompanyRef {
  const deptId = resolveDeptOnDate(source, employeeId, date);
  return (deptId ? source.companyOfDept(deptId) : null) ?? NO_COMPANY;
}

interface IAssignmentDbRow {
  id: string;
  employee_id: number | string;
  org_department_id: string | null;
  effective_from: string;
  effective_to: string | null;
}

interface IDismissalDbRow {
  employee_id: number | string;
  from_department_id: string | null;
  dismissal_date: string;
}

/**
 * Загружает историю для набора сотрудников. Назначения — все, без отсечения по датам:
 * «раньше первой записи» и донор архива могут лежать вне периода (таблица мала,
 * индекс idx_assignments_employee).
 */
export async function loadCompanyOnDateSource(
  employeeIds: number[],
  archiveDeptId: string,
): Promise<ICompanyOnDateSource> {
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];

  const [assignmentRows, employeeRows, dismissalRows, companyIndex] = await Promise.all([
    ids.length > 0
      ? query<IAssignmentDbRow>(
        `SELECT id::text AS id, employee_id, org_department_id::text AS org_department_id,
                effective_from::text AS effective_from, effective_to::text AS effective_to
           FROM employee_assignments
          WHERE employee_id = ANY($1::int[])`,
        [ids],
      )
      : Promise.resolve([] as IAssignmentDbRow[]),
    ids.length > 0
      ? query<{ id: number | string; org_department_id: string | null }>(
        'SELECT id, org_department_id::text AS org_department_id FROM employees WHERE id = ANY($1::int[])',
        [ids],
      )
      : Promise.resolve([]),
    ids.length > 0
      ? query<IDismissalDbRow>(
        `SELECT employee_id, from_department_id::text AS from_department_id,
                dismissal_date::text AS dismissal_date
           FROM employee_dismissal_events
          WHERE employee_id = ANY($1::int[])
            AND cancelled = false
            AND dismissal_date IS NOT NULL
            AND from_department_id IS NOT NULL
            AND from_department_id <> $2::uuid
          ORDER BY employee_id, dismissal_date, created_at`,
        [ids, archiveDeptId],
      )
      : Promise.resolve([] as IDismissalDbRow[]),
    getCompanyResolveIndex(),
  ]);

  const grouped = new Map<number, IAssignmentPeriodRow[]>();
  for (const row of assignmentRows) {
    const employeeId = Number(row.employee_id);
    if (!Number.isFinite(employeeId)) continue;
    const list = grouped.get(employeeId) ?? [];
    list.push({
      id: row.id,
      employee_id: employeeId,
      org_department_id: row.org_department_id,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    });
    grouped.set(employeeId, list);
  }
  const assignmentsByEmployee = new Map<number, IAssignmentPeriodRow[]>();
  for (const [employeeId, list] of grouped) {
    assignmentsByEmployee.set(
      employeeId,
      normalizeArchiveAssignments([...list].sort(compareAssignmentRows), archiveDeptId),
    );
  }

  const currentDeptByEmployee = new Map<number, string | null>();
  for (const row of employeeRows) {
    currentDeptByEmployee.set(Number(row.id), row.org_department_id ?? null);
  }

  const dismissalsByEmployee = new Map<number, IDismissalRow[]>();
  for (const row of dismissalRows) {
    const employeeId = Number(row.employee_id);
    const list = dismissalsByEmployee.get(employeeId) ?? [];
    list.push({ employee_id: employeeId, from_department_id: row.from_department_id, dismissal_date: row.dismissal_date });
    dismissalsByEmployee.set(employeeId, list);
  }

  const companyOfDept = (deptId: string): ICompanyRef | null => {
    const companyId = companyIndex.companyByDeptId.get(deptId);
    if (!companyId) return null;
    const name = companyIndex.companyMeta.get(companyId)?.name;
    return name ? { key: `local:${companyId}`, name } : null;
  };

  return { assignmentsByEmployee, currentDeptByEmployee, dismissalsByEmployee, archiveDeptId, companyOfDept };
}
