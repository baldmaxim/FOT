/**
 * «К выплате (ФОТ)» за месяц пачкой сотрудников по закрытому табелю (основа расчёта, миграция 331; правила —
 * payroll-calc.rules.ts). Незакрытый месяц (подача открыта, не утверждена, половина не подана, уволенный в месяце
 * увольнения) у getPayoutForEmployees — not_closed: суммы нет. Экраны «Зарплаты» (карточка и листок, «Расчёты»,
 * отделы во вкладке «Табель → Зарплата») зовут getPreliminaryPayoutForEmployees: незакрытый месяц там считается по
 * живому табелю (payroll-calc-preliminary.service), без пометки на экране; getPayoutForEmployees остаётся для
 * старого фронта (запрос без preliminary=1).
 *
 * Отделы — оклад по дням. Бригады — доля «Выработки» по КТУ из зафиксированного расчёта бригады
 * (brigade-salary.service, вкладка «Табель → Зарплата»); бригада не зафиксирована — месяц не закрыт. Начальник
 * участка в делёж не входит — его дни идут в оклад.
 *
 * Один вызов на отдел: карточка «Зарплаты» (листок) и вкладка «Табель → Зарплата» (столбец «Сумма») получают одно
 * и то же число. Условия, доплаты, ставки и удержания — из их истории с датами действия; категория для проезда —
 * по объектам тех же закрытых редакций, из которых взяты дни.
 */
import { performance } from 'node:perf_hooks';

import { query } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { buildFiredCutoffMap } from '../timesheet-fired-cutoff.service.js';
import { emptyAbsenceDays, type PayrollAbsenceDays, type PayrollBasisQuality } from './payroll-basis.service.js';
import { resolvePreliminaryAsOf, type IBrigadeShares } from './brigade-salary.service.js';
import { loadFixedBrigadeShares, loadPreliminaryBrigadeShares } from './payroll-calc-brigades.service.js';
import { loadLiveMonthBases } from './payroll-calc-preliminary.service.js';
import {
  brigadeShareFacts,
  buildPayrollCalc,
  type IBrigadeShareFact,
  type ICalcTermsRow,
  type IPayrollCalcDeduction,
  type IOvertimeStopPeriod,
  type IPayrollCalcResult,
  type IPlannedSupplementPeriod,
} from './payroll-calc.rules.js';
import { attributeMonths, loadMonthBreakdown, monthPairKey } from './payroll-month-attribution.service.js';
import {
  assembleMonthBasis,
  loadMonthBasisSources,
  type ICalcMonthBasis,
  type IClosedMonthBasis,
  type MonthBasisNotClosedReason,
} from './payroll-month-basis.service.js';
import {
  lastDayOfMonth,
  payslipPeriod,
  pickPayslipRateAllowances,
  type IPayslipRateAllowance,
  type IPayslipWorkedDays,
} from './payroll-payslip.rules.js';
import { loadRateFacts, type RateFactsRow } from './payroll-rate-facts.service.js';
import { resolveMonthStaffCategories } from './payroll-staff-category.js';
import { PLANNED_SUPPLEMENT_PERIODS_SQL } from './payroll-supplements.service.js';
import { getTermsForPeriod, type IPayrollTerms, type StaffCategory } from './payroll-terms.service.js';

/** Расчёт месяца с суммой: строки и то, из чего они посчитаны. */
interface IPayrollCalcDetails extends IPayrollCalcResult {
  norm_days: number | null;
  period_from: string;
  period_to: string;
  worked_days: IPayslipWorkedDays;
  absences: PayrollAbsenceDays;
  /** «По ставкам ФОТ» листка — те же проезд и проживание, что в строках. */
  rate_allowances: IPayslipRateAllowance[];
  /** Условия, задевающие период, — листку (строка оклада). */
  terms: IPayrollTerms[];
}

export interface IPayrollCalcClosed extends IPayrollCalcDetails {
  state: 'closed';
  /** reconstructed — основа дозаполнена по графикам на дату дозаполнения, а не на дату закрытия. */
  quality: PayrollBasisQuality;
  basis_ids: number[];
  version_ids: number[];
}

