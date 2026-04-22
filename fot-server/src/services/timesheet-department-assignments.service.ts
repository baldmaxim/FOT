import { supabase } from '../config/database.js';

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

export async function listEmployeeIdsAssignedToDepartmentPeriod(
  departmentId: string,
  startDate: string,
  endDate: string,
): Promise<number[]> {
  const { data, error } = await supabase
    .from('employee_assignments')
    .select('employee_id')
    .eq('org_department_id', departmentId)
    .lte('effective_from', endDate)
    .or(`effective_to.is.null,effective_to.gte.${startDate}`);

  if (error) throw error;

  const assignmentEmployeeIds = [...new Set((data || []).map(row => Number(row.employee_id)).filter(Number.isFinite))];

  const { data: snapshotEmployees, error: snapshotError } = await supabase
    .from('employees')
    .select('id')
    .eq('org_department_id', departmentId)
    .eq('is_archived', false)
    .eq('excluded_from_timesheet', false)
    .eq('employment_status', 'active');

  if (snapshotError) throw snapshotError;

  const snapshotEmployeeIds = (snapshotEmployees || []).map(row => Number(row.id)).filter(Number.isFinite);
  return [...new Set([...assignmentEmployeeIds, ...snapshotEmployeeIds])];
}

export async function isEmployeeAssignedToDepartmentOnDate(
  employeeId: number,
  departmentId: string,
  date: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('employee_assignments')
    .select('id, effective_from, effective_to')
    .eq('employee_id', employeeId)
    .eq('org_department_id', departmentId)
    .lte('effective_from', date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const { data: employee, error: employeeError } = await supabase
      .from('employees')
      .select('org_department_id')
      .eq('id', employeeId)
      .maybeSingle();

    if (employeeError) throw employeeError;
    return String(employee?.org_department_id || '') === departmentId;
  }

  return isAssignmentActiveOnDateInclusive(
    data.effective_from as string | null | undefined,
    data.effective_to as string | null | undefined,
    date,
  );
}

export async function getEmployeeAssignments(employeeId: number): Promise<IEmployeeDepartmentAssignment[]> {
  const { data, error } = await supabase
    .from('employee_assignments')
    .select('id, employee_id, org_department_id, position_id, effective_from, effective_to')
    .eq('employee_id', employeeId)
    .order('effective_from', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (data || []).map(row => ({
    id: String(row.id),
    employee_id: Number(row.employee_id),
    org_department_id: (row.org_department_id as string | null) ?? null,
    position_id: (row.position_id as string | null) ?? null,
    effective_from: String(row.effective_from),
    effective_to: (row.effective_to as string | null) ?? null,
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
