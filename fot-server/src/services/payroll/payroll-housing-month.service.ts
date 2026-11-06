/**
 * «Справочник → Доплата» → вкладка «Доплата за месяц»: у квартиры — сумма за месяц, а не ставка за день.
 *
 * Сумма — та же, что у квартиры в строке «Компенсация проживания» «Расчётов»: расчёт ФОТ
 * (getPreliminaryPayoutForEmployees) — закрытый месяц по закрытому табелю, открытый — по живому на вчера МСК.
 * Ставка × дни — правила apartmentAllowance (payroll-payslip.rules.ts), здесь они не повторяются. В БД пишет только
 * то, что делает сам расчёт («Расчёты» так же): открытие месяца фиксирует доли бригады закрытого месяца.
 */
import type { AuthenticatedRequest } from '../../types/index.js';
import { resolvePreliminaryAsOf } from './brigade-salary.service.js';
import { CALC_COLUMNS_MAX_MONTHS } from './payroll-calc-columns.service.js';
import { getPreliminaryPayoutForEmployees, type PayrollCalcWithPreliminary } from './payroll-calc.service.js';
import { listHousingAllowances, type IHousingAllowanceRow } from './payroll-housing.service.js';
import { lastDayOfMonth } from './payroll-payslip.rules.js';

/** Порция расчёта — как у «Расчётов» и «Свода» (≤ 500 id). */
const CALC_CHUNK_SIZE = 500;

/** Квартира сотрудника в месяце с суммой за этот месяц. */
export interface IHousingMonthRow extends IHousingAllowanceRow {
  /** YYYY-MM. */
  month: string;
  /**
   * Сумма квартиры за месяц, numeric строкой; '0.00' — посчитано, платить не за что (не работал во время проживания).
   * null — месяц не посчитан: будущий, сегодня 1-е число, табель или бригада не готовы, выбрано больше 12 месяцев.
   */
  month_amount: string | null;
}

/** Сумма квартиры из расчёта месяца: только квартира (code 'housing'), без доплаты за общежитие. */
export const apartmentMonthAmount = (calc: PayrollCalcWithPreliminary | undefined): string | null => {
  if (!calc || calc.state === 'not_closed') return null;
  return calc.rate_allowances.find(allowance => allowance.code === 'housing')?.amount ?? '0.00';
};

/** Проживание [въезд, выезд) задевает месяц: в день выезда уже не живёт. */
const stayTouchesMonth = (stay: IHousingAllowanceRow, month: string): boolean => (
  stay.check_in <= lastDayOfMonth(month) && (stay.check_out === null || stay.check_out > `${month}-01`)
);

/**
 * Квартиры месяца — одна строка на сотрудника: последнее проживание (въезд, затем id — наибольшие). Сумма месяца
 * у сотрудника одна на все его квартиры и ставки; ✎ и 🗑 строки — у последнего проживания.
 */
export const lastStaysOfMonth = (stays: readonly IHousingAllowanceRow[], month: string): IHousingAllowanceRow[] => {
  const byEmployee = new Map<number, IHousingAllowanceRow>();
  for (const stay of stays) {
    if (!stayTouchesMonth(stay, month)) continue;
    const current = byEmployee.get(stay.employee_id);
    if (!current || stay.check_in > current.check_in || (stay.check_in === current.check_in && stay.id > current.id)) {
      byEmployee.set(stay.employee_id, stay);
    }
  }
  return [...byEmployee.values()];
};

/**
 * Квартиры «штата зарплаты» по месяцам с суммой за месяц. Больше CALC_COLUMNS_MAX_MONTHS месяцев — расчёт не идёт
 * (как у столбцов «Расчётов»); будущий месяц и 1-е число текущего (resolvePreliminaryAsOf — null) — тоже: считать нечего.
 */
export const listHousingMonthAmounts = async (
  scope: { contractorRootId: string | null; departmentIds: string[] | null },
  months: readonly string[],
  req: AuthenticatedRequest,
): Promise<IHousingMonthRow[]> => {
  const sorted = [...new Set(months)].sort();
  if (sorted.length === 0) return [];
  const stays = await listHousingAllowances({ ...scope, period: { monthStarts: sorted.map(month => `${month}-01`) } });
  const canCalc = sorted.length <= CALC_COLUMNS_MAX_MONTHS;
  const result: IHousingMonthRow[] = [];
  // Месяцы по очереди: расчёт порции сам идёт пачкой запросов, параллельно он занял бы пул.
  for (const month of sorted) {
    const monthStays = lastStaysOfMonth(stays, month);
    if (monthStays.length === 0) continue;
    const calcs = new Map<number, PayrollCalcWithPreliminary>();
    if (canCalc && resolvePreliminaryAsOf(month) !== null) {
      const ids = monthStays.map(stay => stay.employee_id);
      for (let start = 0; start < ids.length; start += CALC_CHUNK_SIZE) {
        const payouts = await getPreliminaryPayoutForEmployees(ids.slice(start, start + CALC_CHUNK_SIZE), month, req);
        for (const [employeeId, calc] of payouts) calcs.set(employeeId, calc);
      }
    }
    for (const stay of monthStays) {
      result.push({ ...stay, month, month_amount: apartmentMonthAmount(calcs.get(stay.employee_id)) });
    }
  }
  return result;
};