/** Предварительно («Расчёты»): табель месяца или расчёт бригады не закрыт — по живому табелю на as_of. */
export interface IPayrollCalcPreliminary extends IPayrollCalcDetails {
  state: 'preliminary';
  /** По какой день взят живой табель: прошлый месяц — последний день, текущий — вчера МСК. */
  as_of: string;
}

export interface IPayrollCalcNotClosed {
  state: 'not_closed';
  /** no_period — сотрудник в месяце не работал; brigade_open — расчёт его бригады за месяц не зафиксирован. */
  reason: MonthBasisNotClosedReason | 'no_period' | 'brigade_open';
}

export type PayrollCalc = IPayrollCalcClosed | IPayrollCalcNotClosed;

export type PayrollCalcWithPreliminary = PayrollCalc | IPayrollCalcPreliminary;

/**
 * Время шагов расчёта, мс (монотонный таймер) — для замера «Расчётов». rest — условия, доплаты, удержания, ставки и
 * категории: они идут в Promise.all, перекрываются и в сумму шагов по отдельности не раскладываются.
 */
export interface IPayoutMetrics {
  basisMs: number;
  brigades: number;
  brigadesMs: number;
  /** Предварительный расчёт: сколько сотрудников прочитано из живого табеля и за сколько. */
  live: number;
  liveMs: number;
  restMs: number;
  buildMs: number;
}

interface IEmployeeRow {
  id: number;
  hire_date: string | null;
  org_department_id: string | null;
  employment_status: string | null;
  dismissal_date: string | null;
  excluded_from_timesheet_date: string | null;
}

/** Сотрудники и их период в месяце: с приёма по отсечку увольнения; не работал в месяце — периода нет. */
const loadEmployeePeriods = async (
  employeeIds: readonly number[],
  month: string,
): Promise<{ employees: Map<number, IEmployeeRow>; periods: Map<number, { from: string; to: string }> }> => {
  const employeeRows = await query<IEmployeeRow>(
    `SELECT id, to_char(hire_date, 'YYYY-MM-DD') AS hire_date, org_department_id::text AS org_department_id,
            employment_status, to_char(dismissal_date, 'YYYY-MM-DD') AS dismissal_date,
            to_char(excluded_from_timesheet_date, 'YYYY-MM-DD') AS excluded_from_timesheet_date
       FROM employees WHERE id = ANY($1::int[])`,
    [[...employeeIds]],
  );
  const employees = new Map((employeeRows ?? []).map(row => [Number(row.id), row]));
  // Отсечка увольнения — та же формула, что у табеля (день увольнения включительно — рабочий).
  const cutoffs = buildFiredCutoffMap([...employees.values()].map(row => ({ ...row })), `${month}-01`);
  const periods = new Map<number, { from: string; to: string }>();
  for (const employee of employees.values()) {
    const period = payslipPeriod(month, employee.hire_date, cutoffs.get(employee.id) ?? null);
    if (period) periods.set(employee.id, period);
  }
  return { employees, periods };
};

/**
 * Категория месяца — как в «Своде» и листке. versionIds — объект только из этих закрытых редакций основы; без них
 * (предварительный расчёт) — из последних сохранённых редакций месяца, как в «Своде», нет их — по режиму и отделу.
 */
const loadMonthCategories = async (
  month: string,
  ids: readonly number[],
  versionIds: readonly number[] | undefined,
  employees: ReadonlyMap<number, IEmployeeRow>,
): Promise<Map<number, StaffCategory>> => {
  if (ids.length === 0) return new Map();
  const breakdown = await loadMonthBreakdown([`${month}-01`], [...ids], versionIds);
  const pairs = ids.map(employeeId => ({ employeeId, month }));
  const attributions = await attributeMonths(pairs, breakdown, new Map(ids.map(id => [id, {
    org_department_id: employees.get(id)?.org_department_id ?? null,
    employment_status: employees.get(id)?.employment_status ?? null,
  }])));
  const categories = await resolveMonthStaffCategories(ids.map(employeeId => {
    const attribution = attributions.get(monthPairKey(employeeId, month));
    return {
      employeeId,
      monthStart: `${month}-01`,
      officeObject: attribution?.object.key === 'office',
      departmentId: attribution?.departmentId ?? null,
      mode: attribution?.mode,
    };
  }));
  return new Map(ids.map((id, index) => [id, categories[index] ?? 'office']));
};

