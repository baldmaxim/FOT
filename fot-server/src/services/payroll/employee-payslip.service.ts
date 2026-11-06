/**
 * Расчётный лист в личном кабинете (миграция 353, правила — employee-payslip.rules.ts). Только чтение: ни расчёт бригад,
 * ни что-либо ещё здесь не фиксируется.
 *
 * Месяц виден, только если он отмечен в employee_payslip_months (после загрузки и сверки) и у сотрудника есть данные:
 *  - '1c' — строки «Оплачено» месяца; дни — по закрытой основе табеля, иначе по живому табелю;
 *  - 'fot' — закрытая основа месяца; суммы — расчёт ФОТ без фиксации бригад (fixBrigades: false). Неполный расчёт —
 *    not_ready («Расчёт за месяц ещё не готов»).
 * Источник выбирает отметка месяца; в ответе его нет.
 */
import { query, queryOne } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { fetchTimesheetDataForEmployees } from '../timesheet-export.service.js';
import { getPayoutForEmployees } from './payroll-calc.service.js';
import { loadEmployeePeriods, type IPayrollPeriod } from './payroll-employee-period.service.js';
import { assembleMonthBasis, loadMonthBasisSources } from './payroll-month-basis.service.js';
import { getPaidAmounts } from './payroll-paid.service.js';
import { listEmployeePayouts1c } from './payroll-1c-payouts.service.js';
import { splitWorkedDays } from './payroll-payslip.service.js';
import type { IPayslipWorkedDays } from './payroll-payslip.rules.js';
import { getVacationBalance } from './payroll-vacation.service.js';
import {
  buildPayslipFrom1c,
  buildPayslipFromFot,
  isFotCalcComplete,
  type EmployeePayslip,
  type IEmployeePayslipHeader,
} from './employee-payslip.rules.js';

export type EmployeePayslipSource = '1c' | 'fot';

interface IMarkedMonth {
  month: string;
  source: EmployeePayslipSource;
}

const loadMarkedMonths = async (): Promise<IMarkedMonth[]> => query<IMarkedMonth>(
  `SELECT to_char(month, 'YYYY-MM') AS month, source FROM employee_payslip_months ORDER BY month DESC`,
);

/** Закрыт ли табель сотрудника за месяц целиком (основа закрытых подач покрывает его период). */
const loadClosedBasis = async (
  employeeId: number,
  month: string,
  period: IPayrollPeriod,
): Promise<IPayslipWorkedDays | null> => {
  const sources = await loadMonthBasisSources([employeeId], month);
  const basis = assembleMonthBasis(sources.get(employeeId) ?? [], period);
  return basis.state === 'closed'
    ? { workday: basis.workdayDates.length, dayoff: basis.dayoffDates.length }
    : null;
};

/** Месяцы листка сотрудника, новые первыми: отмеченные, по которым у него есть данные. */
export const listEmployeePayslipMonths = async (employeeId: number): Promise<string[]> => {
  const marked = await loadMarkedMonths();
  if (marked.length === 0) return [];
  const paidMonths = new Set((await query<{ month: string }>(
    `SELECT DISTINCT to_char(month, 'YYYY-MM') AS month
       FROM payroll_paid_amounts
      WHERE employee_id = $1 AND month = ANY($2::date[])`,
    [employeeId, marked.filter(item => item.source === '1c').map(item => `${item.month}-01`)],
  )).map(row => row.month));

  const result: string[] = [];
  for (const { month, source } of marked) {
    if (source === '1c') {
      if (paidMonths.has(month)) result.push(month);
      continue;
    }
    const period = (await loadEmployeePeriods([employeeId], month)).periods.get(employeeId);
    if (period && await loadClosedBasis(employeeId, month, period)) result.push(month);
  }
  return result;
};

/** Отработанные дни месяца: закрытая основа табеля, иначе живой табель (уволенный в месяце — тоже, snapshot). */
const loadWorkedDays = async (
  employeeId: number,
  month: string,
  period: IPayrollPeriod | null,
): Promise<IPayslipWorkedDays | null> => {
  if (!period) return null;
  const closed = await loadClosedBasis(employeeId, month, period);
  if (closed) return closed;
  const data = await fetchTimesheetDataForEmployees(
    month, [employeeId], 'Payroll', 'FULL', 'actual', true, { rosterMode: 'snapshot' },
  );
  return splitWorkedDays(data, employeeId);
};

const loadEmployeeName = async (
  employeeId: number,
): Promise<{ full_name: string; position_name: string | null } | null> => queryOne(
  `SELECT e.full_name, p.name AS position_name
     FROM employees e
     LEFT JOIN positions p ON p.id = e.position_id
    WHERE e.id = $1`,
  [employeeId],
);

/**
 * Листок сотрудника за месяц YYYY-MM. null — месяца нет в его списке (не отмечен или данных нет).
 * req — только для сигнатуры расчёта ФОТ: с fixBrigades: false он ничего не пишет.
 */
export const getEmployeePayslip = async (
  employeeId: number,
  month: string,
  req: AuthenticatedRequest,
): Promise<EmployeePayslip | null> => {
  const [marked, employee] = await Promise.all([
    queryOne<{ source: EmployeePayslipSource }>(
      `SELECT source FROM employee_payslip_months WHERE month = ($1 || '-01')::date`,
      [month],
    ),
    loadEmployeeName(employeeId),
  ]);
  if (!marked || !employee) return null;
  const period = (await loadEmployeePeriods([employeeId], month)).periods.get(employeeId) ?? null;

  if (marked.source === '1c') {
    const [paid, payouts, workedDays] = await Promise.all([
      getPaidAmounts(employeeId, month, month),
      listEmployeePayouts1c(employeeId, month, month),
      loadWorkedDays(employeeId, month, period),
    ]);
    if (paid.length === 0) return null;
    const header: IEmployeePayslipHeader = { month, ...employee, period, worked_days: workedDays };
    return buildPayslipFrom1c(header, paid, payouts);
  }

  if (!period || !(await loadClosedBasis(employeeId, month, period))) return null;
  const [calcs, payouts] = await Promise.all([
    getPayoutForEmployees([employeeId], month, req, undefined, { fixBrigades: false }),
    listEmployeePayouts1c(employeeId, month, month),
  ]);
  const calc = calcs.get(employeeId);
  if (!calc || calc.state !== 'closed' || !isFotCalcComplete(calc)) return { state: 'not_ready', month };
  const header: IEmployeePayslipHeader = {
    month,
    ...employee,
    period: { from: calc.period_from, to: calc.period_to },
    worked_days: calc.worked_days,
  };
  return buildPayslipFromFot(header, calc, payouts);
};

export interface IEmployeeVacationLeft {
  /** Остаток в днях, NUMERIC-строка до сотых. */
  days: string;
  /** По какой день посчитан: сегодня или день увольнения. */
  until: string;
}

/** Остаток отпуска на сегодня — тот же счёт, что в карточке «Отпуска» у кадров; нет остатка 1С — null. */
export const getEmployeeVacationLeft = async (
  employeeId: number,
  today: string,
): Promise<IEmployeeVacationLeft | null> => {
  const balance = await getVacationBalance(employeeId, today);
  return balance ? { days: balance.current_days, until: balance.until } : null;
};
