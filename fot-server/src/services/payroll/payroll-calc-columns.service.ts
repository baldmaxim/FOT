/**
 * Столбцы «Зарплата → Расчёты» (решение пользователя 27.10.2026): состав зарплаты строки за выбранные месяцы.
 *
 * Расчёт ФОТ по закрытому табелю (getPayoutForEmployees) — «Начислено по табелю» (оклад по дням или доля бригады),
 * переработка, проезд, проживание, доплаты (плановая + разовая), удержания «Справочника» и «Сумма» — к выплате
 * (начислено − удержано, то же число, что «Сумма» во вкладке «Табель → Зарплата»). Несколько месяцев — сумма
 * по месяцам. Неизвестная сумма в ноль не превращается: незакрытый месяц — open_months, закрытый с неполным
 * расчётом (почасовая ставка, нет условий или нормы, выработка бригады не введена) — incomplete. «Оклад» не
 * суммируется: ставка условий на последний день последнего месяца.
 *
 * Из 1С (там, где ФОТ сумму не считает) — отпускные, больничные и перерасчёт (статьи «Оплачено», SQL списка) и
 * «Выплаты на карту» — ведомости в банк (миграция 328) по виду: аванс, ЗП, премия.
 */
import type { AuthenticatedRequest } from '../../types/index.js';
import { getPayoutForEmployees, type PayrollCalc } from './payroll-calc.service.js';
import type { PayrollCalcLineCode, PayrollCalcMissing } from './payroll-calc.rules.js';
import { lastDayOfMonth } from './payroll-payslip.rules.js';
import { centsToAmount, toCents } from './payroll-summary.attribution.js';
import { getTermsForPeriod, type IPayrollTerms } from './payroll-terms.service.js';

/** Больше месяцев — расчёт ФОТ не идёт (каждый месяц — отдельный расчёт порции), столбцы ФОТ пусты. */
export const CALC_COLUMNS_MAX_MONTHS = 12;

/**
 * Почему закрытый месяц посчитан не полностью. unknown_amount — строка без суммы без причины в missing (страховка
 * на будущее). Отпускные, больничные и учебный отпуск — не неполнота: их суммы — из 1С.
 */
export type CalcColumnsIssue = 'hourly' | 'no_terms' | 'no_norm' | 'brigade_output' | 'brigade_error' | 'unknown_amount';

const CALC_ISSUES: ReadonlySet<PayrollCalcMissing> = new Set<PayrollCalcMissing>([
  'hourly', 'no_terms', 'no_norm', 'brigade_output', 'brigade_error',
]);

const isCalcIssue = (code: PayrollCalcMissing): code is PayrollCalcMissing & CalcColumnsIssue => CALC_ISSUES.has(code);

export type HousingKind = 'apartment' | 'dormitory';

export interface ICalcRate {
  /** NUMERIC текстом: оклад ₽/мес или ставка ₽/ч. */
  amount: string;
  calc_type: 'salary' | 'hourly';
  /** YYYY-MM-DD — на какой день взята ставка. */
  as_of: string;
}

export interface ICalcColumns {
  rate: ICalcRate | null;
  /** Суммы ФОТ за закрытые месяцы, NUMERIC текстом; null — суммы нет ни в одном месяце. */
  timesheet: string | null;
  overtime: string | null;
  /** Из чего переработка: выходы в выходные сверх нормы (дни) и часы в будни по корректировкам. */
  overtime_days: number;
  overtime_hours: number;
  travel: string | null;
  housing: string | null;
  housing_kinds: HousingKind[];
  supplements: string | null;
  deductions: string | null;
  /** К выплате: начислено − удержано за закрытые месяцы, без НДФЛ; null — закрытых месяцев нет. */
  net: string | null;
  /** Месяцы с незакрытым табелем (YYYY-MM); месяц, где сотрудник не работал, сюда не входит. */
  open_months: string[];
  incomplete: Array<{ month: string; reasons: CalcColumnsIssue[] }>;
}