const groupBy = <T extends { employee_id: number }>(rows: readonly T[] | undefined): Map<number, T[]> => {
  const result = new Map<number, T[]>();
  for (const row of rows ?? []) {
    const id = Number(row.employee_id);
    const list = result.get(id);
    if (list) list.push(row);
    else result.set(id, [row]);
  }
  return result;
};

/** То, что не зависит от дней табеля: разовые доплаты, удержания, проживание и «Без переработки» месяца. */
interface IPayoutExtras {
  oneTime: Map<number, string>;
  deductions: Map<number, IPayrollCalcDeduction[]>;
  rateFacts: Map<number, RateFactsRow>;
  overtimeStops: Map<number, IOvertimeStopPeriod[]>;
}

/** Разовые доплаты, удержания, факты ставок и «Без переработки» месяца — одно правило для карточки и вкладки табеля. */
const loadPayoutExtras = async (
  ids: readonly number[],
  month: string,
  periods: ReadonlyMap<number, { from: string; to: string }>,
): Promise<IPayoutExtras> => {
  const monthStart = `${month}-01`;
  const [oneTime, deductions, rateFacts, overtimeStops] = await Promise.all([
    query<{ employee_id: number; amount: string }>(
      `SELECT employee_id, SUM(amount)::text AS amount
         FROM payroll_one_time_supplements
        WHERE employee_id = ANY($1::int[]) AND month = $2::date
        GROUP BY employee_id`,
      [[...ids], monthStart],
    ),
    query<IPayrollCalcDeduction & { employee_id: number }>(
      `SELECT d.employee_id, d.kind_id, k.name AS kind, SUM(d.amount)::text AS amount
         FROM staff_deductions d
         JOIN payroll_deduction_kinds k ON k.id = d.kind_id
        WHERE d.employee_id = ANY($1::int[]) AND d.month = $2::date
        GROUP BY d.employee_id, d.kind_id, k.name
        ORDER BY k.name, d.kind_id`,
      [[...ids], monthStart],
    ),
    loadRateFacts(
      ids.filter(id => periods.has(id)).map(employeeId => ({ employeeId, period: periods.get(employeeId)! })),
      month,
      lastDayOfMonth(month),
    ),
    query<IOvertimeStopPeriod & { employee_id: number }>(
      `SELECT employee_id, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to
         FROM payroll_overtime_stops
        WHERE employee_id = ANY($1::int[])
          AND date_from <= $3::date
          AND (date_to IS NULL OR date_to >= $2::date)`,
      [[...ids], monthStart, lastDayOfMonth(month)],
    ),
  ]);
  return {
    oneTime: new Map((oneTime ?? []).map(row => [Number(row.employee_id), row.amount])),
    deductions: new Map([...groupBy(deductions)].map(([id, rows]) => [
      id,
      rows.map(({ kind_id, kind, amount }) => ({ kind_id: Number(kind_id), kind, amount })),
    ])),
    rateFacts,
    overtimeStops: new Map([...groupBy(overtimeStops)].map(([id, rows]) => [
      id,
      rows.map(({ date_from, date_to }) => ({ date_from, date_to })),
    ])),
  };
};

/** Факты долей бригады по сотрудникам: те же строки расчёта, выработка и веса — для расшифровки доли. */
const shareFactsOf = (departmentId: string, shares: IBrigadeShares): Map<number, IBrigadeShareFact> => (
  brigadeShareFacts(departmentId, shares.distribution ?? 'error', shares.output_amount, shares.rows)
);

