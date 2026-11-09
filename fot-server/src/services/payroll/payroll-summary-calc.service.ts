/**
 * «Свод»: кого считать и что загружено помимо «Оплачено» — состав месяца, разовые доплаты, удержания «Справочника» и
 * расчёт ФОТ. Сведение сумм — payroll-summary-calc.rules.ts. В БД ничего не пишет, кроме того, что делает сам расчёт
 * («Расчёты» так же): открытие месяца фиксирует доли бригады закрытого месяца.
 */
import { query } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { getPreliminaryPayoutForEmployees, type PayrollCalcWithPreliminary } from './payroll-calc.service.js';
import { monthPairKey } from './payroll-month-attribution.service.js';
import { lastDayOfMonth } from './payroll-payslip.rules.js';
import {
  payrollContractorDeptsCte,
  payrollWorkedInMonthsSql,
  resolvePayrollArchiveDepartmentId,
} from './payroll-registry-scope.service.js';
import { SUMMARY_PAYROLL_ITEM } from './payroll-summary-calc.rules.js';

/** Порция расчёта — как у «Расчётов» (≤ 500 id): иначе один запрос держит слишком большой массив сотрудников. */
const CALC_CHUNK_SIZE = 500;

export interface ISummaryExtras {
  /** Разовые доплаты пары «сотрудник|YYYY-MM». */
  oneTime: Map<string, Array<{ reason: string; amount: string }>>;
  /** Удержания «Справочника» пары «сотрудник|YYYY-MM». */
  deductions: Map<string, Array<{ kind: string; amount: string }>>;
}

const pushTo = <T,>(target: Map<string, T[]>, key: string, value: T): void => {
  const list = target.get(key);
  if (list) list.push(value);
  else target.set(key, [value]);
};

/**
 * Кто работал в месяце — то же условие, что у списка «Расчётов» (payrollWorkedInMonthsSql), без подрядчиков: по отделу
 * карточки и по отделу, из которого уволен. Охват пользователя проверяет filterScope «Свода», он один на все суммы.
 * employeeIds — только среди них («Выплачено» «Условий оплаты» — порция списка); null — все.
 */
const loadWorkedInMonth = async (
  month: string,
  contractorRootId: string | null,
  archiveId: string | null,
  employeeIds: readonly number[] | null,
): Promise<number[]> => {
  const rows = await query<{ id: number }>(
    `WITH ${payrollContractorDeptsCte('$3')}
     SELECT e.id
       FROM employees e
      WHERE e.is_archived IS NOT TRUE
        AND ($4::int[] IS NULL OR e.id = ANY($4::int[]))
        AND ${payrollWorkedInMonthsSql('e.id', '$1', '$2')}
        AND NOT EXISTS (SELECT 1 FROM contractor_depts c WHERE c.id = e.org_department_id)
        AND NOT EXISTS (SELECT 1
                          FROM employee_dismissal_events de
                          JOIN contractor_depts c ON c.id = de.from_department_id
                         WHERE de.employee_id = e.id AND de.cancelled = false)`,
    [[`${month}-01`], archiveId, contractorRootId, employeeIds === null ? null : [...employeeIds]],
  );
  return rows.map(row => Number(row.id));
};

/** Состав месяцев: месяц YYYY-MM → кто в нём работал; employeeIds — только среди них, null — все. */
export const loadSummaryRoster = async (
  months: readonly string[],
  contractorRootId: string | null,
  employeeIds: readonly number[] | null = null,
): Promise<Map<string, number[]>> => {
  const archiveId = await resolvePayrollArchiveDepartmentId();
  const result = new Map<string, number[]>();
  // По очереди: условие тяжёлое, на всех сотрудниках.
  for (const month of months) {
    result.set(month, await loadWorkedInMonth(month, contractorRootId, archiveId, employeeIds));
  }
  return result;
};