type CalcSumKey = 'timesheet' | 'overtime' | 'travel' | 'housing' | 'supplements';

const LINE_COLUMN: Record<PayrollCalcLineCode, CalcSumKey> = {
  contract: 'timesheet',
  brigade: 'timesheet',
  overtime: 'overtime',
  travel: 'travel',
  housing: 'housing',
  bonus: 'supplements',
  supplement: 'supplements',
};

const addCents = (sum: number | null, amount: string): number => (sum ?? 0) + toCents(amount);
const toAmount = (cents: number | null): string | null => (cents === null ? null : centsToAmount(cents));

/** Суммы ФОТ и полнота строки по месяцам (по возрастанию); undefined — сотрудника нет в расчёте месяца. */
export const sumCalcColumns = (
  byMonth: ReadonlyArray<readonly [string, PayrollCalc | undefined]>,
): Omit<ICalcColumns, 'rate'> => {
  const sums: Record<CalcSumKey | 'deductions' | 'net', number | null> = {
    timesheet: null, overtime: null, travel: null, housing: null, supplements: null, deductions: null, net: null,
  };
  let overtimeDays = 0;
  let overtimeHours = 0;
  const housingKinds = new Set<HousingKind>();
  const openMonths: string[] = [];
  const incomplete: ICalcColumns['incomplete'] = [];

  for (const [month, calc] of byMonth) {
    if (!calc) continue;
    if (calc.state === 'not_closed') {
      if (calc.reason !== 'no_period') openMonths.push(month);
      continue;
    }
    const reasons = new Set<CalcColumnsIssue>(calc.missing.filter(isCalcIssue));
    for (const line of calc.lines) {
      const key = LINE_COLUMN[line.code];
      if (line.code === 'overtime') {
        overtimeDays += line.days?.worked ?? 0;
        overtimeHours += line.hours ?? 0;
      }
      if (line.amount === null) {
        if (reasons.size === 0) reasons.add('unknown_amount');
        continue;
      }
      sums[key] = addCents(sums[key], line.amount);
    }
    for (const deduction of calc.deductions) sums.deductions = addCents(sums.deductions, deduction.amount);
    sums.net = addCents(sums.net, calc.net);
    for (const allowance of calc.rate_allowances) {
      if (allowance.code === 'housing') housingKinds.add('apartment');
      else if (allowance.code === 'dormitory_allowance') housingKinds.add('dormitory');
    }
    if (reasons.size > 0) incomplete.push({ month, reasons: [...reasons] });
  }

  return {
    timesheet: toAmount(sums.timesheet),
    overtime: toAmount(sums.overtime),
    overtime_days: overtimeDays,
    overtime_hours: Math.round(overtimeHours * 100) / 100,
    travel: toAmount(sums.travel),
    housing: toAmount(sums.housing),
    housing_kinds: [...housingKinds],
    supplements: toAmount(sums.supplements),
    deductions: toAmount(sums.deductions),
    net: toAmount(sums.net),
    open_months: openMonths,
    incomplete,
  };
};

/**
 * Оклад или ставка на день asOf: строка условий, действующая в этот день; такой нет (уволен раньше) — самая поздняя
 * из задевающих месяцы. Сумма не задана — null.
 */
export const pickRateAsOf = (terms: readonly IPayrollTerms[], asOf: string): ICalcRate | null => {
  const sorted = [...terms].sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  const active = sorted.filter(row => String(row.effective_from) <= asOf
    && (row.effective_to === null || String(row.effective_to) >= asOf));
  const row = active.at(-1) ?? sorted.at(-1);
  if (!row) return null;
  const amount = row.calc_type === 'hourly' ? row.hourly_rate : row.monthly_salary;
  // NUMERIC приходит строкой; String() — на случай числа из моков.
  return amount === null || amount === undefined ? null : { amount: String(amount), calc_type: row.calc_type, as_of: asOf };
};