/** Основа сотрудника месяца: закрытая (closed) или из живого табеля (closed — null). */
interface ICalcEntry {
  basis: ICalcMonthBasis;
  closed: IClosedMonthBasis | null;
}

/**
 * Расчёт месяца. preliminary — режим «Расчётов»: незакрытый месяц по живому табелю на asOf, открытая бригада —
 * предварительной долей. Без него — только закрытый табель (карточка, листок, вкладка табеля).
 */
const computePayouts = async (
  employeeIds: readonly number[],
  month: string,
  req: AuthenticatedRequest,
  metrics: IPayoutMetrics | undefined,
  preliminary: boolean,
): Promise<Map<number, PayrollCalcWithPreliminary>> => {
  const result = new Map<number, PayrollCalcWithPreliminary>();
  if (employeeIds.length === 0) return result;
  const monthStart = `${month}-01`;
  const monthEnd = lastDayOfMonth(month);
  let mark = performance.now();
  const lap = (key: Exclude<keyof IPayoutMetrics, 'brigades' | 'live'>): void => {
    const now = performance.now();
    if (metrics) metrics[key] += now - mark;
    mark = now;
  };

  const { employees, periods } = await loadEmployeePeriods(employeeIds, month);
  for (const id of employees.keys()) {
    if (!periods.has(id)) result.set(id, { state: 'not_closed', reason: 'no_period' });
  }

  const sources = await loadMonthBasisSources([...periods.keys()], month);
  const entries = new Map<number, ICalcEntry>();
  // Предварительно — по какой день живой табель; null — считать нечего (1-е число текущего месяца, будущий месяц).
  const asOf = preliminary ? resolvePreliminaryAsOf(month) : null;
  const liveIds: number[] = [];
  for (const [employeeId, period] of periods) {
    const basis = assembleMonthBasis(sources.get(employeeId) ?? [], period);
    if (basis.state === 'closed') entries.set(employeeId, { basis, closed: basis });
    else if (asOf === null) result.set(employeeId, { state: 'not_closed', reason: basis.reason });
    // Принят позже asOf — по табелю ещё не работал.
    else if (period.from > asOf) result.set(employeeId, { state: 'not_closed', reason: 'no_period' });
    else liveIds.push(employeeId);
  }

  lap('basisMs');

  // Доли бригад — по одному расчёту на бригаду, не больше трёх одновременно. Бригада не зафиксирована (и не посчитана
  // предварительно) — месяц её людей не закрыт.
  const brigadeIds = [...new Set([...entries.values()].flatMap(entry => entry.basis.brigades.map(item => item.departmentId)))];
  const brigades = asOf === null
    ? await loadFixedBrigadeShares(req, month, brigadeIds)
    : await loadPreliminaryBrigadeShares(req, month, asOf, brigadeIds, liveIds);
  if (metrics) metrics.brigades += brigades.shares.size;
  lap('brigadesMs');

  if (asOf !== null && liveIds.length > 0) {
    const live = await loadLiveMonthBases(liveIds, periods, month, asOf, brigades.contexts);
    for (const [employeeId, basis] of live.bases) entries.set(employeeId, { basis, closed: null });
    if (metrics) metrics.live += live.fetched;
  }
  lap('liveMs');

  const counted = (departmentId: string): boolean => (
    brigades.shares.get(departmentId)?.state === 'fixed' || brigades.preliminary.has(departmentId)
  );
  for (const [employeeId, entry] of [...entries]) {
    if (entry.basis.brigades.some(item => !counted(item.departmentId))) {
      entries.delete(employeeId);
      result.set(employeeId, { state: 'not_closed', reason: 'brigade_open' });
    }
  }
  const ids = [...entries.keys()];
  if (ids.length === 0) return result;

  const closedEntries = ids.flatMap(id => (entries.get(id)!.closed ? [entries.get(id)!.closed!] : []));
  const closedIds = ids.filter(id => entries.get(id)!.closed !== null);
  const [termsByEmployee, planned, extras, closedCategories, liveCategories] = await Promise.all([
    getTermsForPeriod(ids, monthStart, monthEnd),
    query<IPlannedSupplementPeriod & { employee_id: number }>(
      `SELECT p.employee_id, p.amount::text AS amount,
              to_char(p.date_from, 'YYYY-MM-DD') AS date_from, to_char(p.date_to, 'YYYY-MM-DD') AS date_to
         FROM (${PLANNED_SUPPLEMENT_PERIODS_SQL}) p
        WHERE p.employee_id = ANY($1::int[])
          AND p.date_from <= $3::date
          AND (p.date_to IS NULL OR p.date_to >= $2::date)`,
      [ids, monthStart, monthEnd],
    ),
    loadPayoutExtras(ids, month, periods),
    loadMonthCategories(month, closedIds, [...new Set(closedEntries.flatMap(basis => basis.versionIds))], employees),
    loadMonthCategories(month, ids.filter(id => entries.get(id)!.closed === null), undefined, employees),
  ]);
  lap('restMs');
  const plannedByEmployee = groupBy(planned);
  const factsByBrigade = new Map<string, Map<number, IBrigadeShareFact>>();
  const brigadeFacts = (departmentId: string): Map<number, IBrigadeShareFact> => {
    let facts = factsByBrigade.get(departmentId);
    if (!facts) {
      facts = shareFactsOf(departmentId, brigades.shares.get(departmentId)!);
      factsByBrigade.set(departmentId, facts);
    }
    return facts;
  };

  for (const employeeId of ids) {
    const { basis, closed } = entries.get(employeeId)!;
    const period = periods.get(employeeId)!;
    const terms = termsByEmployee.get(employeeId) ?? [];
    const facts = extras.rateFacts.get(employeeId);
    const worked = basis.workdayDates.length + basis.dayoffDates.length;
    const rateAllowances = facts
      ? pickPayslipRateAllowances({
        ...facts,
        category: closedCategories.get(employeeId) ?? liveCategories.get(employeeId) ?? 'office',
        travelDays: { worked, norm: basis.normDays ?? 0 },
      })
      : [];
    // Дни бригад, где сотрудник делит выработку, оплачивает доля; начальник участка (его нет в строках) — оклад.
    const shares: IBrigadeShareFact[] = [];
    const brigadeDates = new Set<string>();
    for (const brigade of basis.brigades) {
      const fact = brigadeFacts(brigade.departmentId).get(employeeId);
      if (!fact) continue;
      shares.push(fact);
      for (const date of [...brigade.workdayDates, ...brigade.dayoffDates]) brigadeDates.add(date);
    }
    const calc = buildPayrollCalc({
      monthStart,
      monthEnd,
      normDays: basis.normDays,
      workdayDates: basis.workdayDates.filter(date => !brigadeDates.has(date)),
      dayoffDates: basis.dayoffDates.filter(date => !brigadeDates.has(date)),
      normMinutes: basis.normMinutes,
      overtimeMinutes: Object.fromEntries(
        Object.entries(basis.overtimeMinutes).filter(([date]) => !brigadeDates.has(date)),
      ),
      overtimeStops: extras.overtimeStops.get(employeeId) ?? [],
      absenceDays: basis.absenceDays,
      // NUMERIC приходит строкой; String() — на случай числа из моков и старых драйверов.
      terms: terms.map((row): ICalcTermsRow => ({
        effective_from: row.effective_from,
        effective_to: row.effective_to,
        calc_type: row.calc_type,
        monthly_salary: row.monthly_salary === null ? null : String(row.monthly_salary),
        bonus_amount: row.bonus_amount === null ? null : String(row.bonus_amount),
        proration_rounding: row.proration_rounding ?? 'ruble',
      })),
      plannedSupplements: (plannedByEmployee.get(employeeId) ?? []).map(({ amount, date_from, date_to }) => ({
        amount, date_from, date_to,
      })),
      oneTimeTotal: extras.oneTime.get(employeeId) ?? null,
      rateAllowances,
      deductions: extras.deductions.get(employeeId) ?? [],
      brigadeShares: shares,
    });
    const details: IPayrollCalcDetails = {
      norm_days: basis.normDays,
      period_from: period.from,
      period_to: period.to,
      worked_days: { workday: basis.workdayDates.length, dayoff: basis.dayoffDates.length },
      absences: basis.absenceDays,
      rate_allowances: rateAllowances,
      terms,
      ...calc,
    };
    // Живой табель или предварительная доля бригады — предварительно; иначе — закрытый расчёт, как всегда.
    const preliminaryAsOf = !closed || basis.brigades.some(item => brigades.preliminary.has(item.departmentId)) ? asOf : null;
    if (preliminaryAsOf !== null) {
      result.set(employeeId, { state: 'preliminary', as_of: preliminaryAsOf, ...details });
    } else if (closed) {
      result.set(employeeId, {
        state: 'closed',
        quality: closed.quality,
        basis_ids: closed.basisIds,
        version_ids: closed.versionIds,
        ...details,
      });
    }
  }
  lap('buildMs');
  return result;
};

