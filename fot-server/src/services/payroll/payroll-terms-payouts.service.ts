/**
 * «Условия оплаты» → «Выплачено» (решение пользователя 09.11.2026): суммы порции списка за 6 закрытых месяцев перед
 * датой выборки — месяц из 1С, иначе расчёт ФОТ, как «Свод» (payroll-terms-payouts.rules.ts). Состав месяца,
 * разовые, удержания и расчёт — те же функции, что у «Свода» (payroll-summary-calc.service.ts), только по id порции.
 * В БД ничего не пишет, кроме того, что делает сам расчёт («Расчёты» и «Свод» так же): чтение закрытой бригады
 * фиксирует её доли.
 */
import { performance } from 'node:perf_hooks';

import { query } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { sumCalcColumns } from './payroll-calc-columns.service.js';
import { monthPairKey } from './payroll-month-attribution.service.js';
import { calcSummaryMonths, loadSummaryExtras, loadSummaryRoster } from './payroll-summary-calc.service.js';
import { needsSummaryCalc, SUMMARY_PAYROLL_ITEM } from './payroll-summary-calc.rules.js';
import { centsToAmount } from './payroll-summary.attribution.js';
import { termsPayoutMonth } from './payroll-terms-payouts.rules.js';

/** Сколько закрытых месяцев перед месяцем даты — как SQL списка и payrollAccrualMonths на фронте. */
export const TERMS_PAYOUT_MONTHS = 6;

/** Месяцы «Выплачено» (YYYY-MM, по возрастанию): TERMS_PAYOUT_MONTHS перед месяцем даты YYYY-MM-DD. */
export const termsPayoutMonths = (date: string): string[] => {
  const year = Number(date.slice(0, 4));
  const monthIndex = Number(date.slice(5, 7)) - 1;
  return Array.from({ length: TERMS_PAYOUT_MONTHS }, (_, index) => {
    const shifted = new Date(Date.UTC(year, monthIndex - TERMS_PAYOUT_MONTHS + index, 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
  });
};

export interface ITermsPayout {
  month: string;
  /** NUMERIC текстом, может быть 0 или минусом. */
  amount: string;
}

export interface ITermsPayoutsTiming {
  /** Сколько пар «сотрудник × месяц» ушло в расчёт ФОТ. */
  calcEmployees: number;
  loadMs: number;
  calcMs: number;
  totalMs: number;
}

export const emptyTermsPayoutsTiming = (): ITermsPayoutsTiming => ({ calcEmployees: 0, loadMs: 0, calcMs: 0, totalMs: 0 });

export const termsPayoutsServerTiming = (timing: ITermsPayoutsTiming): string => [
  `payouts_load;dur=${timing.loadMs.toFixed(1)}`,
  `payouts_calc;dur=${timing.calcMs.toFixed(1)};desc="${timing.calcEmployees}"`,
  `payouts_total;dur=${timing.totalMs.toFixed(1)}`,
].join(', ');

/** Дольше — строка в лог: по ней видно, укладывается ли порция. */
const TERMS_PAYOUTS_LOG_THRESHOLD_MS = 2000;

/** Статьи 1С сотрудников за месяцы: пара «сотрудник|YYYY-MM» → статья → сумма. */
const loadPaid = async (
  employeeIds: readonly number[],
  monthStarts: readonly string[],
): Promise<Map<string, Map<string, string>>> => {
  const rows = await query<{ employee_id: number; month: string; item: string; amount: string }>(
    `SELECT p.employee_id, to_char(p.month, 'YYYY-MM') AS month, p.item_code AS item, p.amount::text AS amount
       FROM payroll_paid_amounts p
      WHERE p.employee_id = ANY($1::int[])
        AND p.month = ANY($2::date[])`,
    [[...employeeIds], [...monthStarts]],
  );
  const result = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const key = monthPairKey(Number(row.employee_id), row.month);
    const items = result.get(key);
    if (items) items.set(row.item, row.amount);
    else result.set(key, new Map([[row.item, row.amount]]));
  }
  return result;
};

/**
 * Месяцы, где «Зарплата» 1С загружена хоть у кого-то, — по всем сотрудникам, как в «Своде»: в таком месяце расчёт идёт
 * только людям с условиями и бригадам без ведомости (selectCalcInLoadedMonth).
 */
const loadPayrollLoadedMonths = async (monthStarts: readonly string[]): Promise<Set<string>> => {
  const rows = await query<{ month: string }>(
    `SELECT DISTINCT to_char(p.month, 'YYYY-MM') AS month
       FROM payroll_paid_amounts p
      WHERE p.month = ANY($1::date[]) AND p.item_code = $2`,
    [[...monthStarts], SUMMARY_PAYROLL_ITEM],
  );
  return new Set(rows.map(row => row.month));
};

/**
 * «Выплачено» сотрудников за месяцы termsPayoutMonths(date): id → суммы по месяцам (месяцы без суммы не входят).
 * employeeIds — уже в охвате пользователя и без подрядчиков (loadAllowedCalcEmployeeIds); contractorRootId — тот же,
 * что у «Свода», для состава месяца.
 */
export const getTermsPayouts = async (input: {
  employeeIds: readonly number[];
  date: string;
  contractorRootId: string | null;
  req: AuthenticatedRequest;
  timing?: ITermsPayoutsTiming;
}): Promise<{ months: string[]; payouts: Map<number, ITermsPayout[]> }> => {
  const timing = input.timing ?? emptyTermsPayoutsTiming();
  const started = performance.now();
  const months = termsPayoutMonths(input.date);
  const payouts = new Map<number, ITermsPayout[]>();
  const ids = [...new Set(input.employeeIds)];
  if (ids.length === 0) return { months, payouts };
  const monthStarts = months.map(month => `${month}-01`);

  const [paid, loadedMonths, roster, extras] = await Promise.all([
    loadPaid(ids, monthStarts),
    loadPayrollLoadedMonths(monthStarts),
    loadSummaryRoster(months, input.contractorRootId, ids),
    loadSummaryExtras(months, ids),
  ]);
  const loadedAt = performance.now();
  timing.loadMs += loadedAt - started;

  // Расчёт — только работавшим в месяце, у кого месяц не из 1С (нет «Зарплаты» и ГПХ).
  const candidates = new Map<string, number[]>();
  for (const month of months) {
    const worked = (roster.get(month) ?? []).filter(id => needsSummaryCalc(paid.get(monthPairKey(id, month))));
    if (worked.length > 0) candidates.set(month, worked);
  }
  const { calcs, employees } = await calcSummaryMonths(candidates, loadedMonths, input.req);
  timing.calcEmployees += employees;
  timing.calcMs += performance.now() - loadedAt;

  for (const id of ids) {
    const list: ITermsPayout[] = [];
    for (const month of months) {
      const key = monthPairKey(id, month);
      const calc = calcs.get(key);
      const cents = termsPayoutMonth({
        paid: paid.get(key) ?? new Map(),
        calc,
        fotKnown: calc !== undefined && sumCalcColumns([[month, calc]]).net !== null,
        oneTime: extras.oneTime.get(key) ?? [],
        deductions: extras.deductions.get(key) ?? [],
      });
      if (cents !== null) list.push({ month, amount: centsToAmount(cents) });
    }
    payouts.set(id, list);
  }

  timing.totalMs += performance.now() - started;
  if (timing.totalMs > TERMS_PAYOUTS_LOG_THRESHOLD_MS) {
    console.log(`[payroll-terms-payouts] ${ids.length} чел., ${months.join(',')}: ${termsPayoutsServerTiming(timing)}`);
  }
  return { months, payouts };
};
