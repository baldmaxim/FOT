import { query, queryOne } from '../config/postgres.js';
import { collectDeptIds } from './skud-shared.service.js';

export type TimesheetDisplayHalf = 'H1' | 'H2' | 'FULL';

export interface ITimesheetPeriodRange {
  half: TimesheetDisplayHalf;
  year: number;
  month: number;
  daysInMonth: number;
  startDate: string;
  endDate: string;
}

export interface IEmployeeDepartmentAssignment {
  id: string;
  employee_id: number;
  org_department_id: string | null;
  position_id: string | null;
  effective_from: string;
  effective_to: string | null;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

export const formatDateShift = (date: string, days: number): string => {
  const cursor = new Date(`${date}T00:00:00`);
  cursor.setDate(cursor.getDate() + days);
  return `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
};

export const isAssignmentActiveOnDateInclusive = (
  effectiveFrom: string | null | undefined,
  effectiveTo: string | null | undefined,
  date: string,
): boolean => {
  if (!effectiveFrom || effectiveFrom > date) return false;
  return effectiveTo == null || effectiveTo >= date;
};

export const resolveTimesheetPeriodRange = (
  month: string,
  halfValue?: string | null,
): ITimesheetPeriodRange | null => {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;

  const year = Number.parseInt(month.slice(0, 4), 10);
  const mon = Number.parseInt(month.slice(5, 7), 10);
  if (!Number.isFinite(year) || !Number.isFinite(mon) || mon < 1 || mon > 12) {
    return null;
  }

  const daysInMonth = new Date(year, mon, 0).getDate();
  const half: TimesheetDisplayHalf = halfValue === 'H1' || halfValue === 'H2' || halfValue === 'FULL'
    ? halfValue
    : 'FULL';

  const startDay = half === 'H2' ? 16 : 1;
  const endDay = half === 'H1' ? Math.min(15, daysInMonth) : daysInMonth;

  return {
    half,
    year,
    month: mon,
    daysInMonth,
    startDate: `${month}-${pad2(startDay)}`,
    endDate: `${month}-${pad2(endDay)}`,
  };
};

/**
 * Возвращает диапазон дат для отображения/экспорта табеля.
 * Приоритет у явно переданных `from`/`to` (ISO-даты в рамках месяца).
 * Если их нет — возвращает полный месяц (весь `month`).
 * Поле `half` помечается как 'FULL' при кастомном диапазоне (больше не несёт семантики).
 */
export const resolveTimesheetDateRange = (
  month: string,
  fromValue?: string | null,
  toValue?: string | null,
): ITimesheetPeriodRange | null => {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;

  const year = Number.parseInt(month.slice(0, 4), 10);
  const mon = Number.parseInt(month.slice(5, 7), 10);
  if (!Number.isFinite(year) || !Number.isFinite(mon) || mon < 1 || mon > 12) return null;

  const daysInMonth = new Date(year, mon, 0).getDate();
  const monthFirst = `${month}-01`;
  const monthLast = `${month}-${pad2(daysInMonth)}`;
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

  const fromValid = typeof fromValue === 'string' && isoDateRegex.test(fromValue)
    && fromValue >= monthFirst && fromValue <= monthLast
    ? fromValue
    : null;
  const toValid = typeof toValue === 'string' && isoDateRegex.test(toValue)
    && toValue >= monthFirst && toValue <= monthLast
    && (!fromValid || toValue >= fromValid)
    ? toValue
    : null;

  if (fromValid && toValid) {
    return {
      half: 'FULL',
      year,
      month: mon,
      daysInMonth,
      startDate: fromValid,
      endDate: toValid,
    };
  }

  return {
    half: 'FULL',
    year,
    month: mon,
    daysInMonth,
    startDate: monthFirst,
    endDate: monthLast,
  };
};

export interface IDepartmentEmployeeMembership {
  employee_id: number;
  /** Дата (включительно), с которой сотрудник перестал быть в этом отделе из-за перевода в другой; null = ещё в отделе. */
  transferred_out_date: string | null;
}

export async function listEmployeeIdsAssignedToDepartmentPeriod(
  departmentId: string,
  startDate: string,
  endDate: string,
): Promise<number[]> {
  const memberships = await listEmployeeMembershipsForDepartmentPeriod(departmentId, startDate, endDate);
  return memberships.map(m => m.employee_id);
}

/**
 * Возвращает сотрудников, чьё назначение в отдел (или поддерево) пересекалось с периодом
 * [startDate, endDate]. Для каждого вычисляет дату перевода (transferred_out_date) — это
 * дата, С КОТОРОЙ сотрудника больше нет в отделе. По инварианту парности это
 * effective_to ПОСЛЕДНЕГО закрытого назначения + 1 день (то есть effective_from нового
 * назначения), ПРИ УСЛОВИИ что у сотрудника больше нет открытого назначения сюда.
 * Если сотрудник всё ещё числится в отделе — transferred_out_date = null.
 *
 * Также фильтрует по excluded_from_timesheet_date: если сотрудник исключён ДО начала
 * периода — отбрасываем; если позже — оставляем (фронт зачеркнёт оставшиеся дни).
 */
export async function listEmployeeMembershipsForDepartmentPeriod(
  departmentId: string,
  startDate: string,
  endDate: string,
): Promise<IDepartmentEmployeeMembership[]> {
  const deptIds = await collectDeptIds(departmentId);

  // Все назначения, чей период пересекается с [startDate, endDate]:
  // effective_from <= endDate AND (effective_to IS NULL OR effective_to >= startDate).
  const assignments = await query<{
    employee_id: number;
    effective_from: string;
    effective_to: string | null;
    org_department_id: string | null;
  }>(
    `SELECT employee_id, effective_from, effective_to, org_department_id
       FROM employee_assignments
      WHERE org_department_id = ANY($1::uuid[])
        AND effective_from <= $2
        AND (effective_to IS NULL OR effective_to >= $3)`,
    [deptIds, endDate, startDate],
  );

  // Группируем: для каждого employee_id определяем, есть ли открытое назначение.
  const map = new Map<number, IDepartmentEmployeeMembership>();
  for (const row of assignments) {
    const empId = Number(row.employee_id);
    if (!Number.isFinite(empId)) continue;
    const effTo = (row.effective_to as string | null) ?? null;
    // Дата перевода = первый день, когда сотрудника уже нет в отделе.
    const transferDate = effTo ? formatDateShift(effTo, 1) : null;
    const existing = map.get(empId);
    if (!existing) {
      map.set(empId, { employee_id: empId, transferred_out_date: transferDate });
    } else if (effTo == null) {
      // Открытое назначение всегда побеждает — сотрудник в отделе.
      existing.transferred_out_date = null;
    } else if (
      existing.transferred_out_date != null
      && transferDate != null
      && transferDate > existing.transferred_out_date
    ) {
      existing.transferred_out_date = transferDate;
    }
  }

  // Также включаем тех, у кого employees.org_department_id уже указывает в поддерево
  // (snapshot), но assignment мог не успеть синхронизироваться — добавляем безопасным дефолтом.
  const snapshotEmployees = await query<{ id: number }>(
    'SELECT id FROM employees WHERE org_department_id = ANY($1::uuid[])',
    [deptIds],
  );
  for (const row of snapshotEmployees) {
    const empId = Number(row.id);
    if (!Number.isFinite(empId)) continue;
    if (!map.has(empId)) {
      map.set(empId, { employee_id: empId, transferred_out_date: null });
    } else {
      // Если в snapshot он в этом отделе — точно ещё не переведён.
      const m = map.get(empId)!;
      m.transferred_out_date = null;
    }
  }

  const candidateIds = [...map.keys()];
  if (candidateIds.length === 0) return [];

  // Финальный фильтр: активные, не архивные. Исключённых — оставляем, если дата исключения > startDate.
  // Уволенные сотрудники с dismissal_date >= startDate попадают в табель, чтобы был виден период до увольнения.
  const activeRows = await query<{
    id: number;
    excluded_from_timesheet: boolean;
    excluded_from_timesheet_date: string | null;
  }>(
    `SELECT id, excluded_from_timesheet, excluded_from_timesheet_date
       FROM employees
      WHERE id = ANY($1::int[])
        AND is_archived = false
        AND (employment_status = 'active'
             OR (employment_status = 'fired'
                 AND dismissal_date IS NOT NULL
                 AND dismissal_date >= $2::date))`,
    [candidateIds, startDate],
  );

  const result: IDepartmentEmployeeMembership[] = [];
  for (const row of activeRows) {
    const empId = Number(row.id);
    const m = map.get(empId);
    if (!m) continue;
    const excluded = !!row.excluded_from_timesheet;
    const excludedDate = row.excluded_from_timesheet_date ?? null;
    if (excluded) {
      // Если дата исключения известна и она ПОСЛЕ начала периода — оставляем.
      // Иначе (дата неизвестна или раньше начала) — отбрасываем.
      if (!excludedDate || excludedDate <= startDate) continue;
    }
    result.push(m);
  }
  return result;
}

export async function isEmployeeAssignedToDepartmentOnDate(
  employeeId: number,
  departmentId: string,
  date: string,
): Promise<boolean> {
  // Семантика: сотрудник числится в поддереве departmentId на дату.
  // Это нужно для руководителя родительского отдела с сотрудниками в под-отделах.
  const deptIds = await collectDeptIds(departmentId);

  const data = await queryOne<{
    id: string;
    org_department_id: string | null;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT id, org_department_id, effective_from, effective_to
       FROM employee_assignments
      WHERE employee_id = $1
        AND org_department_id = ANY($2::uuid[])
        AND effective_from <= $3
        AND (effective_to IS NULL OR effective_to >= $3)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [employeeId, deptIds, date],
  );

  if (!data) {
    const employee = await queryOne<{ org_department_id: string | null }>(
      'SELECT org_department_id FROM employees WHERE id = $1',
      [employeeId],
    );
    const empDept = String(employee?.org_department_id || '');
    return empDept.length > 0 && deptIds.includes(empDept);
  }

  return isAssignmentActiveOnDateInclusive(
    data.effective_from ?? undefined,
    data.effective_to ?? undefined,
    date,
  );
}

export async function getEmployeeAssignments(employeeId: number): Promise<IEmployeeDepartmentAssignment[]> {
  const data = await query<{
    id: string;
    employee_id: number;
    org_department_id: string | null;
    position_id: string | null;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT id, employee_id, org_department_id, position_id, effective_from, effective_to
       FROM employee_assignments
      WHERE employee_id = $1
      ORDER BY effective_from ASC, created_at ASC`,
    [employeeId],
  );

  return data.map(row => ({
    id: String(row.id),
    employee_id: Number(row.employee_id),
    org_department_id: row.org_department_id ?? null,
    position_id: row.position_id ?? null,
    effective_from: String(row.effective_from),
    effective_to: row.effective_to ?? null,
  }));
}

export async function getEmployeeAssignmentSnapshotDepartment(
  employeeId: number,
  referenceDate: string,
): Promise<string | null> {
  const assignments = await getEmployeeAssignments(employeeId);
  const activeAssignment = [...assignments]
    .reverse()
    .find(assignment => isAssignmentActiveOnDateInclusive(
      assignment.effective_from,
      assignment.effective_to,
      referenceDate,
    )) || null;

  return activeAssignment?.org_department_id ?? null;
}
