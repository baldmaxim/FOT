/**
 * Период сотрудника в месяце для расчёта и листка: с даты приёма (если внутри месяца) по отсечку увольнения — та же
 * формула, что у табеля (день увольнения включительно — рабочий). Общий для расчёта ФОТ (payroll-calc.service) и
 * расчётного листа в личном кабинете (employee-payslip.service).
 */
import { query } from '../../config/postgres.js';
import { buildFiredCutoffMap } from '../timesheet-fired-cutoff.service.js';
import { payslipPeriod } from './payroll-payslip.rules.js';

export interface IPayrollEmployeeRow {
  id: number;
  hire_date: string | null;
  org_department_id: string | null;
  employment_status: string | null;
  dismissal_date: string | null;
  excluded_from_timesheet_date: string | null;
}

export interface IPayrollPeriod {
  from: string;
  to: string;
}

/** Сотрудники и их период в месяце: с приёма по отсечку увольнения; не работал в месяце — периода нет. */
export const loadEmployeePeriods = async (
  employeeIds: readonly number[],
  month: string,
): Promise<{ employees: Map<number, IPayrollEmployeeRow>; periods: Map<number, IPayrollPeriod> }> => {
  const employeeRows = await query<IPayrollEmployeeRow>(
    `SELECT id, to_char(hire_date, 'YYYY-MM-DD') AS hire_date, org_department_id::text AS org_department_id,
            employment_status, to_char(dismissal_date, 'YYYY-MM-DD') AS dismissal_date,
            to_char(excluded_from_timesheet_date, 'YYYY-MM-DD') AS excluded_from_timesheet_date
       FROM employees WHERE id = ANY($1::int[])`,
    [[...employeeIds]],
  );
  const employees = new Map((employeeRows ?? []).map(row => [Number(row.id), row]));
  const cutoffs = buildFiredCutoffMap([...employees.values()].map(row => ({ ...row })), `${month}-01`);
  const periods = new Map<number, IPayrollPeriod>();
  for (const employee of employees.values()) {
    const period = payslipPeriod(month, employee.hire_date, cutoffs.get(employee.id) ?? null);
    if (period) periods.set(employee.id, period);
  }
  return { employees, periods };
};
