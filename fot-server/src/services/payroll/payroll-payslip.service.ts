/**
 * Расчётный листок в «Истории выплат» карточки «Зарплаты»: за месяц — период, отработанные дни
 * по табелю ФОТ и условия оплаты. Суммы статей — из «Оплачено» (payroll-paid.service), здесь их нет.
 *
 * Дни — те же, что в колонке «Дни» единого файла 1С (buildEmployeeRowsForOneC): округление часов,
 * УУ/РБ/УД, отсечка увольнения, будущие дни не считаются. Рабочий — день по графику или плановая
 * суббота/воскресенье в квоте графика (как в ЗУП: «5+2» с двумя субботами даёт 24 рабочих в июле 2026);
 * выходной — согласованный выход сверх графика.
 */
import { queryOne } from '../../config/postgres.js';
import { isWorkingDay } from '../schedule.service.js';
import { buildEmployeeRowsForOneC } from '../timesheet-excel.service.js';
import { fetchTimesheetDataForEmployees, type IDepartmentTimesheetData } from '../timesheet-export.service.js';
import { getTermsForPeriod, type PayrollCalcType } from './payroll-terms.service.js';

export interface IPayslipWorkedDays {
  /** Отработано в рабочие дни графика (с плановыми выходными). */
  workday: number;
  /** Отработано в выходные сверх графика. */
  dayoff: number;
}

export interface IPayslipTerms {
  effective_from: string;
  /** null — действует дальше месяца. */
  effective_to: string | null;
  calc_type: PayrollCalcType;
  /** Оклад ₽/мес или ставка ₽/час — текстом NUMERIC; null — сумма не задана. */
  amount: string | null;
}

export interface IPayrollPayslipInfo {
  month: string;
  /** Период листка: месяц, начало — с даты приёма, конец — по дату увольнения; null — сотрудник в месяце не работал. */
  period_from: string | null;
  period_to: string | null;
  /** null — сотрудника нет в табеле месяца. */
  worked_days: IPayslipWorkedDays | null;
  /** Условия оплаты, действовавшие в периоде, по возрастанию даты начала. */
  terms: IPayslipTerms[];
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

const previousIsoDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

/** Отработанные дни сотрудника из собранного табеля: рабочие по графику и выходные. null — его нет в табеле. */
export const splitWorkedDays = (
  data: IDepartmentTimesheetData,
  employeeId: number,
): IPayslipWorkedDays | null => {
  const row = buildEmployeeRowsForOneC(data).find(candidate => candidate.employeeId === employeeId);
  if (!row) return null;
  const schedules = data.dailySchedulesMap.get(employeeId);
  let workday = 0;
  let dayoff = 0;
  for (const day of row.workedDayNumbers) {
    const date = `${data.year}-${pad2(data.mon)}-${pad2(day)}`;
    const schedule = schedules?.get(date);
    // Без графика выгрузка считает день рабочим (includeExportDayHours) — так же и здесь.
    const scheduled = !schedule
      || isWorkingDay(schedule, new Date(data.year, data.mon - 1, day), data.calendarMonth)
      || data.plannedWeekendDays?.has(`${employeeId}|${date}`) === true;
    if (scheduled) workday++;
    else dayoff++;
  }
  return { workday, dayoff };
};

/** Период листка: месяц, обрезанный датой приёма и отсечкой увольнения табеля (cutoff — первый день без работы). */
export const payslipPeriod = (
  month: string,
  hireDate: string | null,
  cutoff: string | null,
): { from: string; to: string } | null => {
  const [year, mon] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${pad2(new Date(year, mon, 0).getDate())}`;
  const from = hireDate && hireDate > monthStart && hireDate <= monthEnd ? hireDate : monthStart;
  const to = cutoff && cutoff <= monthEnd ? previousIsoDay(cutoff) : monthEnd;
  return from <= to ? { from, to } : null;
};

/** Листок сотрудника за месяц YYYY-MM. */
export const getPayslipInfo = async (employeeId: number, month: string): Promise<IPayrollPayslipInfo> => {
  // snapshot — сотрудник берётся при любом статусе: уволенный в месяце увольнения тоже со своими днями
  // (обычный состав 1С его не берёт). Дни после увольнения режет cutoff.
  const [data, employee] = await Promise.all([
    fetchTimesheetDataForEmployees(month, [employeeId], 'Payroll', 'FULL', 'actual', true, { rosterMode: 'snapshot' }),
    queryOne<{ hire_date: string | null }>('SELECT hire_date FROM employees WHERE id = $1', [employeeId]),
  ]);
  const period = payslipPeriod(month, employee?.hire_date ?? null, data.cutoffByEmployeeId?.get(employeeId) ?? null);
  if (!period) return { month, period_from: null, period_to: null, worked_days: null, terms: [] };

  const termsByEmployee = await getTermsForPeriod([employeeId], period.from, period.to);
  const terms = (termsByEmployee.get(employeeId) ?? []).map(row => {
    const amount = row.calc_type === 'hourly' ? row.hourly_rate : row.monthly_salary;
    return {
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      calc_type: row.calc_type,
      // NUMERIC приходит строкой — оставляем текстом, как остальные суммы «Зарплаты».
      amount: amount === null ? null : String(amount),
    };
  });

  return {
    month,
    period_from: period.from,
    period_to: period.to,
    worked_days: splitWorkedDays(data, employeeId),
    terms,
  };
};