/** Разовые доплаты и удержания месяцев: одна запись на основание или вид; employeeIds — только их, null — все. */
export const loadSummaryExtras = async (
  months: readonly string[],
  employeeIds: readonly number[] | null = null,
): Promise<ISummaryExtras> => {
  const extras: ISummaryExtras = { oneTime: new Map(), deductions: new Map() };
  if (months.length === 0) return extras;
  const monthStarts = months.map(month => `${month}-01`);
  const ids = employeeIds === null ? null : [...employeeIds];
  const [oneTime, deductions] = await Promise.all([
    query<{ employee_id: number; month: string; reason: string; amount: string }>(
      `SELECT s.employee_id, to_char(s.month, 'YYYY-MM') AS month, btrim(s.reason) AS reason, SUM(s.amount)::text AS amount
         FROM payroll_one_time_supplements s
        WHERE s.month = ANY($1::date[])
          AND ($2::int[] IS NULL OR s.employee_id = ANY($2::int[]))
        GROUP BY s.employee_id, s.month, btrim(s.reason)`,
      [monthStarts, ids],
    ),
    query<{ employee_id: number; month: string; kind: string; amount: string }>(
      `SELECT d.employee_id, to_char(d.month, 'YYYY-MM') AS month, k.name AS kind, SUM(d.amount)::text AS amount
         FROM staff_deductions d
         JOIN payroll_deduction_kinds k ON k.id = d.kind_id
        WHERE d.month = ANY($1::date[])
          AND ($2::int[] IS NULL OR d.employee_id = ANY($2::int[]))
        GROUP BY d.employee_id, d.month, k.name`,
      [monthStarts, ids],
    ),
  ]);
  for (const { employee_id, month, reason, amount } of oneTime) {
    pushTo(extras.oneTime, monthPairKey(Number(employee_id), month), { reason, amount });
  }
  for (const { employee_id, month, kind, amount } of deductions) {
    pushTo(extras.deductions, monthPairKey(Number(employee_id), month), { kind, amount });
  }
  return extras;
};

/**
 * Кого из ids считать в месяце, где ведомость уже загружена: людей с условиями оплаты и участников бригад, по которым
 * ведомости нет ни у кого (рабочего оплачивает доля выработки, условий у него нет). Ведомость отделов не должна снимать
 * с расчёта бригады: обновляется только загруженное. Членство — те же три источника, что у loadBrigadeCandidates.
 * Остальным считать нечем, а прошлые месяцы иначе получили бы сотни строк «Не посчитано».
 */
const selectCalcInLoadedMonth = async (ids: readonly number[], month: string): Promise<number[]> => {
  if (ids.length === 0) return [];
  const rows = await query<{ id: number }>(
    `WITH brigade_members AS (
       SELECT a.employee_id, a.org_department_id AS brigade_id
         FROM employee_assignments a
         JOIN org_departments d ON d.id = a.org_department_id AND d.kind = 'brigade'
        WHERE a.effective_from <= $3::date
          AND (a.effective_to IS NULL OR a.effective_to >= $2::date)
       UNION
       SELECT e.id, e.org_department_id
         FROM employees e
         JOIN org_departments d ON d.id = e.org_department_id AND d.kind = 'brigade'
       UNION
       SELECT de.employee_id, de.from_department_id
         FROM employee_dismissal_events de
         JOIN org_departments d ON d.id = de.from_department_id AND d.kind = 'brigade'
        WHERE de.cancelled = false AND de.dismissal_date >= $2::date
     ),
     loaded_brigades AS (
       SELECT DISTINCT m.brigade_id
         FROM brigade_members m
         JOIN payroll_paid_amounts p ON p.employee_id = m.employee_id AND p.month = $2::date AND p.item_code = $4
     )
     SELECT c.id
       FROM unnest($1::int[]) AS c(id)
      WHERE EXISTS (SELECT 1 FROM payroll_compensation_terms t
                     WHERE t.employee_id = c.id
                       AND t.effective_from <= $3::date
                       AND (t.effective_to IS NULL OR t.effective_to >= $2::date))
         OR EXISTS (SELECT 1 FROM brigade_members m
                     WHERE m.employee_id = c.id
                       AND NOT EXISTS (SELECT 1 FROM loaded_brigades l WHERE l.brigade_id = m.brigade_id))`,
    [[...ids], `${month}-01`, lastDayOfMonth(month), SUMMARY_PAYROLL_ITEM],
  );
  return rows.map(row => Number(row.id));
};

/**
 * Расчёт ФОТ по месяцам. candidates — месяц → у кого нет зарплаты 1С (needsSummaryCalc). В месяце, где ведомость уже
 * загружена (payrollLoadedMonths), — только selectCalcInLoadedMonth. Месяцы — по очереди: расчёт порции сам идёт пачкой
 * запросов.
 */
export const calcSummaryMonths = async (
  candidates: ReadonlyMap<string, readonly number[]>,
  payrollLoadedMonths: ReadonlySet<string>,
  req: AuthenticatedRequest,
): Promise<{ calcs: Map<string, PayrollCalcWithPreliminary>; employees: number }> => {
  const calcs = new Map<string, PayrollCalcWithPreliminary>();
  let employees = 0;
  for (const [month, monthIds] of candidates) {
    const ids = payrollLoadedMonths.has(month) ? await selectCalcInLoadedMonth(monthIds, month) : [...monthIds];
    employees += ids.length;
    for (let start = 0; start < ids.length; start += CALC_CHUNK_SIZE) {
      const payouts = await getPreliminaryPayoutForEmployees(ids.slice(start, start + CALC_CHUNK_SIZE), month, req);
      for (const [employeeId, calc] of payouts) calcs.set(monthPairKey(employeeId, month), calc);
    }
  }
  return { calcs, employees };
};