/** «К выплате (ФОТ)» сотрудников за месяц YYYY-MM по закрытому табелю. Сотрудника нет в БД — его нет и в ответе. */
export const getPayoutForEmployees = async (
  employeeIds: readonly number[],
  month: string,
  req: AuthenticatedRequest,
  metrics?: IPayoutMetrics,
): Promise<Map<number, PayrollCalc>> => {
  const result = new Map<number, PayrollCalc>();
  for (const [employeeId, calc] of await computePayouts(employeeIds, month, req, metrics, false)) {
    // Без режима «Расчётов» предварительных нет; страховка — суммы нет, как у незакрытого месяца.
    result.set(employeeId, calc.state === 'preliminary' ? { state: 'not_closed', reason: 'not_covered' } : calc);
  }
  return result;
};

/**
 * «Расчёты» и отдел во вкладке «Табель → Зарплата»: как getPayoutForEmployees, но незакрытый месяц — предварительно
 * по живому табелю на asOf (прошлый месяц — целиком, текущий — по вчера МСК), открытая бригада — предварительной
 * долей (payroll-calc-preliminary).
 */
export const getPreliminaryPayoutForEmployees = (
  employeeIds: readonly number[],
  month: string,
  req: AuthenticatedRequest,
  metrics?: IPayoutMetrics,
): Promise<Map<number, PayrollCalcWithPreliminary>> => computePayouts(employeeIds, month, req, metrics, true);

