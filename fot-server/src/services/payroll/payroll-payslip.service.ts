/**
 * Расчётный листок в «Истории выплат» карточки «Зарплаты»: за месяц — период, отработанные дни
 * по табелю ФОТ и условия оплаты. Суммы статей 1С — из «Оплачено» (payroll-paid.service), здесь их нет.
 *
 * Месяц с закрытым табелем — дни, проезд и проживание из основы расчёта закрытых подач и «К выплате (ФОТ)»
 * (calc, payroll-calc.service): те же числа, что во вкладке «Табель → Зарплата». Незакрытый месяц — дни из живого
 * табеля, как раньше, calc — «Табель не закрыт».
 *
 * Дни — те же, что в колонке «Дни» единого файла 1С (buildEmployeeRowsForOneC): округление часов,
 * УУ/РБ/УД, отсечка увольнения, будущие дни не считаются. Рабочий — день по графику или плановая
 * суббота/воскресенье в квоте графика (как в ЗУП: «5+2» с двумя субботами — у Абдухалимова в июле 2026
 * 22 будних + 2 субботы = 24 отработанных рабочих); выходной — согласованный выход сверх графика.
 *
 * «По ставкам ФОТ» — суммы за месяц по ставкам «Справочника» (миграция 324), правила — payroll-payslip.rules.ts.
 */
import { queryOne } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { isWorkingDay } from '../schedule.service.js';
import { buildEmployeeRowsForOneC } from '../timesheet-excel.service.js';
import { fetchTimesheetDataForEmployees, type IDepartmentTimesheetData } from '../timesheet-export.service.js';
import { countMonthNormDays } from './payroll-basis.service.js';
import {
  getPayoutForEmployees,
  type IPayrollCalcClosed,
  type IPayrollCalcNotClosed,
  type PayrollCalc,
} from './payroll-calc.service.js';
import { attributeMonths, loadMonthBreakdown, monthPairKey } from './payroll-month-attribution.service.js';
import {
  lastDayOfMonth,
  payslipPeriod,
  pickPayslipRateAllowances,
  type IPayslipRateAllowance,
  type IPayslipTravelDays,
  type IPayslipWorkedDays,
} from './payroll-payslip.rules.js';
import { loadRateFacts } from './payroll-rate-facts.service.js';
import { resolveMonthStaffCategories } from './payroll-staff-category.js';
import { getTermsForPeriod, type IPayrollTerms, type PayrollCalcType, type StaffCategory } from './payroll-terms.service.js';

export {
  payslipPeriod,
  pickPayslipRateAllowances,
  proratedTravel,
  type IPayslipHousingRecord,
  type IPayslipRateAllowance,
  type IPayslipRateFacts,
  type IPayslipTravelDays,
  type IPayslipWorkedDays,
  type PayslipRateAllowanceCode,
} from './payroll-payslip.rules.js';

export interface IPayslipTerms {
  effective_from: string;
  /** null — действует дальше месяца. */
  effective_to: string | null;
  calc_type: PayrollCalcType;
  /** Оклад ₽/мес или ставка ₽/час — текстом NUMERIC; null — сумма не задана. */
  amount: string | null;
}

/** «К выплате (ФОТ)» в листке: расчёт без служебного (условия уже в terms листка). */
export type PayslipCalc = Omit<IPayrollCalcClosed, 'terms' | 'rate_allowances'> | IPayrollCalcNotClosed;

