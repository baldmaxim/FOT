/**
 * Столбцы «Зарплата → Расчёты» (решение пользователя 27.10.2026): состав зарплаты строки за выбранные месяцы.
 *
 * Расчёт ФОТ по закрытому табелю (getPayoutForEmployees) — «Начислено по табелю» (оклад по дням или доля бригады),
 * переработка, проезд, отпускные и больничные (суммы 1С в расчёте ФОТ, решение пользователя 30.10.2026),
 * проживание, доплаты (плановая + разовая), удержания «Справочника» и «Сумма» — к выплате
 * (начислено − удержано, то же число, что «Сумма» во вкладке «Табель → Зарплата»). Несколько месяцев — сумма
 * по месяцам. Неизвестная сумма в ноль не превращается: незакрытый месяц — open_months, закрытый с неполным
 * расчётом (почасовая ставка, нет условий или нормы, выработка бригады не введена) — incomplete. «Оклад» не
 * суммируется: ставка условий на последний день последнего месяца.
 *
 * С preliminary (решение пользователя 28.10.2026) незакрытый месяц считается предварительно по живому табелю
 * (getPreliminaryPayoutForEmployees): суммы входят в столбцы, месяц — в preliminary с датой, по которую взят табель;
 * в open_months остаются только месяцы, которые посчитать нечем (1-е число текущего месяца, будущий).
 *
 * Из 1С (там, где ФОТ сумму не считает) — перерасчёт (статья «Оплачено», SQL списка) и «Выплаты на карту» —
 * ведомости выплаты (миграция 328) по каждому способу выплаты 1С, как есть.
 */
import { performance } from 'node:perf_hooks';

import type { AuthenticatedRequest } from '../../types/index.js';
import {
  getPayoutForEmployees,
  getPreliminaryPayoutForEmployees,
  type IPayoutMetrics,
  type PayrollCalcWithPreliminary,
} from './payroll-calc.service.js';
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
export type CalcColumnsIssue =
  | 'hourly' | 'no_terms' | 'no_norm' | 'brigade_output' | 'brigade_no_hours' | 'brigade_error' | 'unknown_amount';