/** Столбцы ФОТ строк порции за месяцы YYYY-MM; больше CALC_COLUMNS_MAX_MONTHS — пустая карта. */
export const getCalcColumns = async (
  employeeIds: readonly number[],
  months: readonly string[],
  req: AuthenticatedRequest,
): Promise<Map<number, ICalcColumns>> => {
  const result = new Map<number, ICalcColumns>();
  if (employeeIds.length === 0 || months.length === 0 || months.length > CALC_COLUMNS_MAX_MONTHS) return result;
  const sorted = [...new Set(months)].sort();
  // Месяцы — по очереди: расчёт порции сам идёт пачкой запросов, параллельно он занял бы пул.
  const calcs = new Map<string, Map<number, PayrollCalc>>();
  for (const month of sorted) calcs.set(month, await getPayoutForEmployees(employeeIds, month, req));
  const asOf = lastDayOfMonth(sorted[sorted.length - 1]);
  const terms = await getTermsForPeriod([...employeeIds], `${sorted[0]}-01`, asOf);
  for (const employeeId of employeeIds) {
    result.set(employeeId, {
      rate: pickRateAsOf(terms.get(employeeId) ?? [], asOf),
      ...sumCalcColumns(sorted.map(month => [month, calcs.get(month)?.get(employeeId)] as const)),
    });
  }
  return result;
};

/** «Выплаты на карту» строки: суммы ведомостей по виду, NUMERIC текстом; вида нет — null. */
export interface ICardPayouts {
  advance: string | null;
  salary: string | null;
  premium: string | null;
}

/**
 * Вид выплаты по «Способу выплаты» ведомости 1С (без учёта регистра и пробелов по краям): «Аванс» — аванс, «Премия»
 * и «Премии» — премия, всё остальное («Зарплата», «Увольнения», будущие неизвестные способы) — ЗП. Классификация в
 * коде, а не в SQL: lower() кириллицы в PostgreSQL зависит от локали базы.
 */
export const cardPayoutKind = (paymentMethod: string): keyof ICardPayouts => {
  const method = paymentMethod.trim().toLowerCase();
  if (method.includes('аванс')) return 'advance';
  if (method.includes('прем')) return 'premium';
  return 'salary';
};

/** Суммы по способам выплаты (SQL списка) → три вида; ведомостей нет — null. */
export const classifyCardPayouts = (
  rows: ReadonlyArray<{ method: string; amount: string }> | null | undefined,
): ICardPayouts | null => {
  if (!rows || rows.length === 0) return null;
  const cents: Record<keyof ICardPayouts, number | null> = { advance: null, salary: null, premium: null };
  for (const row of rows) {
    const kind = cardPayoutKind(row.method);
    cents[kind] = addCents(cents[kind], row.amount);
  }
  return { advance: toAmount(cents.advance), salary: toAmount(cents.salary), premium: toAmount(cents.premium) };
};

/**
 * LATERAL списка «Расчётов»: суммы ведомостей в банк сотрудника page.employee_id за месяцы (date[] первых чисел;
 * NULL — все) по способу выплаты. Только сопоставленные строки (у unmatched employee_id нет). Своя агрегация —
 * не соединяется со статьями «Оплачено», суммы не удваиваются.
 */
export const cardPayoutsJoinSql = (monthsParam: string): string => `
                LEFT JOIN LATERAL (
                  SELECT json_agg(json_build_object('method', c.payment_method, 'amount', c.amount::text)
                                  ORDER BY c.payment_method) AS card_payouts_raw
                    FROM (SELECT d.payment_method, SUM(l.amount) AS amount
                            FROM payroll_1c_payout_lines l
                            JOIN payroll_1c_payout_documents d ON d.id = l.document_id
                           WHERE l.employee_id = page.employee_id
                             AND (${monthsParam}::date[] IS NULL OR d.period_month = ANY(${monthsParam}::date[]))
                           GROUP BY d.payment_method) c
                ) card ON TRUE`;