export interface IPayrollPayslipInfo {
  month: string;
  /** Период листка: месяц, начало — с даты приёма, конец — по дату увольнения; null — сотрудник в месяце не работал. */
  period_from: string | null;
  period_to: string | null;
  /** null — сотрудника нет в табеле месяца. */
  worked_days: IPayslipWorkedDays | null;
  /** Условия оплаты, действовавшие в периоде, по возрастанию даты начала. */
  terms: IPayslipTerms[];
  /** «По ставкам ФОТ» за месяц; в «Всего начислено» (ЗУП) не входят. */
  rate_allowances: IPayslipRateAllowance[];
  /** «К выплате (ФОТ)» по закрытому табелю; незакрытый месяц — state: 'not_closed'. */
  calc: PayslipCalc;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

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

/** Норма дней месяца для проезда (countMonthNormDays); нет ни графика, ни календаря — 0. */
export const countPayslipNormDays = (data: IDepartmentTimesheetData, employeeId: number): number => (
  countMonthNormDays(data.dailySchedulesMap.get(employeeId), `${data.year}-${pad2(data.mon)}`, data.calendarMonth) ?? 0
);

/** Категория месяца — как в «Своде»: объект и отдел месяца, режим табелирования месяца. */
const resolvePayslipCategory = async (
  employeeId: number,
  month: string,
  employee: { org_department_id: string | null; employment_status: string | null } | null,
): Promise<StaffCategory> => {
  const pair = { employeeId, month };
  const breakdown = await loadMonthBreakdown([`${month}-01`], [employeeId]);
  const attribution = (await attributeMonths(
    [pair],
    breakdown,
    new Map([[employeeId, employee ?? { org_department_id: null, employment_status: null }]]),
  )).get(monthPairKey(employeeId, month));
  const [category] = await resolveMonthStaffCategories([{
    employeeId,
    monthStart: `${month}-01`,
    officeObject: attribution?.object.key === 'office',
    departmentId: attribution?.departmentId ?? null,
    mode: attribution?.mode,
  }]);
  return category ?? 'office';
};

const toPayslipTerms = (rows: readonly IPayrollTerms[]): IPayslipTerms[] => rows.map(row => {
  const amount = row.calc_type === 'hourly' ? row.hourly_rate : row.monthly_salary;
  return {
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    calc_type: row.calc_type,
    // NUMERIC приходит строкой — оставляем текстом, как остальные суммы «Зарплаты».
    amount: amount === null ? null : String(amount),
  };
});

/** Листок месяца с закрытым табелем: всё — из основы расчёта, живой табель не собирается. */
const closedPayslip = (month: string, calc: IPayrollCalcClosed): IPayrollPayslipInfo => {
  const { terms, rate_allowances: rateAllowances, ...publicCalc } = calc;
  return {
    month,
    period_from: calc.period_from,
    period_to: calc.period_to,
    worked_days: calc.worked_days,
    terms: toPayslipTerms(terms),
    rate_allowances: rateAllowances,
    calc: publicCalc,
  };
};

/** Листок сотрудника за месяц YYYY-MM; req — автор фиксации расчёта бригады, если месяц закрыт впервые. */
export const getPayslipInfo = async (
  employeeId: number,
  month: string,
  req: AuthenticatedRequest,
): Promise<IPayrollPayslipInfo> => {
  const calc: PayrollCalc = (await getPayoutForEmployees([employeeId], month, req)).get(employeeId)
    ?? { state: 'not_closed', reason: 'no_period' };
  if (calc.state === 'closed') return closedPayslip(month, calc);

  // snapshot — сотрудник берётся при любом статусе: уволенный в месяце увольнения тоже со своими днями
  // (обычный состав 1С его не берёт). Дни после увольнения режет cutoff.
  const [data, employee] = await Promise.all([
    fetchTimesheetDataForEmployees(month, [employeeId], 'Payroll', 'FULL', 'actual', true, { rosterMode: 'snapshot' }),
    queryOne<{ hire_date: string | null; org_department_id: string | null; employment_status: string | null }>(
      'SELECT hire_date, org_department_id::text AS org_department_id, employment_status FROM employees WHERE id = $1',
      [employeeId],
    ),
  ]);
  const period = payslipPeriod(month, employee?.hire_date ?? null, data.cutoffByEmployeeId?.get(employeeId) ?? null);
  if (!period) {
    return { month, period_from: null, period_to: null, worked_days: null, terms: [], rate_allowances: [], calc };
  }

  const [termsByEmployee, category, rateFacts] = await Promise.all([
    getTermsForPeriod([employeeId], period.from, period.to),
    // Категория — по табелю месяца; staff_category условий — снимок и её не решает.
    resolvePayslipCategory(employeeId, month, employee),
    loadRateFacts([{ employeeId, period }], month, lastDayOfMonth(month)),
  ]);

  const workedDays = splitWorkedDays(data, employeeId);
  // Выходы в выходные проезд считают, как ЗУП: 22 рабочих + 8 выходных при норме 23 — полная ставка.
  const travelDays: IPayslipTravelDays | null = workedDays
    ? { worked: workedDays.workday + workedDays.dayoff, norm: countPayslipNormDays(data, employeeId) }
    : null;
  const facts = rateFacts.get(employeeId);

  return {
    month,
    period_from: period.from,
    period_to: period.to,
    worked_days: workedDays,
    terms: toPayslipTerms(termsByEmployee.get(employeeId) ?? []),
    rate_allowances: facts ? pickPayslipRateAllowances({ ...facts, category, travelDays }) : [],
    calc,
  };
};