const CALC_ISSUES: ReadonlySet<PayrollCalcMissing> = new Set<PayrollCalcMissing>([
  'hourly', 'no_terms', 'no_norm', 'brigade_output', 'brigade_no_hours', 'brigade_error',
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
  /** Отпускные и больничные — суммы 1С, вошедшие в расчёт ФОТ. */
  vacation: string | null;
  sick_leave: string | null;
  housing: string | null;
  housing_kinds: HousingKind[];
  supplements: string | null;
  deductions: string | null;
  /**
   * К выплате: начислено − удержано за посчитанные месяцы, без НДФЛ; null — посчитанных месяцев нет или итог хоть
   * одного месяца неизвестен (сумму строки ФОТ не посчитал): частичная сумма за итог не выдаётся.
   */
  net: string | null;
  /** Месяцы с незакрытым табелем без суммы (YYYY-MM); месяц, где сотрудник не работал, сюда не входит. */
  open_months: string[];
  /** Месяцы, посчитанные предварительно (табель не закрыт): as_of — по какой день взят живой табель. */
  preliminary: Array<{ month: string; as_of: string }>;
  incomplete: Array<{ month: string; reasons: CalcColumnsIssue[] }>;
}

type CalcSumKey = 'timesheet' | 'overtime' | 'travel' | 'vacation' | 'sick_leave' | 'housing' | 'supplements';

const LINE_COLUMN: Record<PayrollCalcLineCode, CalcSumKey> = {
  contract: 'timesheet',
  brigade: 'timesheet',
  overtime: 'overtime',
  travel: 'travel',
  vacation: 'vacation',
  sick_leave: 'sick_leave',
  housing: 'housing',
  bonus: 'supplements',
  supplement: 'supplements',
};

const addCents = (sum: number | null, amount: string): number => (sum ?? 0) + toCents(amount);
const toAmount = (cents: number | null): string | null => (cents === null ? null : centsToAmount(cents));

/** Суммы ФОТ и полнота строки по месяцам (по возрастанию); undefined — сотрудника нет в расчёте месяца. */
export const sumCalcColumns = (
  byMonth: ReadonlyArray<readonly [string, PayrollCalcWithPreliminary | undefined]>,
): Omit<ICalcColumns, 'rate'> => {
  const sums: Record<CalcSumKey | 'deductions' | 'net', number | null> = {
    timesheet: null, overtime: null, travel: null, vacation: null, sick_leave: null, housing: null, supplements: null,
    deductions: null, net: null,
  };
  let overtimeDays = 0;
  let overtimeHours = 0;
  const housingKinds = new Set<HousingKind>();
  const openMonths: string[] = [];
  const preliminary: ICalcColumns['preliminary'] = [];
  const incomplete: ICalcColumns['incomplete'] = [];
  let netUnknown = false;

  for (const [month, calc] of byMonth) {
    if (!calc) continue;
    if (calc.state === 'not_closed') {
      if (calc.reason !== 'no_period') openMonths.push(month);
      continue;
    }
    if (calc.state === 'preliminary') preliminary.push({ month, as_of: calc.as_of });
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
    if (calc.net === null || reasons.has('unknown_amount')) netUnknown = true;
    else sums.net = addCents(sums.net, calc.net);
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
    vacation: toAmount(sums.vacation),
    sick_leave: toAmount(sums.sick_leave),
    housing: toAmount(sums.housing),
    housing_kinds: [...housingKinds],
    supplements: toAmount(sums.supplements),
    deductions: toAmount(sums.deductions),
    net: netUnknown ? null : toAmount(sums.net),
    open_months: openMonths,
    preliminary,
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
/** Время расчёта столбцов, мс: шаги getPayoutForEmployees, сложенные по месяцам (они идут по очереди), и всего. */
export interface ICalcColumnsTiming extends IPayoutMetrics {
  rateMs: number;
  totalMs: number;
}

export const emptyCalcColumnsTiming = (): ICalcColumnsTiming => ({
  basisMs: 0, brigades: 0, brigadesMs: 0, live: 0, liveMs: 0, restMs: 0, buildMs: 0, rateMs: 0, totalMs: 0,
});

/** Расчёт дольше — в лог, с шагами по месяцам: по нему видно, что ускорять дальше. */
const CALC_COLUMNS_LOG_THRESHOLD_MS = 2000;

const ms = (value: number): string => `${Math.round(value)} мс`;

export const formatPayoutMetrics = (month: string, people: number, metrics: IPayoutMetrics): string => (
  `${month}, ${people} чел.: основа ${ms(metrics.basisMs)}, бригады(${metrics.brigades}) ${ms(metrics.brigadesMs)}, `
  + `живой табель(${metrics.live}) ${ms(metrics.liveMs)}, `
  + `условия·доплаты·ставки·категории (вместе) ${ms(metrics.restMs)}, сборка ${ms(metrics.buildMs)}`
);

/**
 * Столбцы ФОТ строк порции за месяцы YYYY-MM; больше CALC_COLUMNS_MAX_MONTHS — пустая карта. timing — сюда
 * складывается время шагов (Server-Timing запроса); всего дольше CALC_COLUMNS_LOG_THRESHOLD_MS — строка в лог.
 * options.preliminary — незакрытый месяц предварительно по живому табелю (calc-columns с preliminary=1).
 */
export const getCalcColumns = async (
  employeeIds: readonly number[],
  months: readonly string[],
  req: AuthenticatedRequest,
  timing: ICalcColumnsTiming = emptyCalcColumnsTiming(),
  options: { preliminary?: boolean } = {},
): Promise<Map<number, ICalcColumns>> => {
  const result = new Map<number, ICalcColumns>();
  if (employeeIds.length === 0 || months.length === 0 || months.length > CALC_COLUMNS_MAX_MONTHS) return result;
  const started = performance.now();
  const sorted = [...new Set(months)].sort();
  // Месяцы — по очереди: расчёт порции сам идёт пачкой запросов, параллельно он занял бы пул.
  const calcs = new Map<string, Map<number, PayrollCalcWithPreliminary>>();
  const perMonth: string[] = [];
  const payouts = options.preliminary ? getPreliminaryPayoutForEmployees : getPayoutForEmployees;
  for (const month of sorted) {
    const metrics: IPayoutMetrics = { basisMs: 0, brigades: 0, brigadesMs: 0, live: 0, liveMs: 0, restMs: 0, buildMs: 0 };
    calcs.set(month, await payouts(employeeIds, month, req, metrics));
    perMonth.push(formatPayoutMetrics(month, employeeIds.length, metrics));
    timing.basisMs += metrics.basisMs;
    timing.brigades += metrics.brigades;
    timing.brigadesMs += metrics.brigadesMs;
    timing.live += metrics.live;
    timing.liveMs += metrics.liveMs;
    timing.restMs += metrics.restMs;
    timing.buildMs += metrics.buildMs;
  }
  const asOf = lastDayOfMonth(sorted[sorted.length - 1]);
  const rateStarted = performance.now();
  const terms = await getTermsForPeriod([...employeeIds], `${sorted[0]}-01`, asOf);
  timing.rateMs += performance.now() - rateStarted;
  for (const employeeId of employeeIds) {
    result.set(employeeId, {
      rate: pickRateAsOf(terms.get(employeeId) ?? [], asOf),
      ...sumCalcColumns(sorted.map(month => [month, calcs.get(month)?.get(employeeId)] as const)),
    });
  }
  timing.totalMs += performance.now() - started;
  if (timing.totalMs > CALC_COLUMNS_LOG_THRESHOLD_MS) {
    console.log(`[payroll-calc] ${perMonth.join('; ')}; оклад ${ms(timing.rateMs)}; всего ${ms(timing.totalMs)}`);
  }
  return result;
};

/** Server-Timing: шаги, сложенные по месяцам (условия·доплаты·ставки·категории — вместе, они параллельны). */
export const calcColumnsServerTiming = (timing: ICalcColumnsTiming): string => [
  `calc_basis;dur=${timing.basisMs.toFixed(1)}`,
  `calc_brigades;dur=${timing.brigadesMs.toFixed(1)};desc="${timing.brigades}"`,
  `calc_live;dur=${timing.liveMs.toFixed(1)};desc="${timing.live}"`,
  `calc_extras;dur=${timing.restMs.toFixed(1)}`,
  `calc_build;dur=${(timing.buildMs + timing.rateMs).toFixed(1)}`,
  `calc_total;dur=${timing.totalMs.toFixed(1)}`,
].join(', ');

/** «Выплаты на карту» строки: сумма ведомостей по исходному «Способу выплаты» 1С, NUMERIC текстом. */
export interface ICardPayoutByMethod {
  method: string;
  amount: string;
}

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