/**
 * «Сумма» бригады во вкладке табеля из доли (зафиксированной или предварительной): доля + разовые доплаты и
 * проживание − удержания месяца — те же строки, что в «К выплате (ФОТ)» карточки рабочего. Проезда «Рабочим» нет,
 * плановых доплат у рабочих бригад нет — день табеля здесь не нужен.
 */
export const previewBrigadePayouts = async (
  shares: ReadonlyMap<number, IBrigadeShareFact>,
  month: string,
): Promise<Map<number, IPayrollCalcResult>> => {
  const result = new Map<number, IPayrollCalcResult>();
  const ids = [...shares.keys()];
  if (ids.length === 0) return result;
  const { periods } = await loadEmployeePeriods(ids, month);
  const extras = await loadPayoutExtras(ids, month, periods);
  for (const employeeId of ids) {
    const facts = extras.rateFacts.get(employeeId);
    result.set(employeeId, buildPayrollCalc({
      monthStart: `${month}-01`,
      monthEnd: lastDayOfMonth(month),
      normDays: null,
      workdayDates: [],
      dayoffDates: [],
      absenceDays: emptyAbsenceDays(),
      terms: [],
      plannedSupplements: [],
      oneTimeTotal: extras.oneTime.get(employeeId) ?? null,
      rateAllowances: facts ? pickPayslipRateAllowances({ ...facts, category: 'worker', travelDays: null }) : [],
      deductions: extras.deductions.get(employeeId) ?? [],
      brigadeShares: [shares.get(employeeId)!],
    }));
  }
  return result;
};
