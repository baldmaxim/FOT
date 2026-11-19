/**
 * «Проживание» → «Компенсация аренды» (кадры, миграция 371) — как документ 1С «Список сотрудников для получения
 * возмещения за проживание»: компенсации месяца (вид apartment, 630 ₽/день) с днями и суммой из того же расчёта ФОТ,
 * что «Расчёты» и «Доплата за месяц» «Зарплаты» (getPreliminaryPayoutForEmployees → apartmentAllowance), — правила
 * здесь не повторяются.
 *
 * Отличие от «Доплаты за месяц» (listHousingMonthAmounts — её поведение не меняется): охват — кадровый (список
 * «Управления кадрами», вместе с уволенными, чьё проживание задевает месяц), а не «штат зарплаты»; кроме суммы —
 * «Кол-во дней (табель)» (отработанные за время проживания) и «Кол-во выходных» (выходные месяца до потолка, как 1С).
 * Строка — сотрудник месяца (последнее его проживание, lastStaysOfMonth). Сумма — из расчёта; месяц не посчитан
 * (будущий, 1-е число текущего, табель или бригада не готовы) — null.
 * Ничего не пишет (fixBrigades: false): вкладку открывают кадры и комендант без прав «Зарплаты» — закрытая бригада
 * без зафиксированных долей считается предварительно, как в «Расчётах» до фиксации; сумма квартиры от долей не зависит.
 */
import type { AuthenticatedRequest } from '../types/index.js';
import { lastDayOfMonth } from './payroll/payroll-payslip.rules.js';
import { resolvePreliminaryAsOf } from './payroll/brigade-salary.service.js';
import { getPreliminaryPayoutForEmployees, type PayrollCalcWithPreliminary } from './payroll/payroll-calc.service.js';
import { lastStaysOfMonth } from './payroll/payroll-housing-month.service.js';
import { listStaysOfClass, type IDormitoryStay } from './dormitory-stays.service.js';

/** Порция расчёта — как у «Расчётов» и «Доплаты за месяц» (≤ 500 id). */
const CALC_CHUNK_SIZE = 500;

export interface ICompensationMonthRow extends IDormitoryStay {
  /** YYYY-MM. */
  month: string;
  /** Сумма к оплате за месяц, numeric строкой; '0.00' — не работал во время проживания; null — не посчитан. */
  month_amount: string | null;
  /** Отработано по табелю за время проживания; null — не посчитан. */
  worked_days: number | null;
  /** Выходные месяца (до потолка, как 1С); null — не посчитан. */
  weekend_days: number | null;
}

/** Дни и сумма квартиры из расчёта месяца; не посчитан — все null. */
export const compensationFromCalc = (
  calc: PayrollCalcWithPreliminary | undefined,
): Pick<ICompensationMonthRow, 'month_amount' | 'worked_days' | 'weekend_days'> => {
  if (!calc || calc.state === 'not_closed') return { month_amount: null, worked_days: null, weekend_days: null };
  const housing = calc.rate_allowances.find(allowance => allowance.code === 'housing');
  if (!housing) return { month_amount: '0.00', worked_days: 0, weekend_days: 0 };
  const added = housing.housing_weekend_days ?? 0;
  return {
    month_amount: housing.amount,
    worked_days: (housing.housing_days ?? 0) - added,
    weekend_days: housing.housing_month_weekends ?? added,
  };
};

/** Компенсации месяца month (YYYY-MM) в кадровом охвате employeeIds (null — все) с днями и суммой. */
export const listCompensationMonth = async (
  employeeIds: number[] | null,
  month: string,
  req: AuthenticatedRequest,
): Promise<ICompensationMonthRow[]> => {
  const stays = await listStaysOfClass('compensation', employeeIds, { from: `${month}-01`, to: lastDayOfMonth(month) });
  const monthStays = lastStaysOfMonth(stays, month);
  if (monthStays.length === 0) return [];
  const calcs = new Map<number, PayrollCalcWithPreliminary>();
  if (resolvePreliminaryAsOf(month) !== null) {
    const ids = monthStays.map(stay => stay.employee_id);
    for (let start = 0; start < ids.length; start += CALC_CHUNK_SIZE) {
      const payouts = await getPreliminaryPayoutForEmployees(
        ids.slice(start, start + CALC_CHUNK_SIZE), month, req, undefined, { fixBrigades: false },
      );
      for (const [employeeId, calc] of payouts) calcs.set(employeeId, calc);
    }
  }
  return monthStays.map(stay => ({ ...stay, month, ...compensationFromCalc(calcs.get(stay.employee_id)) }));
};
