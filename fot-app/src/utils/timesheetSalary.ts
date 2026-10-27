import type { TimesheetEmployee } from '../types';
import type { ITimesheetSalaryResponse, ITimesheetSalaryRow } from '../types/timesheet';
import { formatPaidAmount } from './payrollPaid';

/** Строка вкладки «Зарплата» у сотрудника, если он в составе (начальник участка, «Руководитель» — нет). */
export const findSalaryRow = (
  data: ITimesheetSalaryResponse | undefined,
  employee: TimesheetEmployee,
): ITimesheetSalaryRow | null => {
  if (!data) return null;
  const source = employee.source ?? 'department';
  if (source !== 'department') return null;
  return data.rows.find(row => row.employee_id === employee.id) ?? null;
};

/** «141 818,18»; суммы нет — «—». */
export const formatSalaryAmount = (amount: string | null): string => (
  amount === null ? '—' : formatPaidAmount(Number(amount))
);

/** '1.5' → '1,5'. */
export const formatKtu = (value: string): string => value.replace('.', ',');
